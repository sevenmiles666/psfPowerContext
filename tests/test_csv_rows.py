# Copyright (c) 2026 OceanBase.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""CSV preservation and rejection cases beyond the published airport workload."""

from __future__ import annotations

import asyncio
import json

import pytest

from powercontext.sources import (
    TEXT_EVIDENCE_PROJECTION_KEY,
    SourceDefinitionRegistry,
    SourceMaterialization,
    manifest_for_definition,
    project_source_for_transport,
)
from powercontext.sources.csv_rows import (
    CSV_ROW_SOURCE_DEFINITION,
    CSVDocumentInput,
    CSVRowInput,
    CSVRowSource,
    csv_row_source_id,
    parse_csv_document,
)


def test_unicode_and_newlines_survive_json_transport_without_type_conversion() -> None:
    rows = parse_csv_document(
        CSVDocumentInput(
            document_id="记录/%:表",
            primary_key=" 键 ",
            content='\ufeff" 键 ",数字,布尔,空值,备注\r\n" 001 ",1.00,false,,"甲\r\n乙"\r\n'.encode(),
        )
    )
    row = rows[0]
    assert row.values == (" 001 ", "1.00", "false", "", "甲\r\n乙")
    registry = SourceDefinitionRegistry((CSV_ROW_SOURCE_DEFINITION,))
    source = asyncio.run(registry.resolve(row))
    restored = CSVRowSource.model_validate_json(source.model_dump_json())
    assert restored.materialization == SourceMaterialization.CAPTURED
    assert asyncio.run(registry.read(restored)) == row
    manifest = manifest_for_definition(CSV_ROW_SOURCE_DEFINITION)
    observation = project_source_for_transport(registry, restored)
    assert observation.definition_fingerprint == manifest.fingerprint
    evidence = observation.projection(TEXT_EVIDENCE_PROJECTION_KEY)
    assert evidence["content"] == '{" 键 ":" 001 ","数字":"1.00","布尔":"false","空值":"","备注":"甲\\r\\n乙"}'
    assert json.loads(evidence["content"]) == evidence["metadata"]["row"]
    assert evidence["metadata"]["columns"] == list(row.columns)


@pytest.mark.parametrize(
    ("primary_key", "content"),
    [
        ("id", b"\nid,name\n1,one\n"),
        ("id", b"\xef\xbb\xbf"),
        ("id", b"id,name\n1,valid\n2,too,many\n"),
        ("id", b'id,name\n1,valid\n2,"bad"tail\n'),
        ("id", b"id,name\n1,valid\n \t,blank\n"),
        ("id", b"id,name\n1,valid\n\xff,invalid\n"),
        ("id", b'id\n""\n'),
        ("id", b"id,name\n" + b"x" * 260 + b",long-key\n"),
        ("id", b" id ,name\n1,one\n"),
        ("", b"id,name\n1,one\n"),
    ],
)
def test_invalid_tail_or_header_rejects_the_entire_document(primary_key: str, content: bytes) -> None:
    with pytest.raises(ValueError):
        parse_csv_document(CSVDocumentInput(document_id="document", primary_key=primary_key, content=content))


def test_only_empty_physical_records_are_ignored_and_header_comparison_is_exact() -> None:
    rows = parse_csv_document(
        CSVDocumentInput(document_id="document", primary_key="id", content=b"id, id \r\n\r\n1, first \r\n\r\n")
    )
    assert len(rows) == 1
    assert rows[0].columns == ("id", " id ")
    assert rows[0].values == ("1", " first ")
    with pytest.raises(ValueError):
        parse_csv_document(CSVDocumentInput(document_id="document", primary_key="id", content=b'id,name\n"",\n'))


def test_identity_boundary_applies_after_encoding_and_components_do_not_collide() -> None:
    assert len(csv_row_source_id("d", "x" * 250)) == 256
    with pytest.raises(ValueError):
        csv_row_source_id("d", "x" * 251)
    with pytest.raises(ValueError):
        csv_row_source_id("d", "界" * 28)
    assert csv_row_source_id("a:b", "c") != csv_row_source_id("a", "b:c")
    assert csv_row_source_id("a/b", "%") == "csv:a%2Fb:%25"


@pytest.mark.parametrize(
    "changes",
    [
        {"columns": ("id", "id")},
        {"columns": ("id", " ")},
        {"values": ("1",)},
        {"primary_key_value": "2"},
        {"primary_key": "missing"},
        {"document_id": " document"},
    ],
)
def test_direct_row_inputs_cannot_capture_inconsistent_records(changes: dict[str, object]) -> None:
    fields = {
        "document_id": "document",
        "primary_key": "id",
        "primary_key_value": "1",
        "columns": ("id", "name"),
        "values": ("1", "one"),
    }
    with pytest.raises(ValueError):
        CSVRowInput.model_validate(fields | changes)


def test_serialized_source_rejects_identity_or_materialization_changes() -> None:
    row = parse_csv_document(CSVDocumentInput(document_id="document", primary_key="id", content=b"id\n1\n"))[0]
    registry = SourceDefinitionRegistry((CSV_ROW_SOURCE_DEFINITION,))
    source = asyncio.run(registry.resolve(row))
    for changes in (
        {"name": "csv:document:other"},
        {"source_id": "csv:document:other"},
        {"materialization": "referenced"},
    ):
        with pytest.raises(ValueError):
            CSVRowSource.model_validate(source.model_dump() | changes)
