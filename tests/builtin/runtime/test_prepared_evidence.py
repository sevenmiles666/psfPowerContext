"""Literal evidence must retain per-scope identities and complete wire budgets."""

from __future__ import annotations

import json

from powercontext.artifacts import ArtifactRef
from powercontext.builtin.artifacts.memory import MemoryHit
from powercontext.builtin.runtime import PrepareContextRequest
from powercontext.builtin.runtime.prepared_context import PreparedContextBuilder, PreparedMemoryCandidates

_REF = ArtifactRef(family="memory", artifact_id="memory", revision=7)


def _group(scope: str, text: str) -> PreparedMemoryCandidates:
    return PreparedMemoryCandidates(
        scope_id=scope,
        memory_ref=_REF,
        hits=(
            MemoryHit(
                memory_ref=_REF, entry_id="entry", entry_version_id="version", text=text, score=1, matched_by=("fts",)
            ),
        ),
    )


def _build(groups, *, budget=4000, query="cobalt temperature"):
    return PreparedContextBuilder().build_scopes_result(
        request=PrepareContextRequest(query=query, evidence_selection=True, max_bytes=budget),
        current_scope_id=groups[0].scope_id,
        memory_candidates=groups,
    )


def test_equal_text_keeps_distinct_scopes_and_exact_versions():
    text = "The cobalt temperature is 37 degrees."
    result = _build((_group("a", text), _group("b", text)))
    assert {fragment.address.memory.scope_id for fragment in result.fragments} == {"a", "b"}
    assert len(result.origins) == len(result.fragments) == 2
    for fragment, origin in zip(result.fragments, result.origins, strict=True):
        assert origin == fragment.address
        assert fragment.address.memory.artifact == _REF
        assert fragment.text == text[fragment.start : fragment.end]


def test_nonadjacent_evidence_keeps_intervals_without_inventing_text():
    text = "Cobalt temperature is 37. " + "Unrelated material. " * 60 + "Cobalt temperature sensor is calibrated."
    result = _build((_group("a", text),), budget=1400)
    assert len(result.fragments) == 2
    assert any("Cobalt temperature is 37." in fragment.text for fragment in result.fragments)
    assert any("Cobalt temperature sensor is calibrated." in fragment.text for fragment in result.fragments)
    first, last = sorted(result.fragments, key=lambda fragment: fragment.start)
    assert first.end < last.start
    for fragment in result.fragments:
        assert type(fragment.start) is type(fragment.end) is int
        assert fragment.text == text[fragment.start : fragment.end]


def test_unicode_exact_budget_and_insufficient_overhead():
    text = '海洋测温 station says "warm" 🌊.'
    groups = (_group("观测", text),)
    full = _build(groups, query="station")
    content = full.context.content
    assert content is not None
    size = len(content.encode("utf-8"))
    assert _build(groups, query="station", budget=size).context == full.context
    assert _build(groups, query="station", budget=size - 1).context.status == "empty"
    assert _build(groups, query="unmatched", budget=512).fragments == ()
    item = json.loads(content.splitlines()[-2])["items"][0]
    assert item["content"] == text
    assert item["citation"]["scope_id"] == "观测"
