"""One seekdb statement for native FULLTEXT and HNSW candidate channels."""

from __future__ import annotations

from pyobvector import VECTOR
from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncConnection
from typing_extensions import override

from powercontext.builtin.artifacts.memory import (
    CapabilityNotSupportedError,
    EmbeddingProfile,
    MemorySearchChannels,
    MemorySearchRequest,
)
from powercontext.builtin.artifacts.memory.canonical import validate_embedding
from powercontext.builtin.persistence.memory_index import CompositeMemoryIndex, memory_channel_hits
from powercontext.builtin.persistence.oceanbase.memory_index import OceanBaseMemoryFTSIndex, OceanBaseMemoryVectorIndex
from powercontext.builtin.persistence.tags import memory_tag_parameters, memory_tag_sql

_HYBRID_SQL = """
WITH lexical AS (
    SELECT m.memory_artifact_id, m.head_revision, m.entry_id, m.entry_version_id,
           v.text, MATCH(m.searchable_text) AGAINST (:query) AS lexical_score
    FROM pc_memory_entry_heads AS m
    JOIN pc_memory_entry_versions AS v
      ON v.scope_id = m.scope_id
     AND v.memory_artifact_id = m.memory_artifact_id
     AND v.entry_version_id = m.entry_version_id
    WHERE m.scope_id = :scope_id
      AND m.memory_artifact_id IN :memory_artifact_ids
      AND MATCH(m.searchable_text) AGAINST (:query)
      {tag_filter}
    ORDER BY lexical_score DESC, m.memory_artifact_id, m.entry_id, m.entry_version_id
    LIMIT :candidate_limit
), semantic AS (
    SELECT m.memory_artifact_id, m.head_revision, m.entry_id, m.entry_version_id,
           v.text, l2_distance(m.embedding, :query_vector) AS distance
    FROM pc_memory_vector_entries AS m
    JOIN pc_memory_entry_versions AS v
      ON v.scope_id = m.scope_id
     AND v.memory_artifact_id = m.memory_artifact_id
     AND v.entry_version_id = m.entry_version_id
    WHERE m.scope_id = :scope_id
      AND m.memory_artifact_id IN :memory_artifact_ids
      {tag_filter}
    ORDER BY l2_distance(m.embedding, :query_vector) {approximate}
    LIMIT :candidate_limit
)
SELECT 'fts' AS channel, memory_artifact_id, head_revision, entry_id, entry_version_id,
       text, lexical_score, NULL AS distance FROM lexical
UNION ALL
SELECT 'vector' AS channel, memory_artifact_id, head_revision, entry_id, entry_version_id,
       text, NULL AS lexical_score, distance FROM semantic
"""


class SeekDBMemoryHybridIndex(CompositeMemoryIndex):
    """Preserve the existing channel fusion with one native candidate access."""

    def __init__(self, profile: EmbeddingProfile) -> None:
        self._vector = OceanBaseMemoryVectorIndex(profile)
        super().__init__(OceanBaseMemoryFTSIndex(), self._vector)
        self._hybrid_sql = self._statement(tagged=False)
        self._tagged_hybrid_sql = self._statement(tagged=True)

    def _statement(self, *, tagged: bool):
        statement = text(
            _HYBRID_SQL.format(
                tag_filter=memory_tag_sql("m") if tagged else "",
                approximate="" if tagged else "APPROXIMATE",
            )
        ).bindparams(
            bindparam("memory_artifact_ids", expanding=True),
            bindparam("query_vector", type_=VECTOR(self._vector.profile.dimension)),
        )
        if tagged:
            statement = statement.bindparams(
                bindparam("tag_keys", expanding=True), bindparam("tag_hashes", expanding=True)
            )
        return statement

    @override
    async def search(
        self, connection: AsyncConnection, scope_id: str, request: MemorySearchRequest, /
    ) -> MemorySearchChannels:
        if request.mode != "hybrid":
            return await super().search(connection, scope_id, request)
        if request.embedding_profile != self._vector.profile or request.query_vector is None:
            raise CapabilityNotSupportedError("embedding-profile")
        if not await self._vector.vector_complete(connection, scope_id, request.memories, self._vector.profile):
            raise CapabilityNotSupportedError("vector")
        rows = (
            (
                await connection.execute(
                    self._hybrid_sql if request.tag_filter is None else self._tagged_hybrid_sql,
                    {
                        "scope_id": scope_id,
                        "memory_artifact_ids": tuple(memory.artifact_id for memory in request.memories),
                        "query": request.analyzed_query,
                        "query_vector": validate_embedding(
                            request.query_vector, dimension=self._vector.profile.dimension
                        ),
                        "candidate_limit": request.candidate_limit,
                        **memory_tag_parameters(request.tag_filter),
                    },
                )
            )
            .mappings()
            .all()
        )
        # UNION does not promise inter-channel ordering. Reconstitute each
        # ordered channel using the DB's scores; distances stay DB-computed.
        lexical = sorted(
            (row for row in rows if row["channel"] == "fts"),
            key=lambda row: (
                -float(row["lexical_score"]),
                row["memory_artifact_id"],
                row["entry_id"],
                row["entry_version_id"],
            ),
        )
        semantic = sorted(
            (row for row in rows if row["channel"] == "vector"),
            key=lambda row: (
                float(row["distance"]),
                row["memory_artifact_id"],
                row["entry_id"],
                row["entry_version_id"],
            ),
        )
        return MemorySearchChannels(
            fts=memory_channel_hits(lexical, request.memories), vector=memory_channel_hits(semantic, request.memories)
        )
