"""Checkpoint ordering and immutable branch history through the public lifecycle."""

from __future__ import annotations

import json

import pytest

from powercontext.sources import ConnectorBinding, SourceDefinitionRegistry, SourceRef
from powercontext.sources.connectors import ConnectorLifecycle
from powercontext.sources.pi_session import PI_EVENT_SOURCE_DEFINITION, PiSessionConnector
from tests.test_connectors import MemoryCheckpointStore


def _write(path, records):
    header = {"type": "session", "version": 3, "id": "checkpoints"}
    path.write_text("\n".join(json.dumps(row) for row in [header, *records]), encoding="utf-8")


def _message(event_id, parent, text):
    return {"type": "message", "id": event_id, "parentId": parent, "message": {"role": "user", "content": text}}


class _DurableSink:
    def __init__(self):
        self.registry = SourceDefinitionRegistry((PI_EVENT_SOURCE_DEFINITION,))
        self.sources = {}
        self.reject_event = None
        self.submissions = []

    async def submit(self, binding, item_id, definition_name, value, /):
        self.submissions.append(value.event_id)
        if value.event_id == self.reject_event:
            raise OSError("injected storage failure")  # noqa: TRY003 - fault injection
        source = await self.registry.resolve(value)
        if item_id in self.sources:
            assert self.sources[item_id] == source
        self.sources[item_id] = source
        return SourceRef(source_type=definition_name, source_id=source.name)


@pytest.mark.asyncio
async def test_partial_ingestion_failure_retains_checkpoint_and_replays_safely(tmp_path):
    path = tmp_path / "session.jsonl"
    _write(path, [_message("a", None, "first"), _message("b", "a", "second")])
    binding = ConnectorBinding(
        scope_id="scope", binding_id="pi", connector_name="pi-session-history", connector_version="1"
    )
    sink = _DurableSink()
    checkpoints = MemoryCheckpointStore([])
    lifecycle = ConnectorLifecycle(sink=sink, checkpoints=checkpoints)
    sink.reject_event = "b"
    with pytest.raises(OSError, match="storage failure"):
        await lifecycle.run(PiSessionConnector(path), binding)
    assert await checkpoints.load(binding) is None
    assert len(sink.sources) == 1
    sink.reject_event = None
    result = await lifecycle.run(PiSessionConnector(path), binding)
    assert result.committed_checkpoint is not None
    assert len(sink.sources) == 2
    assert sink.submissions == ["a", "b", "a", "b"]
    replay = await lifecycle.run(PiSessionConnector(path), binding)
    assert replay.items == ()
    assert replay.committed_checkpoint == result.committed_checkpoint


@pytest.mark.asyncio
async def test_rewrite_on_previously_imported_sibling_fails_before_any_new_submission(tmp_path):
    path = tmp_path / "branches.jsonl"
    records = [_message("root", None, "shared"), _message("left", "root", "left"), _message("right", "root", "right")]
    _write(path, records)
    binding = ConnectorBinding(
        scope_id="scope", binding_id="pi", connector_name="pi-session-history", connector_version="1"
    )
    sink = _DurableSink()
    checkpoints = MemoryCheckpointStore([])
    lifecycle = ConnectorLifecycle(sink=sink, checkpoints=checkpoints)
    first = await lifecycle.run(PiSessionConnector(path, "left"), binding)
    records[1]["message"]["content"] = "rewritten sibling"
    _write(path, records)
    with pytest.raises(ValueError, match="rewritten"):
        await lifecycle.run(PiSessionConnector(path, "right"), binding)
    assert sink.submissions == ["root", "left"]
    assert await checkpoints.load(binding) == first.committed_checkpoint
