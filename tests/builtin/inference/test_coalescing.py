# Copyright (c) 2026 OceanBase.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Embedding sharing and failure isolation observable at the provider boundary."""

import asyncio

import pytest

from powercontext.builtin.artifacts.memory import EmbeddingProfile
from powercontext.builtin.inference import EmbeddingResult, InferenceUsage
from powercontext.builtin.inference.coalescing import CoalescingEmbeddingModel


class Embedding:
    profile = EmbeddingProfile(profile_id="coalescing-regression", model="offline", dimension=1)

    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    async def embed(self, texts: tuple[str, ...], /) -> EmbeddingResult:
        self.calls.append(texts)
        return EmbeddingResult(
            vectors=tuple((float(len(text)),) for text in texts),
            usage=InferenceUsage(requests=3, input_tokens=7, output_tokens=0),
        )


def test_late_caller_shares_running_work_even_when_cache_is_disabled() -> None:
    async def scenario() -> None:
        class Blocked(Embedding):
            async def embed(self, texts: tuple[str, ...], /) -> EmbeddingResult:
                started.set()
                await release.wait()
                return await super().embed(texts)

        started, release = asyncio.Event(), asyncio.Event()
        base = Blocked()
        model = CoalescingEmbeddingModel(base, coalesce_ms=0, cache_size=0)
        first = asyncio.create_task(model.embed(("shared",)))
        await started.wait()
        late = asyncio.create_task(model.embed(("shared", "shared")))
        # Run the late caller while the provider is still blocked.
        await asyncio.sleep(0)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        release.set()
        result = await asyncio.wait_for(late, timeout=2)
        assert result.vectors == ((6.0,), (6.0,))
        assert result.usage == InferenceUsage(requests=3, input_tokens=7, output_tokens=0)
        assert base.calls == [("shared",)]
        await model.embed(("shared",))
        assert base.calls == [("shared",), ("shared",)]

    asyncio.run(scenario())


def test_failed_batch_leaves_independent_results_available_and_can_retry() -> None:
    async def scenario() -> None:
        class Flaky(Embedding):
            async def embed(self, texts: tuple[str, ...], /) -> EmbeddingResult:
                if texts == ("bad",) and not failed.is_set():
                    self.calls.append(texts)
                    failed.set()
                    raise RuntimeError("provider unavailable")  # noqa: TRY003
                return await super().embed(texts)

        failed = asyncio.Event()
        base = Flaky()
        model = CoalescingEmbeddingModel(base, max_batch_size=1, coalesce_ms=0)
        dependent, independent = await asyncio.gather(
            model.embed(("bad", "good")), model.embed(("good",)), return_exceptions=True
        )
        assert isinstance(dependent, RuntimeError)
        assert isinstance(independent, EmbeddingResult)
        assert independent.vectors == ((4.0,),)
        retry = await model.embed(("bad", "good"))
        assert retry.vectors == ((3.0,), (4.0,))
        assert retry.usage == InferenceUsage(requests=3, input_tokens=7, output_tokens=0)
        assert base.calls.count(("good",)) == 1
        assert base.calls.count(("bad",)) == 2

    asyncio.run(scenario())


def test_each_waiter_counts_distinct_provider_batches_and_keeps_full_usage() -> None:
    async def scenario() -> None:
        base = Embedding()
        model = CoalescingEmbeddingModel(base, max_batch_size=2, coalesce_ms=0)
        first, second = await asyncio.gather(
            model.embed(("one", "two", "three", "one")), model.embed(("two", "three", "two"))
        )
        assert first.vectors == ((3.0,), (3.0,), (5.0,), (3.0,))
        assert second.vectors == ((3.0,), (5.0,), (3.0,))
        for result in (first, second):
            assert result.usage == InferenceUsage(requests=6, input_tokens=14, output_tokens=0)
        cached = await model.embed(("one", "three"))
        assert cached.vectors == ((3.0,), (5.0,))
        assert cached.usage.requests == 0
        assert len(base.calls) == 2

    asyncio.run(scenario())
