"""Complete physical PDF pages and exact Memory-backed page retrieval."""

from __future__ import annotations

import hashlib
import io
import json
import math
import re
from collections import Counter
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
])
_FINANCIAL_EXPANSIONS = {
    "ebitda": "operating income depreciation amortization",
    "capex": "capital expenditures investing activities cash flows",
    "geographies": "geographic countries markets international divisions operations",
    "legal": "litigation proceedings contingencies lawsuits",
    "restructuring": "restructuring charges expenses costs",
    "income": "income earnings operations",
}


def _question_terms(question: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(term for term in _WORDS.findall(question.lower()) if term not in _STOP_WORDS))


_PageKey = tuple[str, str, str]


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


def _rank_candidates(
    candidates: dict[_PageKey, MemoryHit],
    ranks: dict[_PageKey, float],
    terms: tuple[str, ...],
    expansions: tuple[str, ...],
) -> list[MemoryHit]:
    if not candidates:
        return []
    counts = {key: Counter(_WORDS.findall(hit.text.lower())) for key, hit in candidates.items()}
    weighted_terms = dict.fromkeys(terms, 1.0)
    for expansion in expansions:
        for term in expansion.split():
            weighted_terms[term] = max(weighted_terms.get(term, 0.0), 0.6)
    frequencies = Counter(term for count in counts.values() for term in weighted_terms if term in count)
    average = sum(sum(count.values()) for count in counts.values()) / len(counts)

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
        return lexical + 8 * ranks[key]

    return [candidates[key] for key in sorted(candidates, key=lambda key: (-score(key), key))]


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
    expansions = tuple(_FINANCIAL_EXPANSIONS[term] for term in terms if term in _FINANCIAL_EXPANSIONS)
    queries = [analyze_fts_query(question), " ".join(terms), *expansions]
    # Small groups admit concise tables containing only some requested facts.
    queries.extend(" ".join(terms[start : start + 4]) for start in range(0, len(terms), 4))
    candidates, ranks = await _collect_candidates(memory, queries)

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
