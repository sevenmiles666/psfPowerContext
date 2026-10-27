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

"""Share embedding work across callers on one event loop and cache successful vectors."""

from __future__ import annotations

import asyncio
import math
from collections import OrderedDict
from dataclasses import dataclass
from typing import TYPE_CHECKING

from powercontext.builtin.inference.models import EmbeddingResult, EmbeddingVector, InferenceUsage

if TYPE_CHECKING:
    from powercontext.builtin.inference.protocols import EmbeddingModel


@dataclass(frozen=True, eq=False, slots=True)
class _BatchUsage:
    # Identity distinguishes actual provider requests even when their usage values are equal.
    usage: InferenceUsage


@dataclass(frozen=True, slots=True)
class _EmbeddedText:
    vector: EmbeddingVector
    batch: _BatchUsage


def _observe_failure(future: asyncio.Future[_EmbeddedText]) -> None:
    # A caller can leave before its provider work fails; consume orphaned exceptions as well.
    if not future.cancelled():
        future.exception()


def _sum_tokens(values: list[int | None]) -> int | None:
    # An absent provider measurement makes the combined measurement unknown.
    if not values or any(value is None for value in values):
        return None
    return sum(value for value in values if value is not None)


class CoalescingEmbeddingModel:
    """Deduplicate queued and running texts, with a bounded LRU of successful vectors.

    Callers share this instance within one event loop. Each call reports the complete
    provider usage of every distinct batch it waits for, including shared batches.
    Cancelling a caller leaves provider work available to the other callers.
    """

    def __init__(
        self,
        model: EmbeddingModel,
        *,
        max_batch_size: int = 64,
        coalesce_ms: float = 5.0,
        cache_size: int = 1024,
    ) -> None:
        if type(max_batch_size) is not int or max_batch_size <= 0:
            raise ValueError("max_batch_size must be a positive integer")  # noqa: TRY003
        if type(cache_size) is not int or cache_size < 0:
            raise ValueError("cache_size must be a nonnegative integer")  # noqa: TRY003
        if (
            isinstance(coalesce_ms, bool)
            or not isinstance(coalesce_ms, (int, float))
            or not math.isfinite(coalesce_ms)
            or coalesce_ms < 0
        ):
            raise ValueError("coalesce_ms must be a finite nonnegative number")  # noqa: TRY003
        self.profile = model.profile
        self._model = model
        self._max_batch_size = max_batch_size
        self._coalesce_seconds = coalesce_ms / 1000
        self._cache_size = cache_size
        self._cache: OrderedDict[str, EmbeddingVector] = OrderedDict()
        self._inflight: dict[str, asyncio.Future[_EmbeddedText]] = {}
        self._pending: dict[str, asyncio.Future[_EmbeddedText]] = {}
        self._dispatch_task: asyncio.Task[None] | None = None
        self._batches: set[asyncio.Task[None]] = set()

    async def embed(self, texts: tuple[str, ...], /) -> EmbeddingResult:
        """Return vectors in original order and attribute shared batch usage once."""
        vectors: dict[str, EmbeddingVector] = {}
        waiting: dict[str, asyncio.Future[_EmbeddedText]] = {}
        loop = asyncio.get_running_loop()
        # Registration does not await: concurrent calls see the same authoritative future.
        for text in dict.fromkeys(texts):
            if text in self._cache:
                vectors[text] = self._cache[text]
                self._cache.move_to_end(text)
                continue
            future = self._inflight.get(text)
            if future is None:
                future = loop.create_future()
                future.add_done_callback(_observe_failure)
                self._inflight[text] = future
                self._pending[text] = future
            waiting[text] = future

        if self._pending and self._dispatch_task is None:
            self._dispatch_task = asyncio.create_task(self._dispatch())

        results = await asyncio.gather(*(asyncio.shield(future) for future in waiting.values()))
        batches: dict[_BatchUsage, None] = {}
        for text, result in zip(waiting, results, strict=True):
            vectors[text] = result.vector
            batches[result.batch] = None
        usage = [batch.usage for batch in batches]
        return EmbeddingResult(
            vectors=tuple(vectors[text] for text in texts),
            usage=InferenceUsage(
                requests=sum(value.requests for value in usage),
                input_tokens=_sum_tokens([value.input_tokens for value in usage]),
                output_tokens=_sum_tokens([value.output_tokens for value in usage]),
            ),
        )

    async def _dispatch(self) -> None:
        await asyncio.sleep(self._coalesce_seconds)
        pending = tuple(self._pending.items())
        self._pending.clear()
        self._dispatch_task = None
        for start in range(0, len(pending), self._max_batch_size):
            batch = pending[start : start + self._max_batch_size]
            task = asyncio.create_task(self._embed_batch(batch))
            self._batches.add(task)
            task.add_done_callback(self._batches.discard)

    async def _embed_batch(self, batch: tuple[tuple[str, asyncio.Future[_EmbeddedText]], ...]) -> None:
        try:
            result = await self._model.embed(tuple(text for text, _ in batch))
            if len(result.vectors) != len(batch):
                raise ValueError("embedding vector count does not match the requested text count")  # noqa: TRY003, TRY301
        except asyncio.CancelledError:
            for _, future in batch:
                future.cancel()
            raise
        except Exception as error:
            for _, future in batch:
                future.set_exception(error)
        else:
            usage = _BatchUsage(result.usage)
            for (text, future), vector in zip(batch, result.vectors, strict=True):
                self._cache_vector(text, vector)
                future.set_result(_EmbeddedText(vector=vector, batch=usage))
        finally:
            for text, future in batch:
                if self._inflight.get(text) is future:
                    del self._inflight[text]

    def _cache_vector(self, text: str, vector: EmbeddingVector) -> None:
        if not self._cache_size:
            return
        self._cache[text] = vector
        self._cache.move_to_end(text)
        while len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)


__all__ = ["CoalescingEmbeddingModel"]
