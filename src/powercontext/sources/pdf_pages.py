"""Complete physical PDF pages and exact Memory-backed page retrieval."""

from __future__ import annotations

import hashlib
import io
import json
import math
import re
from collections import Counter
from itertools import pairwise
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator
from pypdf import PdfReader

from powercontext.builtin.artifacts.memory.models import MemoryCitation, MemoryHit
from powercontext.builtin.artifacts.search import analyze_fts_query
from powercontext.builtin.runtime.application import ScopedMemoryApplication
from powercontext.builtin.runtime.models import GetMemoryEntryRequest, SearchMemoryRequest
from powercontext.sources.definitions import AdapterSourceDefinition, SourceDefinition
from powercontext.sources.models import Source, SourceMaterialization
from powercontext.sources.projections import TEXT_EVIDENCE_PROJECTION_KEY, TextEvidence


class PDFDocumentInput(BaseModel):
    """Unmodified bytes of a complete PDF revision."""

    document_id: str = Field(min_length=1)
    content: bytes

    @field_validator("document_id")
    @classmethod
    def validate_document_id(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("PDF document_id must not be blank")  # noqa: TRY003
        return value


class PDFPageInput(BaseModel):
    """The full extracted text of one physical page, including blank pages."""

    document_id: str = Field(min_length=1)
    document_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    page_number: int = Field(strict=True, gt=0)
    text: str

    @field_validator("document_id")
    @classmethod
    def validate_document_id(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("PDF document_id must not be blank")  # noqa: TRY003
        return value


def parse_pdf_document(value: PDFDocumentInput) -> tuple[PDFPageInput, ...]:
    """Extract every physical page before returning any captured input."""

    if not value.content or not value.content.lstrip().startswith(b"%PDF-"):
        raise ValueError("Input must be a complete PDF")  # noqa: TRY003
    digest = hashlib.sha256(value.content).hexdigest()
    try:
        reader = PdfReader(io.BytesIO(value.content), strict=True)
        if reader.is_encrypted:
            reader.decrypt("")
        pages = tuple(
            PDFPageInput(
                document_id=value.document_id,
                document_sha256=digest,
                page_number=number,
                text=page.extract_text() or "",
            )
            for number, page in enumerate(reader.pages, start=1)
        )
    except Exception as error:
        raise ValueError("PDF could not be completely parsed") from error  # noqa: TRY003
    if not pages:
        raise ValueError("PDF has no pages")  # noqa: TRY003
    return pages


def _page_identity(page: PDFPageInput) -> str:
    identity = json.dumps(
        [page.document_id, page.document_sha256, page.page_number], ensure_ascii=False, separators=(",", ":")
    )
    return "pdf:" + hashlib.sha256(identity.encode("utf-8")).hexdigest()


class PDFPageSource(Source):
    """One immutable revision-specific physical page."""

    materialization: Literal[SourceMaterialization.CAPTURED] = SourceMaterialization.CAPTURED
    page: PDFPageInput

    @model_validator(mode="after")
    def validate_identity(self) -> PDFPageSource:
        if self.name != _page_identity(self.page):
            raise ValueError("PDF Source name must match its physical page identity")  # noqa: TRY003
        return self


class _PDFPageAdapter:
    input_class = PDFPageInput
    name = "pdf-page"
    source_class = PDFPageSource

    async def resolve(self, value: PDFPageInput, /) -> PDFPageSource:
        return PDFPageSource(name=_page_identity(value), page=value)

    async def read(self, source: PDFPageSource, /) -> PDFPageInput:
        return source.page


class _PDFPageTextEvidenceProjection:
    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = PDFPageSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: PDFPageSource, /) -> TextEvidence:
        page = source.page
        return TextEvidence(
            source_type="pdf-page",
            source_id=source.name,
            content=f"{page.document_id}\n{page.text}",
            metadata={
                "document_id": page.document_id,
                "document_sha256": page.document_sha256,
                "page_number": page.page_number,
            },
        )


PDF_PAGE_SOURCE_DEFINITION: SourceDefinition[PDFPageInput, PDFPageSource, PDFPageInput] = AdapterSourceDefinition(
    _PDFPageAdapter(), projections=(_PDFPageTextEvidenceProjection(),)
)

_WORDS = re.compile(r"[a-z]+|\d+")
_STOP_WORDS = frozenset([
    "what",
    "which",
    "who",
    "how",
    "is",
    "are",
    "was",
    "were",
    "has",
    "have",
    "had",
    "a",
    "an",
    "the",
    "of",
    "to",
    "and",
    "or",
    "in",
    "for",
    "from",
    "as",
    "at",
    "by",
    "with",
    "on",
    "any",
    "its",
    "it",
    "this",
    "that",
    "then",
    "if",
    "not",
    "be",
    "been",
    "can",
    "could",
    "would",
    "should",
    "do",
    "does",
    "did",
    "give",
    "state",
    "answer",
    "respond",
    "question",
    "assuming",
    "perspective",
    "investment",
    "analyst",
    "only",
    "use",
    "details",
    "shown",
    "within",
    "relying",
    "calculate",
    "define",
    "unadjusted",
    "adjusted",
    "fy",
    "fiscal",
    "year",
    "reported",
    "reports",
    "report",
    "company",
    "approximately",
    "total",
    "quantity",
    "directly",
    "outlined",
    "explicitly",
    "important",
    "primarily",
    "about",
    "able",
    "assume",
    "between",
    "billions",
    "changed",
    "compare",
    "declined",
    "done",
    "during",
    "end",
    "equities",
    "explain",
    "following",
    "improved",
    "improving",
    "information",
    "like",
    "major",
    "metric",
    "millions",
    "much",
    "please",
    "profile",
    "public",
    "s",
    "something",
    "than",
    "usd",
    "useful",
    "using",
    "why",
])
_FINANCIAL_EXPANSIONS = {
    "ebitda": "consolidated statements income operating profit depreciation amortization",
    "capex": "capital expenditures investing activities cash flows",
    "ppne": "property plant equipment accumulated depreciation",
    "ppe": "property plant equipment accumulated depreciation",
    "quick": "cash equivalents securities receivables current assets current liabilities",
    "cogs": "cost goods products sales sold",
    "margin": "consolidated statements income operations revenue revenues expenses cost products goods sold",
    "tax": "consolidated statements income operations income before taxes provision expense effective rate",
    "liability": "consolidated balance sheets assets liabilities",
    "concentration": "customer customers accounted sales revenues percent",
    "retain": "retention attrition renewals members",
    "products": "product products business overview offerings",
    "customers": "customer customers major principal sales revenues contracts",
    "categories": "business segment revenues sales",
    "geographies": "geographic countries markets international divisions operations",
    "legal": "litigation proceedings contingencies lawsuits",
    "restructuring": "restructuring charges expenses costs",
    "income": "income earnings profit operations",
    "capital": "consolidated balance sheets property plant equipment capital expenditures cash flows",
    "intensive": "consolidated statements income balance sheets property plant equipment cash flows",
    "cashflow": "consolidated statements cash flows operating activities net income capital expenditures",
    "cash": "cash flows operating investing financing activities",
    "conversion": "consolidated statements cash flows operating activities net income",
    "inventory": "consolidated balance sheets inventories cost sales goods sold",
    "turnover": "consolidated balance sheets inventories cost sales goods sold",
    "roa": "consolidated statements income balance sheets total assets",
    "roe": "consolidated statements income balance sheets shareholders equity",
    "return": "consolidated statements income balance sheets assets equity",
    "growth": "revenue revenues sales organic change prior year business segment",
    "segment": "business segment organic sales change acquisitions divestitures",
    "acquisition": "business combinations acquisitions purchased acquired",
    "gross": "consolidated statements income sales revenues cost products goods sold",
    "working": "consolidated balance sheets current assets current liabilities",
    "debt": "consolidated balance sheets short long term borrowings debt",
    "dividend": "quarterly cash dividends common shareholders equity board declared authorized paid",
}
_FINANCIAL_METRIC_TERMS = frozenset({
    "ebitda",
    "capex",
    "ppne",
    "ppe",
    "quick",
    "cogs",
    "margin",
    "tax",
    "liability",
    "income",
    "capital",
    "intensive",
    "cashflow",
    "cash",
    "conversion",
    "inventory",
    "turnover",
    "roa",
    "roe",
    "return",
    "growth",
    "gross",
    "working",
    "debt",
    "dividend",
    "ratio",
    "profit",
    "revenue",
    "sales",
    "asset",
    "earnings",
    "expense",
})
_STATEMENT_QUERIES = (
    "consolidated income statements",
    "consolidated balance sheets",
    "consolidated cash flows",
)
_STATEMENT_HEADINGS = tuple(
    re.compile(r"(?m)^[ \t]*(?:consolidated|combined)\s+" + title + r"[ \t]*(?:\([^\n]*\))?[ \t]*$")
    for title in (
        r"statements?\s+of\s+(?:income|earnings|operations)",
        r"(?:balance\s+sheets?|statements?\s+of\s+financial\s+position)",
        r"statements?\s+of\s+cash\s+flows?",
    )
)


def _question_terms(question: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(term for term in _WORDS.findall(question.lower()) if term not in _STOP_WORDS))


def _singular(term: str) -> str:
    if len(term) > 4 and term.endswith("ies"):
        return term[:-3] + "y"
    if len(term) > 4 and term.endswith("sses"):
        return term[:-2]
    if len(term) > 3 and term.endswith("s") and not term.endswith(("ss", "us", "is")):
        return term[:-1]
    return term


_PageKey = tuple[str, str, str]


def _document_entity(text: str) -> str:
    # The standard projection starts with the caller's document ID. A company
    # token there can select a document without dominating every page within it.
    document_id = text.partition("\n")[0]
    name = re.split(r"[_\s-]+(?:19|20)\d{2}", document_id.lower(), maxsplit=1)[0]
    return re.sub(r"[^a-z0-9]", "", name)


def _entity_aliases(entity: str, text: str) -> set[str]:
    """Derive abbreviations only when the page spells out its document entity."""

    aliases = {entity}
    words = [term for term in _WORDS.findall(text.partition("\n")[2][:600].lower()) if term not in {"and", "the"}]
    for start in range(len(words)):
        for size in range(2, 5):
            group = words[start : start + size]
            if len(group) != size or "".join(group) != entity:
                continue
            aliases.add("".join(word[0] for word in group))
            aliases.add("".join(word[:2] for word in group))
            if size == 2 and group[0] == group[1]:
                aliases.add(group[0][0] + "n" + group[1][0])
    return aliases


def _statement_family(text: str) -> int | None:
    head = text.partition("\n")[2][:600].lower()
    matches = [index for index, pattern in enumerate(_STATEMENT_HEADINGS) if pattern.search(head)]
    # A table of contents can list all statements; it is not one of them.
    return matches[0] if len(matches) == 1 else None


def _match_document_entities(
    candidates: dict[_PageKey, MemoryHit], entities: dict[_PageKey, str], terms: tuple[str, ...]
) -> tuple[set[str], set[str]]:
    aliases: dict[str, set[str]] = {}
    for key, entity in entities.items():
        aliases.setdefault(entity, {entity}).update(_entity_aliases(entity, candidates[key].text))
    query_entities: set[str] = set()
    entity_terms: set[str] = set()
    for start in range(len(terms)):
        for size in range(1, 5):
            group = terms[start : start + size]
            for entity, names in aliases.items():
                if "".join(group) in names:
                    query_entities.add(entity)
                    entity_terms.update(group)
    return query_entities, entity_terms


async def _collect_candidates(
    memory: ScopedMemoryApplication, queries: list[str]
) -> tuple[dict[_PageKey, MemoryHit], dict[_PageKey, float]]:
    candidates: dict[_PageKey, MemoryHit] = {}
    ranks: dict[_PageKey, float] = {}
    for query in dict.fromkeys(query for query in queries if query.strip()):
        page = await memory.search(SearchMemoryRequest(query=query[:8192], mode="fts", limit=100))
        for rank, hit in enumerate(page.hits, start=1):
            key = hit.memory_ref.model_dump_json(), hit.entry_id, hit.entry_version_id
            candidates[key] = hit
            ranks[key] = ranks.get(key, 0.0) + 1 / (40 + rank)
    return candidates, ranks


async def _expand_document_candidates(
    memory: ScopedMemoryApplication,
    candidates: dict[_PageKey, MemoryHit],
    ranks: dict[_PageKey, float],
    terms: tuple[str, ...],
) -> None:
    entities = {key: _document_entity(hit.text) for key, hit in candidates.items()}
    query_entities, _entity_terms = _match_document_entities(candidates, entities, terms)
    documents = {
        candidates[key].text.partition("\n")[0] for key, entity in entities.items() if entity in query_entities
    }
    for document in sorted(documents):
        # A short statement can lose the global lexical cutoff to repeated prose.
        # Expand only documents identified in the question, through the same scoped API.
        page = await memory.search(SearchMemoryRequest(query=document, mode="fts", limit=1000))
        for hit in page.hits:
            if hit.text.partition("\n")[0] != document:
                continue
            key = hit.memory_ref.model_dump_json(), hit.entry_id, hit.entry_version_id
            candidates[key] = hit
            ranks.setdefault(key, 0.0)


def _rank_candidates(
    candidates: dict[_PageKey, MemoryHit],
    ranks: dict[_PageKey, float],
    terms: tuple[str, ...],
    expansions: tuple[str, ...],
) -> list[MemoryHit]:
    if not candidates:
        return []
    tokens = {
        key: tuple(_singular(term) for term in _WORDS.findall(hit.text.lower())) for key, hit in candidates.items()
    }
    counts = {key: Counter(value) for key, value in tokens.items()}
    entities = {key: _document_entity(hit.text) for key, hit in candidates.items()}
    query_entities, entity_terms = _match_document_entities(candidates, entities, terms)
    weighted_terms = dict.fromkeys((_singular(term) for term in terms if term not in entity_terms), 1.0)
    for expansion in expansions:
        for term in expansion.split():
            term = _singular(term)
            weighted_terms[term] = max(weighted_terms.get(term, 0.0), 0.6)
    frequencies = Counter(term for count in counts.values() for term in weighted_terms if term in count)
    average = sum(sum(count.values()) for count in counts.values()) / len(counts)
    phrases = {
        (_singular(left), _singular(right))
        for group in (
            tuple(term for term in terms if term not in entity_terms),
            *(expansion.split() for expansion in expansions),
        )
        for left, right in pairwise(group)
        if left.isalpha() and right.isalpha()
    }

    def score(key: _PageKey) -> float:
        count = counts[key]
        length = sum(count.values())
        lexical = sum(
            weight
            * math.log1p((len(counts) - frequencies[term] + 0.5) / (frequencies[term] + 0.5))
            * count[term]
            * 2.2
            / (count[term] + 1.2 * (0.25 + 0.75 * length / max(average, 1)))
            for term, weight in weighted_terms.items()
            if count[term]
        )
        present = set(pairwise(tokens[key]))
        proximity = sum(
            sum(math.log1p(len(counts) / (1 + frequencies[term])) for term in phrase) for phrase in phrases & present
        )
        document_match = 4 * math.log1p(len(counts)) if entities[key] in query_entities else 0
        return lexical + 2 * proximity + 8 * ranks[key] + document_match

    ranked = sorted(candidates, key=lambda key: (-score(key), key))
    selected = []
    if any(_singular(term) in _FINANCIAL_METRIC_TERMS for term in terms):
        # Ratios and cash metrics often name a concept rather than the statement
        # containing its operands. Keep a small, diverse set of actual statements.
        for family in range(len(_STATEMENT_HEADINGS)):
            matching = [
                key
                for key in ranked
                if (not query_entities or entities[key] in query_entities)
                and _statement_family(candidates[key].text) == family
            ]
            selected.extend(matching[:2])
    selected_set = set(selected)
    return [
        candidates[key]
        for key in (
            *(key for key in ranked if key in selected_set),
            *(key for key in ranked if key not in selected_set),
        )
    ]


async def search_pdf_pages(
    memory: ScopedMemoryApplication, question: str, limit: int = 10
) -> tuple[MemoryCitation, ...]:
    """Search native Memory, then rank distinct physical pages using query evidence."""

    if type(limit) is not int or limit < 0:
        raise ValueError("PDF search limit must be a nonnegative integer")  # noqa: TRY003
    if not isinstance(question, str) or not question.strip():
        raise ValueError("PDF question must be nonempty text")  # noqa: TRY003
    if limit == 0:
        return ()
    terms = _question_terms(question)
    normalized_terms = {_singular(term) for term in terms}
    expansions = tuple(value for term, value in _FINANCIAL_EXPANSIONS.items() if _singular(term) in normalized_terms)
    queries = [analyze_fts_query(question), " ".join(terms), *expansions, *_STATEMENT_QUERIES]
    # Small groups admit concise tables containing only some requested facts.
    queries.extend(" ".join(terms[start : start + 4]) for start in range(0, len(terms), 4))
    queries.extend(" ".join(_singular(term) for term in terms[start : start + 4]) for start in range(0, len(terms), 4))
    candidates, ranks = await _collect_candidates(memory, queries)
    await _expand_document_candidates(memory, candidates, ranks, terms)

    citations = []
    seen_pages = set()
    for hit in _rank_candidates(candidates, ranks, terms, expansions):
        citation = MemoryCitation(
            memory_ref=hit.memory_ref, entry_id=hit.entry_id, entry_version_id=hit.entry_version_id
        )
        entry = await memory.get(GetMemoryEntryRequest(citation=citation))
        if entry is None:
            continue
        pdf_refs = [source for source in entry.entry.sources if source.source_type == "pdf-page"]
        if not pdf_refs:
            continue
        page_key = tuple(sorted(source.source_id for source in pdf_refs))
        if page_key in seen_pages:
            continue
        seen_pages.add(page_key)
        citations.append(citation)
        if len(citations) >= limit:
            break
    return tuple(citations)


__all__ = [
    "PDF_PAGE_SOURCE_DEFINITION",
    "PDFDocumentInput",
    "PDFPageInput",
    "PDFPageSource",
    "parse_pdf_document",
    "search_pdf_pages",
]
