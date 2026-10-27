"""Offline query-driven literal evidence selection with complete wire budgeting."""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass

from powercontext.artifacts import ArtifactAddress
from powercontext.builtin.artifacts.search import analyze_fts_query, analyze_text
from powercontext.builtin.runtime.models import PrepareContextRequest, PreparedContext
from powercontext.builtin.runtime.prepared_context import (
    MemoryEntryAddress,
    PreparedContextBuild,
    PreparedEvidenceFragment,
    PreparedMemoryCandidates,
)
from powercontext.builtin.runtime.prepared_text import TRUST_POLICY

_BOUNDARY = re.compile(r"(?<=[.!?。！？])\s+|\n+")  # noqa: RUF001 - Unicode sentence punctuation


def _normalize_term(term: str) -> str:  # noqa: C901 - one ordered morphology pass
    if not term.isascii() or not term.isalpha() or len(term) < 4:
        return term
    if term.endswith("ies"):
        term = term[:-3] + "y"
    elif term.endswith("sses"):
        term = term[:-2]
    elif term.endswith("s") and not term.endswith(("ss", "us", "is")):
        term = term[:-1]
    for suffix in ("ing", "ed"):
        if len(term) > len(suffix) + 3 and term.endswith(suffix):
            root = term[: -len(suffix)]
            if any(vowel in root for vowel in "aeiouy"):
                term = root
                if len(term) > 3 and term[-1] == term[-2] and term[-1] in "bdgmnprt":
                    term = term[:-1]
                break
    for suffix, replacement in (
        ("ization", "ize"),
        ("ational", "ate"),
        ("ation", "ate"),
        ("fulness", "ful"),
        ("iveness", "ive"),
        ("ousness", "ous"),
        ("ments", ""),
        ("ment", ""),
        ("ness", ""),
    ):
        if len(term) > len(suffix) + 3 and term.endswith(suffix):
            term = term[: -len(suffix)] + replacement
            break
    if len(term) > 6 and term.endswith(("tion", "sion")):
        term = term[:-3]
    return term[:-1] if len(term) > 4 and term.endswith("e") else term


def _terms(text: str) -> Counter[str]:
    return Counter(_normalize_term(term) for term in analyze_text(text).split())


def _sentences(text: str) -> tuple[tuple[int, int], ...]:
    starts = [0, *(match.end() for match in _BOUNDARY.finditer(text))]
    ends = [*(match.end() for match in _BOUNDARY.finditer(text)), len(text)]
    result = []
    for start, end in zip(starts, ends, strict=True):
        while start < end and text[start].isspace():
            start += 1
        if start < end and text[start:end].strip():
            result.append((start, end))
    return tuple(result)


@dataclass(frozen=True)
class _Passage:
    entry: int
    start: int
    end: int
    score: float


def _rank_passages(query: str, texts: Sequence[str]) -> tuple[_Passage, ...]:
    query_terms = _terms(analyze_fts_query(query))
    sentences = [(index, start, end) for index, text in enumerate(texts) for start, end in _sentences(text)]
    counts = [_terms(texts[index][start:end]) for index, start, end in sentences]
    if not counts or not query_terms:
        return ()
    documents = [_terms(text) for text in texts]
    frequencies = Counter(term for count in documents for term in query_terms if term in count)
    weights = {
        term: math.log1p((len(documents) - frequencies[term] + 0.5) / (frequencies[term] + 0.5))
        * (0.2 if term in {"no", "not", "without", "ha", "have", "may"} else 1)
        for term in query_terms
    }
    average = sum(sum(count.values()) for count in counts) / len(counts)
    ranked = []
    for (entry, start, end), count in zip(sentences, counts, strict=True):
        matches = query_terms.keys() & count.keys()
        length = sum(count.values())
        score = sum(
            weights[term] * count[term] * 2.2 / (count[term] + 1.2 * (0.7 + 0.3 * length / max(average, 1)))
            for term in matches
        )
        score *= 1 + len(matches) / len(query_terms)
        ranked.append(_Passage(entry, start, end, score))
    return _with_neighbor_context(ranked)


def _with_neighbor_context(passages: Sequence[_Passage]) -> tuple[_Passage, ...]:
    """Keep supporting neighboring sentences eligible under the same wire budget."""

    ranked = []
    for index, span in enumerate(passages):
        neighbors = passages[max(0, index - 1) : index + 2]
        support = max((neighbor.score for neighbor in neighbors if neighbor.entry == span.entry), default=0)
        score = max(span.score, 0.3 * support)
        if score > 0:
            ranked.append(_Passage(span.entry, span.start, span.end, score))
    return tuple(sorted(ranked, key=lambda span: (-span.score, span.entry, span.start)))


def _merge(passages: Sequence[_Passage], texts: Sequence[str]) -> tuple[_Passage, ...]:
    merged: list[_Passage] = []
    for passage in sorted(passages, key=lambda item: (item.entry, item.start)):
        if merged and merged[-1].entry == passage.entry:
            previous = merged[-1]
            if passage.start <= previous.end or not texts[passage.entry][previous.end : passage.start].strip():
                merged[-1] = _Passage(
                    passage.entry, previous.start, max(previous.end, passage.end), previous.score + passage.score
                )
                continue
        merged.append(passage)
    return tuple(merged)


def _render(fragments: tuple[PreparedEvidenceFragment, ...]) -> str:
    items = [
        {
            "citation": {
                "scope_id": fragment.address.memory.scope_id,
                "memory_ref": fragment.address.memory.artifact.model_dump(mode="json"),
                "entry_id": fragment.address.entry_id,
                "entry_version_id": fragment.address.entry_version_id,
            },
            "content": fragment.text,
            "start": fragment.start,
            "end": fragment.end,
        }
        for fragment in fragments
    ]
    encoded = json.dumps({"trust": "untrusted_history", "items": items}, ensure_ascii=False, separators=(",", ":"))
    return f"{TRUST_POLICY}\n\nBEGIN_POWERCONTEXT_PREPARED_CONTEXT_V1\n{encoded}\nEND_POWERCONTEXT_PREPARED_CONTEXT_V1"


def _memory_entries(
    groups: Sequence[PreparedMemoryCandidates],
) -> tuple[tuple[MemoryEntryAddress, ...], tuple[str, ...]]:
    entries: dict[tuple[str, str, str], tuple[MemoryEntryAddress, str]] = {}
    for group in groups:
        for hit in group.hits:
            address = MemoryEntryAddress(
                memory=ArtifactAddress(scope_id=group.scope_id, artifact=hit.memory_ref),
                entry_id=hit.entry_id,
                entry_version_id=hit.entry_version_id,
            )
            key = address.memory.model_dump_json(), address.entry_id, address.entry_version_id
            entries.setdefault(key, (address, hit.text))
    return tuple(address for address, _ in entries.values()), tuple(text for _, text in entries.values())


def select_memory_evidence(  # noqa: C901 - one budgeted selection loop and its exact wire-size cache
    request: PrepareContextRequest, groups: Sequence[PreparedMemoryCandidates]
) -> PreparedContextBuild:
    """Select exact sentences, sharing citation overhead for adjoining evidence."""

    addresses, texts = _memory_entries(groups)
    ranked = _rank_passages(request.query, texts)
    selected: tuple[_Passage, ...] = ()

    def fragments(passages: Sequence[_Passage]) -> tuple[PreparedEvidenceFragment, ...]:
        return tuple(
            PreparedEvidenceFragment(
                addresses[span.entry], span.start, span.end, texts[span.entry][span.start : span.end]
            )
            for span in sorted(passages, key=lambda item: (-item.score, item.entry, item.start))
        )

    used: set[tuple[int, int, int]] = set()
    empty_size = len(_render(()).encode("utf-8"))
    item_sizes: dict[tuple[int, int, int], int] = {}

    def wire_size(passages: Sequence[_Passage]) -> int:
        total = empty_size + max(0, len(passages) - 1)
        for passage in passages:
            key = passage.entry, passage.start, passage.end
            if key not in item_sizes:
                item_sizes[key] = len(_render(fragments((passage,))).encode("utf-8")) - empty_size
            total += item_sizes[key]
        return total

    current_size = 0
    # Each admission is charged using the final rendered payload. Looking at
    # every sentence allows a short late passage to fit after a long one fails.
    while True:
        best = None
        for span in ranked:
            identity = (span.entry, span.start, span.end)
            if identity in used:
                continue
            candidate = _merge((*selected, span), texts)
            size = wire_size(candidate)
            if size > request.max_bytes:
                continue
            value = span.score / max(size - current_size, 1) ** 0.2
            if best is None or value > best[0]:
                best = value, identity, candidate, size
        if best is None:
            break
        _, identity, selected, current_size = best
        used.add(identity)
    if not selected:
        return PreparedContextBuild(context=PreparedContext(status="empty", content=None, content_bytes=0), origins=())
    chosen = fragments(selected)
    content = _render(chosen)
    return PreparedContextBuild(
        context=PreparedContext(status="ready", content=content, content_bytes=len(content.encode("utf-8"))),
        origins=tuple(fragment.address for fragment in chosen),
        fragments=chosen,
    )
