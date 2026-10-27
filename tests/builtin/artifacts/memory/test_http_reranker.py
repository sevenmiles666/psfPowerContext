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

"""Adversarial protocol types, cross-batch identities, and caller ownership."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from powercontext.artifacts import ArtifactRef
from powercontext.builtin.artifacts.memory.http_reranker import HTTPMemoryReranker
from powercontext.builtin.artifacts.memory.models import MemoryHit


def _hits(count: int) -> tuple[MemoryHit, ...]:
    return tuple(
        MemoryHit(
            memory_ref=ArtifactRef(family="memory", artifact_id="m", revision=1),
            entry_id=f"e{rank}",
            entry_version_id=f"v{rank}",
            text=f"evidence {rank}",
            score=1.0 / rank,
            matched_by=("fts",),
        )
        for rank in range(1, count + 1)
    )


def test_global_selection_handles_reversed_responses_and_keeps_client_reusable() -> None:
    requests: list[dict[str, Any]] = []
    scores = {1: -2, 2: 0.5, 3: 0.5, 4: -1, 5: 0.75, 6: 0.5, 7: 0.75, 8: 1}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        return httpx.Response(
            200,
            json={
                "scores": [
                    {"rank": item["rank"], "score": scores[item["rank"]]} for item in reversed(body["candidates"])
                ]
            },
        )

    async def scenario() -> None:
        candidates = _hits(8)
        original = tuple(hit.model_dump() for hit in candidates)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            reranker = HTTPMemoryReranker(
                "https://reranker.invalid/score", client=client, batch_size=3, policy_id="test"
            )
            first = await reranker.rerank("q", candidates, 6)
            assert first.selected_ranks == (8, 5, 7, 2, 3, 6)
            assert first.usage.requests == 3
            assert len(requests) == 3
            assert [len(body["candidates"]) for body in requests] == [3, 3, 2]
            assert [item for body in requests for item in body["candidates"]] == [
                {"rank": rank, "text": hit.text} for rank, hit in enumerate(candidates, start=1)
            ]
            second = await reranker.rerank("q", candidates, 1)
            assert second.selected_ranks == (8,)
            assert second.usage.requests == 3
            assert len(requests) == 6
            assert reranker.policy_id == "test"
            assert not client.is_closed
        assert tuple(hit.model_dump() for hit in candidates) == original

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "payload",
    [
        {"scores": [{"rank": True, "score": 1}]},
        {"scores": [{"rank": 1.0, "score": 1}]},
        {"scores": [{"rank": "1", "score": 1}]},
        {"scores": [{"rank": 1, "score": True}]},
        {"scores": [{"rank": 1, "score": "0.5"}]},
        {"scores": [{"rank": 1, "score": None}]},
        {"scores": [{"rank": 1, "score": float("-inf")}]},
        {"scores": {"rank": 1, "score": 0.5}},
        {"scores": None},
        [],
        None,
    ],
)
def test_response_values_are_validated_without_coercion(payload: object) -> None:
    async def scenario() -> None:
        transport = httpx.MockTransport(lambda _request: httpx.Response(200, content=json.dumps(payload).encode()))
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(ValueError):
                await HTTPMemoryReranker("https://invalid", client=client).rerank("q", _hits(1), 1)

    asyncio.run(scenario())


def test_later_batch_cannot_return_an_earlier_global_rank() -> None:
    seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        rank = json.loads(request.content)["candidates"][0]["rank"]
        seen.append(rank)
        return httpx.Response(200, json={"scores": [{"rank": 1, "score": 0.8}]})

    async def scenario() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(ValueError):
                await HTTPMemoryReranker("https://invalid", client=client, batch_size=1).rerank("q", _hits(2), 1)
        assert seen == [1, 2]

    asyncio.run(scenario())


@pytest.mark.parametrize("status", [302, 400, 429, 500])
def test_non_success_status_preserves_the_http_exception(status: int) -> None:
    async def scenario() -> None:
        transport = httpx.MockTransport(lambda _request: httpx.Response(status, text="service error"))
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(httpx.HTTPStatusError) as failure:
                await HTTPMemoryReranker("https://invalid", client=client).rerank("q", _hits(1), 1)
        assert failure.value.response.status_code == status

    asyncio.run(scenario())


def test_invalid_json_is_a_value_error() -> None:
    async def scenario() -> None:
        transport = httpx.MockTransport(lambda _request: httpx.Response(200, content=b"{broken"))
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(ValueError):
                await HTTPMemoryReranker("https://invalid", client=client).rerank("q", _hits(1), 1)

    asyncio.run(scenario())


@pytest.mark.parametrize("value", [True, False, 1.0, "1", 0, -1])
def test_invalid_limits_and_batch_sizes_fail_before_sending(value: Any) -> None:
    def unexpected_request(_request: httpx.Request) -> httpx.Response:
        pytest.fail("invalid bounds must not send HTTP requests")

    async def scenario() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(unexpected_request)) as client:
            with pytest.raises(ValueError):
                HTTPMemoryReranker("https://invalid", client=client, batch_size=value)
            with pytest.raises(ValueError):
                await HTTPMemoryReranker("https://invalid", client=client).rerank("q", _hits(1), value)

    asyncio.run(scenario())
