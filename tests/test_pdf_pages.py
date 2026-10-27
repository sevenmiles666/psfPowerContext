"""Complete PDF evidence must remain durable and discoverable through Memory."""

from __future__ import annotations

from pathlib import Path

import pytest

from powercontext.builtin.artifacts.memory import MemoryCandidateRequest, MemoryEntryInput
from powercontext.builtin.persistence.sqlite import SQLiteConfig
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


@pytest.mark.asyncio
async def test_complete_large_page_survives_ingestion_restart_and_citation_readback(tmp_path: Path):
    text = "营业现金流与资产负债表完整明细。" * 300 + "\nLiquidity coverage reserve at the end of the physical page."
    page = PDFPageInput(document_id="DENSE_2024_10K", document_sha256="c" * 64, page_number=1, text=text)
    registry = SourceDefinitionRegistry((PDF_PAGE_SOURCE_DEFINITION,))
    observation = project_source_for_transport(registry, await registry.resolve(page))
    expected = f"{page.document_id}\n{text}"
    assert len(expected.encode("utf-8")) > 8192
    config = BuiltinConfig(database=SQLiteConfig(url=f"sqlite+aiosqlite:///{tmp_path / 'dense.db'}"))
    async with open_builtin_runtime(config) as runtime:
        assert runtime.scopes is not None
        scope = await runtime.scopes.create(
            ScopeDraft(title="Dense report", summary="Complete physical page", idempotency_key="dense")
        )
        await runtime.ingestion.register(manifest_for_definition(PDF_PAGE_SOURCE_DEFINITION))
        request = SubmitSourceObservation(scope_id=scope.scope_id, observation=observation)
        await runtime.ingestion.submit(request)
        await runtime.ingestion.submit(request)
    async with open_builtin_runtime(config, candidate_pipeline=_LiteralPages()) as runtime:
        memory = runtime.memory.for_scope(scope.scope_id)
        while (await memory.flush()).processed:
            pass
    async with open_builtin_runtime(config) as runtime:
        memory = runtime.memory.for_scope(scope.scope_id)
        citations = await search_pdf_pages(memory, "liquidity coverage reserve", limit=20)
        assert len(citations) == 1
        entry = await memory.get(GetMemoryEntryRequest(citation=citations[0]))
        assert entry.entry.text == expected
        assert tuple(reference.source_id for reference in entry.entry.sources) == (observation.name,)


@pytest.mark.asyncio
async def test_financial_concept_recalls_operands_without_matching_question_boilerplate():
    statements = (
        "CONSOLIDATED STATEMENT OF INCOME\n2024\nNet sales 1000\nNet earnings 200.",
        "CONSOLIDATED BALANCE SHEET\n2024\nAssets 5000\nProperty plant and equipment 3000.",
        "CONSOLIDATED STATEMENT OF CASH FLOWS\n2024\nOperating activities 400\nCapital expenditures 250.",
    )
    registry = SourceDefinitionRegistry((PDF_PAGE_SOURCE_DEFINITION,))
    texts = (
        *statements,
        *(
            f"Atlas Industries business profile {index}. Capital intensive business based on 2024 data. "
            "The discussion refers to the Consolidated Statements of Income for additional information. " * 4
            for index in range(30)
        ),
    )
    observations = tuple([
        project_source_for_transport(
            registry,
            await registry.resolve(
                PDFPageInput(
                    document_id="ATLASINDUSTRIES_2024_10K",
                    document_sha256="d" * 64,
                    page_number=index,
                    text=text,
                )
            ),
        )
        for index, text in enumerate(texts, start=1)
    ])
    async with open_builtin_runtime(BuiltinConfig(), candidate_pipeline=_LiteralPages()) as runtime:
        assert runtime.scopes is not None
        scope = await runtime.scopes.create(
            ScopeDraft(title="Operating report", summary="Financial evidence", idempotency_key="operating")
        )
        await runtime.ingestion.register(manifest_for_definition(PDF_PAGE_SOURCE_DEFINITION))
        for observation in observations:
            await runtime.ingestion.submit(SubmitSourceObservation(scope_id=scope.scope_id, observation=observation))
        memory = runtime.memory.for_scope(scope.scope_id)
        while (await memory.flush()).processed:
            pass
        citations = await search_pdf_pages(
            memory, "Is Atlas Industries a capital-intensive business based on 2024 data?", limit=20
        )
        found = set()
        for citation in citations:
            entry = await memory.get(GetMemoryEntryRequest(citation=citation))
            found.update(reference.source_id for reference in entry.entry.sources)
        assert {observation.name for observation in observations[:3]} <= found
