"""Capture immutable visible Pi v3 history with durable branch-aware progress."""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, JsonValue, model_validator

from powercontext.sources.connectors import ConnectorRunCompletion, ConnectorRunSession, ConnectorRunStatus
from powercontext.sources.definitions import AdapterSourceDefinition, SourceDefinition
from powercontext.sources.models import Source, SourceMaterialization
from powercontext.sources.projections import TEXT_EVIDENCE_PROJECTION_KEY, TextEvidence


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _nonempty_string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Pi {field} must be a nonempty string")  # noqa: TRY003
    return value


class PiSessionInput(BaseModel):
    """A complete UTF-8 JSONL archive and an optional selected graph leaf."""

    content: bytes
    leaf_id: str | None = None


class PiEventInput(BaseModel):
    """One original visible event, including the complete unmodified record."""

    session_id: str
    event_id: str
    parent_id: str | None
    event_type: str
    role: str
    content: str
    record: dict[str, JsonValue]


def _read_archive(content: bytes) -> tuple[str, dict[str, dict[str, JsonValue]]]:
    try:
        records = [json.loads(line) for line in content.decode("utf-8-sig").split("\n") if line.strip()]
    except (UnicodeError, ValueError) as error:
        raise ValueError("Pi archive must contain valid UTF-8 JSONL") from error  # noqa: TRY003
    if not records or not isinstance(records[0], dict):
        raise ValueError("Pi archive must start with a session header")  # noqa: TRY003
    header = records[0]
    if header.get("type") != "session" or type(header.get("version")) is not int or header["version"] != 3:
        raise ValueError("Pi session version must be 3")  # noqa: TRY003
    session_id = _nonempty_string(header.get("id"), "session id")
    nodes: dict[str, dict[str, JsonValue]] = {}
    for record in records[1:]:
        if not isinstance(record, dict) or "parentId" not in record:
            raise ValueError("Pi nodes must include id and parentId")  # noqa: TRY003
        event_id = _nonempty_string(record.get("id"), "event id")
        _nonempty_string(record.get("type"), "event type")
        if event_id in nodes:
            raise ValueError("Duplicate Pi event id")  # noqa: TRY003
        parent = record["parentId"]
        if parent is not None and (not isinstance(parent, str) or (parent and parent not in nodes)):
            raise ValueError("Pi parent must be empty or an earlier node")  # noqa: TRY003
        # Canonicalization also rejects JSON's nonstandard NaN/Infinity values
        # before any item can be submitted or a checkpoint proposed.
        _canonical(record)
        nodes[event_id] = record
    return session_id, nodes


def _content_blocks(value: JsonValue, *, include_tools: bool) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    if not isinstance(value, list):
        raise ValueError("Pi content must be a string or block array")  # noqa: TRY003, TRY004 - archive contract
    parts: list[str] = []
    for block in value:
        if not isinstance(block, dict):
            raise ValueError("Pi content blocks must be objects")  # noqa: TRY003, TRY004 - archive contract
        if block.get("type") == "text":
            text = block.get("text")
            if not isinstance(text, str):
                raise ValueError("Pi text blocks must contain text")  # noqa: TRY003
            parts.append(text)
        elif include_tools and block.get("type") == "toolCall":
            name = _nonempty_string(block.get("name"), "tool name")
            call_id = _nonempty_string(block.get("id"), "tool call id")
            parts.append(f"[tool_call {name} {call_id}] {_canonical(block.get('arguments', {}))}")
    return "\n".join(parts)


def _message_body(message: JsonValue) -> tuple[str, str]:
    if not isinstance(message, dict):
        raise ValueError("Pi message event must contain a message object")  # noqa: TRY003, TRY004 - archive contract
    role = _nonempty_string(message.get("role"), "message role")
    body = _content_blocks(message.get("content"), include_tools=True)
    if role == "toolResult" and body:
        tool_name = _nonempty_string(message.get("toolName"), "tool result name")
        call_id = _nonempty_string(message.get("toolCallId"), "tool result call id")
        body = f"[tool_result {tool_name} {call_id}] {body}"
    elif role == "bashExecution":
        command, output = message.get("command", ""), message.get("output", "")
        if not isinstance(command, str) or not isinstance(output, str):
            raise ValueError("Pi bash command and output must be text")  # noqa: TRY003
        body = f"$ {command}\n{output}" if command or output else ""
    return role, body


def _visible_event(session_id: str, record: dict[str, JsonValue]) -> PiEventInput | None:
    event_type = str(record["type"])
    if event_type == "message":
        role, body = _message_body(record.get("message"))
    elif event_type in {"compaction", "branch_summary"}:
        role = event_type
        body = record.get("summary", "")
        if not isinstance(body, str):
            raise ValueError("Pi summaries must be text")  # noqa: TRY003
    elif event_type == "custom_message":
        role = "custom"
        body = _content_blocks(record.get("content"), include_tools=False)
    else:
        return None
    if not body:
        return None
    return PiEventInput(
        session_id=session_id,
        event_id=str(record["id"]),
        parent_id=record["parentId"],
        event_type=event_type,
        role=role,
        content=f"{role}: {body}",
        record=record,
    )


def _selected_events(
    session_id: str, nodes: dict[str, dict[str, JsonValue]], leaf_id: str | None
) -> tuple[PiEventInput, ...]:
    leaf = next(reversed(nodes), None) if leaf_id is None else leaf_id
    if leaf is not None and leaf not in nodes:
        raise ValueError("Selected Pi leaf does not exist")  # noqa: TRY003
    chain: list[dict[str, JsonValue]] = []
    while leaf:
        record = nodes[leaf]
        chain.append(record)
        # Parents were validated against earlier nodes, which rules out cycles.
        parent = record["parentId"]
        leaf = parent if isinstance(parent, str) else None
    return tuple(event for record in reversed(chain) if (event := _visible_event(session_id, record)) is not None)


def parse_pi_session(value: PiSessionInput) -> tuple[PiEventInput, ...]:
    """Validate the whole graph before projecting the chosen ancestral path."""

    session_id, nodes = _read_archive(value.content)
    return _selected_events(session_id, nodes, value.leaf_id)


def _event_identity(session_id: str, event_id: str) -> str:
    return "pi:" + hashlib.sha256(_canonical([session_id, event_id]).encode("utf-8")).hexdigest()


class PiEventSource(Source):
    """Captured immutable event; large tool results remain complete here."""

    materialization: Literal[SourceMaterialization.CAPTURED] = SourceMaterialization.CAPTURED
    event: PiEventInput

    @model_validator(mode="after")
    def validate_identity(self) -> PiEventSource:
        if self.name != _event_identity(self.event.session_id, self.event.event_id):
            raise ValueError("Pi Source name must match its immutable event identity")  # noqa: TRY003
        return self


class _PiEventAdapter:
    input_class = PiEventInput
    name = "pi-event"
    source_class = PiEventSource

    async def resolve(self, value: PiEventInput, /) -> PiEventSource:
        return PiEventSource(name=_event_identity(value.session_id, value.event_id), event=value.model_copy(deep=True))

    async def read(self, source: PiEventSource, /) -> PiEventInput:
        return source.event.model_copy(deep=True)


class _PiEventTextEvidenceProjection:
    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = PiEventSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: PiEventSource, /) -> TextEvidence:
        event = source.event
        return TextEvidence(
            source_type="pi-event",
            source_id=source.name,
            content=event.content,
            metadata=event.model_dump(include={"session_id", "event_id", "parent_id", "event_type", "role"}),
        )


PI_EVENT_SOURCE_DEFINITION: SourceDefinition[PiEventInput, PiEventSource, PiEventInput] = AdapterSourceDefinition(
    _PiEventAdapter(), projections=(_PiEventTextEvidenceProjection(),)
)


class _PiCheckpoint(BaseModel):
    version: Literal[1] = 1
    session_id: str
    events: dict[str, str]


class PiSessionConnector:
    """Import only unseen selected events; let ConnectorLifecycle commit progress."""

    name = "pi-session-history"
    version = "1"
    source_definitions = frozenset({"pi-event"})

    def __init__(self, path: str | Path, leaf_id: str | None = None) -> None:
        self.path = Path(path)
        self.leaf_id = leaf_id

    async def run(self, session: ConnectorRunSession, /) -> ConnectorRunCompletion:
        content = await asyncio.to_thread(self.path.read_bytes)
        session_id, nodes = _read_archive(content)
        events = _selected_events(session_id, nodes, self.leaf_id)
        previous = (
            _PiCheckpoint(session_id=session_id, events={})
            if session.checkpoint is None
            else _PiCheckpoint.model_validate(session.checkpoint)
        )
        if previous.session_id != session_id:
            raise ValueError("Pi session changed beneath a persisted checkpoint")  # noqa: TRY003
        # Check every previously imported event, even if it is now on a sibling
        # branch. Complete validation precedes the first ingestion side effect.
        for event_id, digest in previous.events.items():
            record = nodes.get(event_id)
            if record is None or hashlib.sha256(_canonical(record).encode("utf-8")).hexdigest() != digest:
                raise ValueError("Previously imported Pi event was removed or rewritten")  # noqa: TRY003
        imported = dict(previous.events)
        for event in events:
            if event.event_id in imported:
                continue
            await session.submit(_event_identity(session_id, event.event_id), "pi-event", event)
            imported[event.event_id] = hashlib.sha256(_canonical(event.record).encode("utf-8")).hexdigest()
        checkpoint = _PiCheckpoint(session_id=session_id, events=imported).model_dump(mode="json")
        return ConnectorRunCompletion(status=ConnectorRunStatus.COMPLETE, checkpoint=checkpoint)


__all__ = [
    "PI_EVENT_SOURCE_DEFINITION",
    "PiEventInput",
    "PiEventSource",
    "PiSessionConnector",
    "PiSessionInput",
    "parse_pi_session",
]
