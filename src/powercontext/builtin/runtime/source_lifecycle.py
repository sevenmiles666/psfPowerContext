"""Persistent source dependency graphs and retryable native state propagation."""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import insert, select, update

from powercontext.artifacts import ArtifactRef, MemoryCitation
from powercontext.builtin.persistence.artifact_governance import ArtifactGovernanceRepository, ArtifactLifecycleState
from powercontext.builtin.persistence.database import AsyncDatabase
from powercontext.builtin.persistence.tables import SOURCE_LIFECYCLE_TABLE
from powercontext.builtin.runtime.models import GetMemoryEntryRequest
from powercontext.builtin.sources.journal import validate_scope_id
from powercontext.sources import SourceRef

if TYPE_CHECKING:
    from powercontext.builtin.runtime.application import BuiltinRuntime


class SourceLifecycleError(ValueError):
    """Invalid dependency registration, event, or generation resolution."""


class SourceLifecycleEvent(BaseModel):
    """One strictly ordered availability event on an exact source generation."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    node_id: str = Field(min_length=1)
    revision: int = Field(gt=0)
    sequence: int = Field(gt=0)
    available: bool
    reason: str = Field(min_length=1)

    @field_validator("node_id", "reason")
    @classmethod
    def validate_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Lifecycle text must not be blank")  # noqa: TRY003
        return value


class _Node(BaseModel):
    kind: Literal["source", "memory", "topic"]
    reference: SourceRef | MemoryCitation | ArtifactRef
    parents: tuple[str, ...] = ()
    policy: Literal["all", "any"] = "all"
    revision: int = 1
    available: bool = True
    event: SourceLifecycleEvent | None = None


class _Graph(BaseModel):
    nodes: dict[str, _Node] = Field(default_factory=dict)
    pending: bool = False


class SourceLifecycleApplication:
    """Select a scope's durable graph, sharing Runtime's scope writer lock."""

    def __init__(self, runtime: BuiltinRuntime, database: AsyncDatabase | None) -> None:
        self.runtime = runtime
        self.database = database

    def for_scope(self, scope_id: str) -> ScopedSourceLifecycle:
        return ScopedSourceLifecycle(self, validate_scope_id(scope_id))

    async def recover_pending(self) -> None:
        if self.database is None:
            return
        async with self.database.transaction() as connection:
            scopes = (
                (
                    await connection.execute(
                        select(SOURCE_LIFECYCLE_TABLE.c.scope_id).where(SOURCE_LIFECYCLE_TABLE.c.pending.is_(True))
                    )
                )
                .scalars()
                .all()
            )
        for scope_id in scopes:
            service = self.for_scope(scope_id)
            async with self.runtime._context(scope_id), self.runtime._locked(scope_id):
                await service._reconcile(await service._load())


class ScopedSourceLifecycle:
    """One immutable dependency DAG; events change eligibility, never evidence."""

    def __init__(self, application: SourceLifecycleApplication, scope_id: str) -> None:
        self._application = application
        self._runtime = application.runtime
        self.scope_id = scope_id

    def _database(self) -> AsyncDatabase:
        database = self._application.database
        if database is None:
            raise SourceLifecycleError("Lifecycle persistence is not configured")  # noqa: TRY003
        return database

    async def _load(self) -> _Graph:
        async with self._database().transaction() as connection:
            value = (
                await connection.execute(
                    select(SOURCE_LIFECYCLE_TABLE.c.graph_json).where(
                        SOURCE_LIFECYCLE_TABLE.c.scope_id == self.scope_id
                    )
                )
            ).scalar_one_or_none()
        return _Graph() if value is None else _Graph.model_validate_json(value)

    async def _save(self, graph: _Graph) -> None:
        async with self._database().transaction() as connection:
            exists = (
                await connection.execute(
                    select(SOURCE_LIFECYCLE_TABLE.c.scope_id).where(SOURCE_LIFECYCLE_TABLE.c.scope_id == self.scope_id)
                )
            ).scalar_one_or_none()
            values = {"graph_json": graph.model_dump_json(), "pending": graph.pending}
            if exists is None:
                await connection.execute(insert(SOURCE_LIFECYCLE_TABLE).values(scope_id=self.scope_id, **values))
            else:
                await connection.execute(
                    update(SOURCE_LIFECYCLE_TABLE)
                    .where(SOURCE_LIFECYCLE_TABLE.c.scope_id == self.scope_id)
                    .values(**values)
                )

    async def register_source(self, node_id: str, source_ref: SourceRef, *, revision: int = 1) -> None:
        if not isinstance(source_ref, SourceRef) or type(revision) is not int or revision < 1:
            raise SourceLifecycleError("Source registration needs an exact reference and positive revision")  # noqa: TRY003
        await self._register(node_id, _Node(kind="source", reference=source_ref, revision=revision))

    async def register_memory(
        self, node_id: str, citation: MemoryCitation, *, parents: tuple[str, ...], policy: str = "all"
    ) -> None:
        if not isinstance(citation, MemoryCitation):
            raise SourceLifecycleError("Memory registration needs an exact citation")  # noqa: TRY003
        await self._register(node_id, self._derived("memory", citation, parents, policy))

    async def register_topic(
        self, node_id: str, artifact_ref: ArtifactRef, *, parents: tuple[str, ...], policy: str = "all"
    ) -> None:
        if not isinstance(artifact_ref, ArtifactRef) or artifact_ref.family != "topic-memory":
            raise SourceLifecycleError("Topic registration needs a Topic Memory reference")  # noqa: TRY003
        await self._register(node_id, self._derived("topic", artifact_ref, parents, policy))

    @staticmethod
    def _derived(
        kind: Literal["memory", "topic"], reference: MemoryCitation | ArtifactRef, parents: tuple[str, ...], policy: str
    ) -> _Node:
        if policy not in {"all", "any"} or not isinstance(parents, (tuple, list)) or not parents:
            raise SourceLifecycleError("Derived nodes need parents and an all/any policy")  # noqa: TRY003
        if any(not isinstance(parent, str) or not parent.strip() for parent in parents):
            raise SourceLifecycleError("Parent IDs must be nonblank strings")  # noqa: TRY003
        if len(set(parents)) != len(parents):
            raise SourceLifecycleError("Parent IDs must be distinct")  # noqa: TRY003
        return _Node(kind=kind, reference=reference, parents=tuple(parents), policy="all" if policy == "all" else "any")

    async def _register(self, node_id: str, node: _Node) -> None:
        if not isinstance(node_id, str) or not node_id.strip():
            raise SourceLifecycleError("Node ID must be a nonblank string")  # noqa: TRY003
        async with self._runtime._context(self.scope_id), self._runtime._locked(self.scope_id):
            graph = await self._load()
            previous = graph.nodes.get(node_id)
            if previous is not None:
                if previous.model_dump(exclude={"available", "event"}) != node.model_dump(
                    exclude={"available", "event"}
                ):
                    raise SourceLifecycleError("Node ID has a different binding")  # noqa: TRY003
                await self._reconcile(graph)
                return
            if node_id in node.parents or any(parent not in graph.nodes for parent in node.parents):
                raise SourceLifecycleError("Parents must already be registered; cycles are forbidden")  # noqa: TRY003
            await self._validate_reference(node)
            graph.nodes[node_id] = node
            self._propagate(graph)
            graph.pending = True
            await self._save(graph)
            await self._reconcile(graph)

    async def _validate_reference(self, node: _Node) -> None:
        try:
            reference = node.reference
            if isinstance(reference, SourceRef):
                await self._runtime.records.for_scope(self.scope_id).get_source(
                    reference.source_type, reference.source_id
                )
            elif isinstance(reference, MemoryCitation):
                await self._runtime.memory.for_scope(self.scope_id).get(GetMemoryEntryRequest(citation=reference))
            else:
                await self._runtime.records.for_scope(self.scope_id).get_artifact_revision(
                    reference.family, reference.artifact_id, reference.revision
                )
        except Exception as error:
            raise SourceLifecycleError("Registered reference must exist in this scope") from error  # noqa: TRY003

    @staticmethod
    def _propagate(graph: _Graph) -> None:
        # Parents must precede children, so insertion order is a topological order.
        for node in graph.nodes.values():
            if node.kind != "source":
                support = [graph.nodes[parent].available for parent in node.parents]
                node.available = all(support) if node.policy == "all" else any(support)

    async def apply(self, event: SourceLifecycleEvent) -> list[str]:
        if not isinstance(event, SourceLifecycleEvent):
            raise SourceLifecycleError("Expected a validated lifecycle event")  # noqa: TRY003
        async with self._runtime._context(self.scope_id), self._runtime._locked(self.scope_id):
            graph = await self._load()
            node = graph.nodes.get(event.node_id)
            if node is None or node.kind != "source" or node.revision != event.revision:
                raise SourceLifecycleError("Unknown Source or mismatched lifecycle revision")  # noqa: TRY003
            if node.event is not None and event.sequence <= node.event.sequence:
                if event != node.event:
                    raise SourceLifecycleError("Event sequence is stale or conflicts with a prior event")  # noqa: TRY003
            else:
                node.event = event
                node.available = event.available
                self._propagate(graph)
                graph.pending = True
                # Persist the desired graph before changing native records. A failed
                # native write leaves this intent available for replay or restart.
                await self._save(graph)
            await self._reconcile(graph)
            return sorted(key for key, value in graph.nodes.items() if value.available)

    async def _reconcile(self, graph: _Graph) -> None:
        if not graph.pending:
            return
        for node in graph.nodes.values():
            if node.kind == "memory":
                await self._set_memory_state(node)
            elif node.kind == "topic":
                await self._set_topic_state(node)
        graph.pending = False
        await self._save(graph)

    async def _set_memory_state(self, node: _Node) -> None:
        reference = node.reference
        if not isinstance(reference, MemoryCitation):
            raise SourceLifecycleError("Invalid stored Memory binding")  # noqa: TRY003
        async with self._runtime._context(self.scope_id) as context:
            service = context.artifacts.memory
            current = await service.head(reference.memory_ref.artifact_id)
            entry = next(
                (entry for entry in await service.entries(current) if entry.entry_id == reference.entry_id), None
            )
            if entry is None or entry.entry_version_id != reference.entry_version_id:
                raise SourceLifecycleError("Registered Memory body changed")  # noqa: TRY003
            state = next(item.state for item in current.content.manifest.entries if item.entry_id == entry.entry_id)
            if (state == "active") == node.available:
                return
            if node.available:
                await service.reactivate(current, entries=(entry,))
            else:
                await service.forget(current, entries=(entry,), reason="source lifecycle unavailable")

    async def _set_topic_state(self, node: _Node) -> None:
        reference = node.reference
        if not isinstance(reference, ArtifactRef):
            raise SourceLifecycleError("Invalid stored Topic binding")  # noqa: TRY003
        repository = ArtifactGovernanceRepository()
        desired = ArtifactLifecycleState.ACTIVE if node.available else ArtifactLifecycleState.DEPRECATED
        async with self._database().transaction() as connection:
            current = await repository.get(connection, self.scope_id, reference.family, reference.artifact_id)
            if current.lifecycle_state != desired:
                await repository.transition(
                    connection,
                    self.scope_id,
                    reference.family,
                    reference.artifact_id,
                    current.governance_generation,
                    desired,
                    None,
                )

    async def resolve(self, node_id: str, *, purpose: str) -> SourceRef | MemoryCitation | ArtifactRef:
        if purpose not in {"generation", "audit"}:
            raise SourceLifecycleError("Unknown lifecycle resolution purpose")  # noqa: TRY003
        async with self._runtime._context(self.scope_id), self._runtime._locked(self.scope_id):
            graph = await self._load()
            node = graph.nodes.get(node_id)
            if node is None or (purpose == "generation" and not node.available):
                raise SourceLifecycleError("Node is unknown or unavailable for generation")  # noqa: TRY003
            await self._reconcile(graph)
            return node.reference


__all__ = ["SourceLifecycleError", "SourceLifecycleEvent"]
