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

"""Captured CSV rows with stable primary-key identities and exact text evidence."""

from __future__ import annotations

import csv
import io
import json
from typing import Literal
from urllib.parse import quote

from pydantic import BaseModel, model_validator

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources.definitions import AdapterSourceDefinition, SourceDefinition
from powercontext.sources.models import Source, SourceMaterialization
from powercontext.sources.projections import TEXT_EVIDENCE_PROJECTION_KEY, TextEvidence


class CSVDocumentInput(BaseModel):
    """Complete UTF-8 CSV bytes and the column that identifies each row."""

    document_id: str
    primary_key: str
    content: bytes


def _validate_document_id(document_id: str) -> None:
    if not document_id or document_id != document_id.strip():
        raise ValueError("document_id must be non-empty without surrounding whitespace")  # noqa: TRY003


def _validate_columns(columns: tuple[str, ...]) -> None:
    if not columns or any(not column.strip() for column in columns):
        raise ValueError("CSV headers must be non-empty and not blank")  # noqa: TRY003
    if len(set(columns)) != len(columns):
        raise ValueError("CSV headers must be unique")  # noqa: TRY003


def csv_row_source_id(document_id: str, primary_key_value: str) -> str:
    """Encode the document and unmodified key without delimiter collisions."""

    _validate_document_id(document_id)
    if not primary_key_value.strip():
        raise ValueError("primary key values must not be empty or blank")  # noqa: TRY003
    identity = f"csv:{quote(document_id, safe='')}:{quote(primary_key_value, safe='')}"
    if len(identity) > MAX_SOURCE_ID_LENGTH:
        raise ValueError(f"CSV source identity must not exceed {MAX_SOURCE_ID_LENGTH} characters")  # noqa: TRY003
    return identity


class CSVRowInput(BaseModel):
    """One validated record, retaining original column order and string values."""

    document_id: str
    primary_key: str
    primary_key_value: str
    columns: tuple[str, ...]
    values: tuple[str, ...]

    @model_validator(mode="after")
    def validate_row(self) -> CSVRowInput:
        _validate_columns(self.columns)
        if not self.primary_key or self.primary_key not in self.columns:
            raise ValueError("primary_key must exactly match a CSV header")  # noqa: TRY003
        if len(self.values) != len(self.columns):
            raise ValueError("CSV row width must match its headers")  # noqa: TRY003
        if self.values[self.columns.index(self.primary_key)] != self.primary_key_value:
            raise ValueError("primary_key_value must match the original key field")  # noqa: TRY003
        csv_row_source_id(self.document_id, self.primary_key_value)
        return self


def parse_csv_document(value: CSVDocumentInput) -> tuple[CSVRowInput, ...]:
    """Validate an entire document before returning any of its captured rows."""

    _validate_document_id(value.document_id)
    if not value.primary_key:
        raise ValueError("primary_key must not be empty")  # noqa: TRY003
    try:
        content = value.content.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError as error:
        raise ValueError("CSV content must be UTF-8") from error  # noqa: TRY003

    rows: list[CSVRowInput] = []
    seen_keys: set[str] = set()
    # newline="" preserves the original line endings inside quoted fields.
    reader = csv.reader(io.StringIO(content, newline=""), strict=True)
    try:
        columns = tuple(next(reader, ()))
        _validate_columns(columns)
        if value.primary_key not in columns:
            raise ValueError("primary_key must exactly match a CSV header")  # noqa: TRY003
        key_index = columns.index(value.primary_key)
        for fields in reader:
            if not fields:
                continue
            if len(fields) != len(columns):
                raise ValueError("CSV row width must match its headers")  # noqa: TRY003
            key = fields[key_index]
            if key in seen_keys:
                raise ValueError("CSV primary key values must be unique within a document")  # noqa: TRY003
            rows.append(
                CSVRowInput(
                    document_id=value.document_id,
                    primary_key=value.primary_key,
                    primary_key_value=key,
                    columns=columns,
                    values=tuple(fields),
                )
            )
            seen_keys.add(key)
    except csv.Error as error:
        raise ValueError("malformed CSV content") from error  # noqa: TRY003
    return tuple(rows)


class CSVRowSource(Source):
    """A captured original record whose name is its encoded row identity."""

    materialization: Literal[SourceMaterialization.CAPTURED] = SourceMaterialization.CAPTURED
    source_id: str
    document_id: str
    primary_key: str
    primary_key_value: str
    columns: tuple[str, ...]
    values: tuple[str, ...]

    @model_validator(mode="after")
    def validate_record_identity(self) -> CSVRowSource:
        CSVRowInput.model_validate(self.model_dump(include=set(CSVRowInput.model_fields)))
        identity = csv_row_source_id(self.document_id, self.primary_key_value)
        if self.source_id != identity or self.name != identity:
            raise ValueError("CSV Source name and source_id must match the record identity")  # noqa: TRY003
        return self


class _CSVRowAdapter:
    input_class = CSVRowInput
    name = "csv-row"
    source_class = CSVRowSource

    async def resolve(self, value: CSVRowInput, /) -> CSVRowSource:
        identity = csv_row_source_id(value.document_id, value.primary_key_value)
        return CSVRowSource(name=identity, source_id=identity, **value.model_dump())

    async def read(self, source: CSVRowSource, /) -> CSVRowInput:
        return CSVRowInput.model_validate(source.model_dump(include=set(CSVRowInput.model_fields)))


class _CSVRowTextEvidenceProjection:
    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = CSVRowSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: CSVRowSource, /) -> TextEvidence:
        row = dict(zip(source.columns, source.values, strict=True))
        return TextEvidence(
            source_type="csv-row",
            source_id=source.source_id,
            content=json.dumps(row, ensure_ascii=False, separators=(",", ":")),
            metadata={
                "document_id": source.document_id,
                "primary_key": source.primary_key,
                "primary_key_value": source.primary_key_value,
                "columns": list(source.columns),
                "row": row,
            },
        )


CSV_ROW_SOURCE_DEFINITION: SourceDefinition[CSVRowInput, CSVRowSource, CSVRowInput] = AdapterSourceDefinition(
    _CSVRowAdapter(), projections=(_CSVRowTextEvidenceProjection(),)
)

__all__ = [
    "CSV_ROW_SOURCE_DEFINITION",
    "CSVDocumentInput",
    "CSVRowInput",
    "CSVRowSource",
    "csv_row_source_id",
    "parse_csv_document",
]
