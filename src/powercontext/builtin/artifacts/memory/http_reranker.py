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

"""HTTP scoring with bounded requests and a global, identity-preserving selection."""

from __future__ import annotations

import httpx
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat

from powercontext.builtin.artifacts.memory.models import MemoryHit
from powercontext.builtin.artifacts.memory.reranking import MemoryRerankDecision
from powercontext.builtin.inference import InferenceUsage


class _Score(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    rank: int = Field(ge=1)
    score: FiniteFloat


class _ScoreResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    scores: list[_Score]


class HTTPMemoryReranker:
    """Use service scores to select original ranks from the complete candidate pool.

    The caller owns the client and its timeout, authentication, and transport.
    HTTP failures propagate without retries or a replacement ranking.
    """

    def __init__(
        self,
        endpoint: str,
        *,
        client: httpx.AsyncClient,
        batch_size: int = 32,
        policy_id: str = "http-cross-encoder-v1",
    ) -> None:
        if type(batch_size) is not int or batch_size < 1:
            raise ValueError("batch_size must be a positive integer")  # noqa: TRY003
        self._endpoint = endpoint
        self._client = client
        self._batch_size = batch_size
        self.policy_id = policy_id

    async def rerank(
        self,
        query: str,
        candidates: tuple[MemoryHit, ...],
        limit: int,
        /,
    ) -> MemoryRerankDecision:
        """Score every candidate once, then order by descending score and rank."""

        if not candidates:
            raise ValueError("rerank requires at least one candidate")  # noqa: TRY003
        if type(limit) is not int or not 1 <= limit <= len(candidates):
            raise ValueError("limit must be an integer between one and the candidate count")  # noqa: TRY003

        scored: list[_Score] = []
        requests = 0
        for offset in range(0, len(candidates), self._batch_size):
            batch = candidates[offset : offset + self._batch_size]
            response = await self._client.post(
                self._endpoint,
                json={
                    "query": query,
                    "candidates": [
                        {"rank": rank, "text": candidate.text} for rank, candidate in enumerate(batch, start=offset + 1)
                    ],
                },
            )
            requests += 1
            response.raise_for_status()
            payload = _ScoreResponse.model_validate(response.json())
            expected_ranks = set(range(offset + 1, offset + len(batch) + 1))
            actual_ranks = {item.rank for item in payload.scores}
            if len(payload.scores) != len(batch) or actual_ranks != expected_ranks:
                raise ValueError("response scores must cover each rank in the request exactly once")  # noqa: TRY003
            scored.extend(payload.scores)

        scored.sort(key=lambda item: (-item.score, item.rank))
        return MemoryRerankDecision(
            selected_ranks=tuple(item.rank for item in scored[:limit]),
            usage=InferenceUsage(requests=requests),
        )


__all__ = ["HTTPMemoryReranker"]
