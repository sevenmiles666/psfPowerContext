"""Protocol rejection and UTF-8 boundaries beyond ordinary round trips."""

from __future__ import annotations

import json

import pytest

from powercontext.builtin.runtime import BuiltinConfig, PrepareContextRequest, open_builtin_runtime
from powercontext.builtin.runtime.context_pack import (
    ContextPack,
    ContextPackDelta,
    ContextPackError,
    apply_context_pack_delta,
)
from powercontext.builtin.scope import ScopeDraft


@pytest.mark.parametrize("limit", [4, 5, 7, 16, 512])
def test_unicode_chunks_respect_the_cap_and_round_trip(limit):
    text = "海洋🌊e\u0301\n" * 137
    pack = ContextPack.from_content(text, chunk_bytes=limit)
    assert all(len(item) <= limit for item in pack.items)
    assert "".join(item.decode("utf-8") for item in pack.items) == text
    assert ContextPack.from_bytes(pack.to_bytes()) == pack
    assert pack.byte_count == len(pack.to_bytes())


@pytest.mark.parametrize(
    "fields",
    [
        {"extra": 1},
        {"byte_count": True},
        {"byte_count": 0},
        {"schema": "other"},
        {"items": ["***="]},
        {"items": ["YR=="]},  # Nonzero padding bits are not canonical Base64.
        {"items": [1]},
        {"items": "YQ=="},
    ],
)
def test_pack_rejects_malformed_fields(fields):
    payload = {**json.loads(ContextPack.build((b"a",)).to_bytes()), **fields}
    with pytest.raises(ContextPackError):
        ContextPack.from_bytes(json.dumps(payload).encode())


def test_wire_rejects_duplicate_keys_and_invalid_utf8():
    encoded = ContextPack.build(()).to_bytes()
    duplicate = encoded.replace(b"{", b'{"schema":"ignored",', 1)
    with pytest.raises(ContextPackError):
        ContextPack.from_bytes(duplicate)
    with pytest.raises(ContextPackError):
        ContextPack.from_bytes(b"\xff")


@pytest.mark.asyncio
async def test_empty_runtime_result_can_replace_a_nonempty_pack():
    base = ContextPack.from_content("previous result")
    async with open_builtin_runtime(BuiltinConfig()) as runtime:
        assert runtime.scopes is not None
        scope = await runtime.scopes.create(
            ScopeDraft(title="Empty pack", summary="Empty prepare", idempotency_key="empty-pack")
        )
        context = runtime.context.for_scope(scope.scope_id)
        request = PrepareContextRequest(query="no evidence")
        assert (await context.prepare(request)).content is None
        first = await context.prepare_incremental(request)
        delta = await context.prepare_incremental(request, base)
    assert isinstance(first, ContextPack) and first.items == ()
    assert isinstance(delta, ContextPackDelta)
    rebuilt = apply_context_pack_delta(
        ContextPack.from_bytes(base.to_bytes()), ContextPackDelta.from_bytes(delta.to_bytes())
    )
    assert rebuilt == first
