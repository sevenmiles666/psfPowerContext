"""Financial evidence must outrank repeated company boilerplate in a mixed scope."""

from __future__ import annotations

import pytest

from powercontext.builtin.artifacts.memory import MemoryCandidateRequest, MemoryEntryInput
from powercontext.builtin.runtime import (
    BuiltinConfig,
    GetMemoryEntryRequest,
    SubmitSourceObservation,
    open_builtin_runtime,
)
from powercontext.builtin.scope import ScopeDraft
from powercontext.sources import (
    TEXT_EVIDENCE_PROJECTION_KEY,
    SourceDefinitionRegistry,
    SourceObservation,
    TextEvidence,
    manifest_for_definition,
    project_source_for_transport,
)
from powercontext.sources.pdf_pages import PDF_PAGE_SOURCE_DEFINITION, PDFPageInput, search_pdf_pages


class _LiteralPages:
    async def extract(self, request: MemoryCandidateRequest, /) -> tuple[MemoryEntryInput, ...]:
        return tuple(
            MemoryEntryInput(
                kind="source-evidence",
                text=TextEvidence.model_validate(source.projection(TEXT_EVIDENCE_PROJECTION_KEY)).content,
                sources=(source,),
            )
            for source in request.sources
            if isinstance(source, SourceObservation)
        )


@pytest.mark.asyncio
async def test_statement_evidence_outranks_company_repetition_and_other_documents():
    statement = "CONSOLIDATED STATEMENTS OF INCOME\n2024\nRevenue 1000\nOperating expenses 650\nOperating profit 350."
    registry = SourceDefinitionRegistry((PDF_PAGE_SOURCE_DEFINITION,))
    pages = (
        PDFPageInput(
            document_id="ATLASFINANCE_2024_10K",
            document_sha256="a" * 64,
            page_number=1,
            text="Atlas Finance financial profile. " * 50 + "Corporate legal registration for 2024.",
        ),
        PDFPageInput(document_id="ATLASFINANCE_2024_10K", document_sha256="a" * 64, page_number=2, text=statement),
        PDFPageInput(document_id="RIVALINVESTMENTS_2024_10K", document_sha256="b" * 64, page_number=1, text=statement),
    )
    observations = tuple([project_source_for_transport(registry, await registry.resolve(page)) for page in pages])
    async with open_builtin_runtime(BuiltinConfig(), candidate_pipeline=_LiteralPages()) as runtime:
        assert runtime.scopes is not None
        scope = await runtime.scopes.create(
            ScopeDraft(title="Reports", summary="Mixed financial reports", idempotency_key="reports")
        )
        await runtime.ingestion.register(manifest_for_definition(PDF_PAGE_SOURCE_DEFINITION))
        for observation in observations:
            await runtime.ingestion.submit(SubmitSourceObservation(scope_id=scope.scope_id, observation=observation))
        memory = runtime.memory.for_scope(scope.scope_id)
        while (await memory.flush()).processed:
            pass
        citations = await search_pdf_pages(memory, "What is Atlas Finance's operating margin for 2024?", limit=1)
        assert len(citations) == 1
        entry = await memory.get(GetMemoryEntryRequest(citation=citations[0]))
        assert entry.entry.text == f"ATLASFINANCE_2024_10K\n{statement}"
        assert tuple(reference.source_id for reference in entry.entry.sources) == (observations[1].name,)
