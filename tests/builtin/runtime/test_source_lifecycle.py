"""Lifecycle recovery must repair partially committed native Memory states."""

from __future__ import annotations

import pytest

from powercontext.builtin.artifacts.memory import MemoryEntryInput
from powercontext.builtin.artifacts.memory.service import MemoryService
from powercontext.builtin.persistence.sqlite import SQLiteConfig
from powercontext.builtin.runtime import BuiltinConfig, CaptureSource, RememberMemoryRequest, open_builtin_runtime
from powercontext.builtin.runtime.source_lifecycle import SourceLifecycleError, SourceLifecycleEvent
from powercontext.builtin.scope import ScopeDraft


async def _graph(runtime, name):
    scope = await runtime.scopes.create(ScopeDraft(title=name, summary="Recovery", idempotency_key=name))
    service = runtime.lifecycle.for_scope(scope.scope_id)
    source = await runtime.sources.for_scope(scope.scope_id).capture(
        CaptureSource(source_id="root", content="origin", metadata={})
    )
    await service.register_source("root", source.source_ref, revision=3)
    for index in range(2):
        result = await runtime.memory.for_scope(scope.scope_id).remember(
            RememberMemoryRequest(entries=(MemoryEntryInput(kind="fact", text=f"fact {index}"),))
        )
        await service.register_memory(str(index), result.entry.citation, parents=("root",))
    return scope.scope_id, service


@pytest.mark.asyncio
@pytest.mark.parametrize("restart", [False, True])
async def test_partial_native_write_can_be_replayed_or_recovered_at_restart(tmp_path, monkeypatch, restart):
    config = BuiltinConfig(database=SQLiteConfig(url=f"sqlite+aiosqlite:///{tmp_path / 'recovery.db'}"))
    event = SourceLifecycleEvent(node_id="root", revision=3, sequence=1, available=False, reason="withdrawn")
    original = MemoryService.forget
    attempts = 0

    async def fail_second(self, *args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            raise OSError("injected native state write failure")  # noqa: TRY003
        return await original(self, *args, **kwargs)

    async with open_builtin_runtime(config) as runtime:
        scope, service = await _graph(runtime, "recovery")
        monkeypatch.setattr(MemoryService, "forget", fail_second)
        with pytest.raises(OSError, match="native state"):
            await service.apply(event)
        page = await runtime.memory.for_scope(scope).list(include_inactive=True)
        assert {entry.state for entry in page.entries} == {"active", "inactive"}
        monkeypatch.setattr(MemoryService, "forget", original)
        if not restart:
            assert await service.apply(event) == []
            assert not (await runtime.memory.for_scope(scope).list()).entries
            before = (await runtime.memory.for_scope(scope).list()).memory_ref
            assert await service.apply(event) == []
            assert (await runtime.memory.for_scope(scope).list()).memory_ref == before
    async with open_builtin_runtime(config) as runtime:
        service = runtime.lifecycle.for_scope(scope)
        assert not (await runtime.memory.for_scope(scope).list()).entries
        before = (await runtime.memory.for_scope(scope).list()).memory_ref
        await service.apply(event)
        assert (await runtime.memory.for_scope(scope).list()).memory_ref == before
        restored = event.model_copy(update={"sequence": 2, "available": True})
        assert await service.apply(restored) == ["0", "1", "root"]
        assert len((await runtime.memory.for_scope(scope).list()).entries) == 2


@pytest.mark.asyncio
async def test_same_ids_are_isolated_and_registration_replay_preserves_withdrawal():
    async with open_builtin_runtime(BuiltinConfig()) as runtime:
        scope_a, a = await _graph(runtime, "a")
        scope_b, b = await _graph(runtime, "b")
        reference = await a.resolve("root", purpose="audit")
        event = SourceLifecycleEvent(node_id="root", revision=3, sequence=1, available=False, reason="withdrawn")
        await a.apply(event)
        await a.register_source("root", reference, revision=3)
        assert not (await runtime.memory.for_scope(scope_a).list()).entries
        assert len((await runtime.memory.for_scope(scope_b).list()).entries) == 2
        assert await b.resolve("root", purpose="generation") is not None
        with pytest.raises(SourceLifecycleError):
            await a.resolve("root", purpose="generation")
        with pytest.raises(SourceLifecycleError):
            await a.register_memory("alien", await b.resolve("0", purpose="audit"), parents=("root",))
