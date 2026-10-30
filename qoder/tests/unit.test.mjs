import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkPages,
  documentId,
  validateQuery,
  citation,
} from "../server/text.mjs";

test("chunking preserves page and paragraph across blank lines and CRLF", () => {
  const chunks = chunkPages([
    { page: 2, text: "第一段。\r\n\r\n第二段。" },
    { page: 3, text: "下一页。" },
  ]);
  assert.deepEqual(
    chunks.map((c) => [c.page, c.paragraph, c.text]),
    [
      [2, 1, "第一段。"],
      [2, 2, "第二段。"],
      [3, 1, "下一页。"],
    ],
  );
});
test("long paragraph is split without gaps or loss", () => {
  const text = "甲乙丙丁。".repeat(250);
  const chunks = chunkPages([{ page: 1, text }], 100);
  assert.equal(chunks.map((c) => c.text).join(""), text);
  assert.ok(chunks.every((c) => c.text.length <= 101 && c.paragraph === 1));
  assert.equal(chunks.at(-1).offset + chunks.at(-1).text.length, text.length);
});
test("empty text never produces an index entry", () =>
  assert.deepEqual(chunkPages([{ page: 1, text: " \n\n " }]), []));
test("content hash deduplicates independently of filename", () => {
  assert.equal(
    documentId(Buffer.from("same")),
    documentId(Buffer.from("same")),
  );
  assert.notEqual(
    documentId(Buffer.from("same")),
    documentId(Buffer.from("different")),
  );
});
test("query validation rejects invalid mode, ID and oversized queries", () => {
  for (const input of [
    { query: "", mode: "hybrid" },
    { query: "x", mode: "fake" },
    { query: "x".repeat(501), mode: "semantic" },
    { query: "x", mode: "hybrid", documentId: "' OR 1=1" },
  ])
    assert.throws(() => validateQuery(input));
  assert.deepEqual(validateQuery({ query: "  幻觉  ", mode: "keyword" }), {
    query: "幻觉",
    mode: "keyword",
    documentId: null,
  });
});
test("citation contains original source, locator, text and stable passage ID", () => {
  const text = citation({
    title: "测试文献",
    filename: "test.pdf",
    page: 2,
    paragraph: 1,
    part: 3,
    text: "原文",
    id: "abc_3",
  });
  assert.match(text, /第 2 页/);
  assert.match(text, /第 1 段/);
  assert.match(text, /“原文”/);
  assert.match(text, /PaperTrail:abc_3/);
});
