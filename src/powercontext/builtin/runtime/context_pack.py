"""Canonical context packets and independently verifiable prefix deltas."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any

_PACK_SCHEMA = "powercontext.context-pack.v1"
_DELTA_SCHEMA = "powercontext.context-pack-delta.v1"
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")


class ContextPackError(ValueError):
    """A packet, delta or requested UTF-8 boundary violates the protocol."""

    def __init__(self, *, detail: str) -> None:
        super().__init__(detail)


def _encode(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _unique_fields(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ContextPackError(detail=f"Duplicate packet field: {key}")
        result[key] = value
    return result


def _decode(data: bytes, schema: str, fields: set[str]) -> dict[str, Any]:
    try:
        payload = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_fields)
    except (UnicodeError, ValueError, AttributeError) as error:
        raise ContextPackError(detail="Invalid UTF-8 JSON packet") from error
    if not isinstance(payload, dict) or set(payload) != fields or payload["schema"] != schema:
        raise ContextPackError(detail="Unexpected packet schema or fields")
    return payload


def _encoded_items(items: tuple[bytes, ...]) -> list[str]:
    return [base64.b64encode(item).decode("ascii") for item in items]


def _decoded_items(value: object) -> tuple[bytes, ...]:
    if not isinstance(value, list):
        raise ContextPackError(detail="Packet chunks must be an array of Base64 strings")
    result: list[bytes] = []
    for item in value:
        if not isinstance(item, str):
            raise ContextPackError(detail="Packet chunks must be an array of Base64 strings")
        try:
            decoded = base64.b64decode(item, validate=True)
        except (ValueError, binascii.Error) as error:
            raise ContextPackError(detail="Invalid Base64 chunk") from error
        if base64.b64encode(decoded).decode("ascii") != item:
            raise ContextPackError(detail="Noncanonical Base64 chunk")
        result.append(decoded)
    return tuple(result)


def _require_items(items: tuple[bytes, ...]) -> None:
    if not isinstance(items, tuple) or any(not isinstance(item, bytes) for item in items):
        raise ContextPackError(detail="Packet chunks must be a tuple of bytes")


def _require_digest(digest: str) -> None:
    if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None:
        raise ContextPackError(detail="Invalid SHA-256 digest")


@dataclass(frozen=True, slots=True)
class ContextPack:
    """Immutable chunks with a canonical digest and exact wire byte count."""

    items: tuple[bytes, ...]
    digest: str = field(init=False)
    byte_count: int = field(init=False)

    def __post_init__(self) -> None:
        _require_items(self.items)
        unsigned = {"schema": _PACK_SCHEMA, "items": _encoded_items(self.items)}
        digest = "sha256:" + hashlib.sha256(_encode(unsigned)).hexdigest()
        object.__setattr__(self, "digest", digest)
        # The decimal width of byte_count can change the packet length. Solve
        # this small fixed point, including the count field itself on the wire.
        count = 0
        while True:
            size = len(_encode({**unsigned, "digest": digest, "byte_count": count}))
            if size == count:
                break
            count = size
        object.__setattr__(self, "byte_count", count)

    @classmethod
    def build(cls, items: tuple[bytes, ...]) -> ContextPack:
        return cls(items)

    @classmethod
    def from_content(cls, content: str, *, chunk_bytes: int = 512) -> ContextPack:
        if type(chunk_bytes) is not int or chunk_bytes <= 0:
            raise ContextPackError(detail="chunk_bytes must be a positive integer")
        try:
            content_bytes = content.encode("utf-8")
        except (AttributeError, UnicodeError) as error:
            raise ContextPackError(detail="Content must be valid UTF-8 text") from error
        chunks: list[bytes] = []
        start = 0
        while start < len(content_bytes):
            end = min(start + chunk_bytes, len(content_bytes))
            # A boundary inside a multibyte code point is moved back to the
            # leading byte, leaving every independently decoded chunk valid.
            while end < len(content_bytes) and content_bytes[end] & 0xC0 == 0x80:
                end -= 1
            if end == start:
                raise ContextPackError(detail="chunk_bytes cannot accommodate a UTF-8 code point")
            chunks.append(content_bytes[start:end])
            start = end
        return cls.build(tuple(chunks))

    def to_bytes(self) -> bytes:
        return _encode({
            "schema": _PACK_SCHEMA,
            "items": _encoded_items(self.items),
            "digest": self.digest,
            "byte_count": self.byte_count,
        })

    @classmethod
    def from_bytes(cls, data: bytes) -> ContextPack:
        payload = _decode(data, _PACK_SCHEMA, {"schema", "items", "digest", "byte_count"})
        pack = cls.build(_decoded_items(payload["items"]))
        if payload["digest"] != pack.digest:
            raise ContextPackError(detail="Pack digest does not match its chunks")
        if type(payload["byte_count"]) is not int or payload["byte_count"] != pack.byte_count:
            raise ContextPackError(detail="Pack byte_count does not match its wire size")
        return pack


@dataclass(frozen=True, slots=True)
class ContextPackDelta:
    """A target suffix following a verified prefix of the recipient's base."""

    base_digest: str
    target_digest: str
    prefix_items: int
    appended: tuple[bytes, ...]

    def __post_init__(self) -> None:
        _require_digest(self.base_digest)
        _require_digest(self.target_digest)
        if type(self.prefix_items) is not int or self.prefix_items < 0:
            raise ContextPackError(detail="prefix_items must be a nonnegative integer")
        _require_items(self.appended)

    @classmethod
    def between(cls, base: ContextPack, target: ContextPack) -> ContextPackDelta:
        prefix = 0
        for before, after in zip(base.items, target.items, strict=False):
            if before != after:
                break
            prefix += 1
        return cls(base.digest, target.digest, prefix, target.items[prefix:])

    @property
    def byte_count(self) -> int:
        return len(self.to_bytes())

    def to_bytes(self) -> bytes:
        return _encode({
            "schema": _DELTA_SCHEMA,
            "base_digest": self.base_digest,
            "target_digest": self.target_digest,
            "prefix_items": self.prefix_items,
            "appended": _encoded_items(self.appended),
        })

    @classmethod
    def from_bytes(cls, data: bytes) -> ContextPackDelta:
        payload = _decode(data, _DELTA_SCHEMA, {"schema", "base_digest", "target_digest", "prefix_items", "appended"})
        return cls(
            payload["base_digest"],
            payload["target_digest"],
            payload["prefix_items"],
            _decoded_items(payload["appended"]),
        )


def apply_context_pack_delta(base: ContextPack, delta: ContextPackDelta) -> ContextPack:
    """Reconstruct and verify a target using only the base and received delta."""

    if base.digest != delta.base_digest:
        raise ContextPackError(detail="Delta base digest does not match the supplied pack")
    if delta.prefix_items > len(base.items):
        raise ContextPackError(detail="Delta prefix exceeds the base chunk count")
    target = ContextPack.build(base.items[: delta.prefix_items] + delta.appended)
    if target.digest != delta.target_digest:
        raise ContextPackError(detail="Delta target digest does not match the reconstructed pack")
    return target
