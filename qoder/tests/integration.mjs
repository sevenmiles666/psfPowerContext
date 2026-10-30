import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8790";
const checks = [];
async function request(path, data, method = "POST") {
  const response = await fetch(base + "/api" + path, {
    method,
    ...(data === undefined
      ? {}
      : {
          body: data instanceof FormData ? data : JSON.stringify(data),
          headers:
            data instanceof FormData
              ? {}
              : { "Content-Type": "application/json" },
        }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${value.error}`);
  return value;
}
async function check(name, fn) {
  await fn();
  checks.push({ name, passed: true });
  console.log("PASS", name);
}
if (process.argv.includes("--check-persistence")) {
  const state = JSON.parse(
    await readFile(".data/verification-state.json", "utf8"),
  );
  await check(
    "documents and bookmarks survive application restart",
    async () => {
      const docs = await request("/documents", undefined, "GET");
      assert.ok(docs.some((d) => d.id === state.documentId));
      const marks = await request("/bookmarks", undefined, "GET");
      assert.ok(marks.some((m) => m.id === state.passageId));
      const source = await request(
        "/passages/" + state.passageId,
        undefined,
        "GET",
      );
      assert.ok(source.pages.length);
    },
  );
  await mkdir("evidence", { recursive: true });
  await writeFile(
    "evidence/persistence.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        checks,
        documentId: state.documentId,
        passageId: state.passageId,
      },
      null,
      2,
    ),
  );
} else {
  const health = await request("/health", undefined, "GET");
  assert.match(health.version, /seekdb/i);
  let docs, passageId, source, searchTrace;
  await check(
    "sample import persists paragraphs in actual seekdb",
    async () => {
      const value = await request("/samples");
      assert.equal(value.results.length, 3);
      assert.ok(value.results.every((r) => r.id && !r.error));
      docs = await request("/documents", undefined, "GET");
      assert.ok(docs.some((d) => d.title === "RAG 实践笔记" && d.chunks >= 4));
    },
  );
  await check("identical files are not indexed twice", async () => {
    const before = await request("/documents", undefined, "GET");
    const again = await request("/samples");
    assert.ok(again.results.every((r) => r.duplicate));
    const after = await request("/documents", undefined, "GET");
    assert.equal(after.length, before.length);
    assert.equal(
      after.reduce((n, d) => n + d.chunks, 0),
      before.reduce((n, d) => n + d.chunks, 0),
    );
  });
  const modeResults = {};
  for (const mode of ["hybrid", "semantic", "keyword"])
    await check(`${mode} returns original supporting passages`, async () => {
      const value = await request("/search", {
        query: mode === "semantic" ? "如何避免模型编造事实" : "幻觉",
        mode,
      });
      assert.ok(value.results.length > 0);
      assert.ok(value.results.some((r) => /幻觉|编造/.test(r.text)));
      assert.equal(value.trace.engine, "seekdb");
      assert.ok(value.results.every((r) => r.citation.includes(r.text)));
      modeResults[mode] = value;
      if (mode === "hybrid") {
        passageId = value.results[0].id;
        searchTrace = value.trace;
      }
    });
  await check(
    "metadata filter is applied to all three retrieval modes",
    async () => {
      const id = docs.find((d) => d.title === "RAG 实践笔记").id;
      for (const mode of ["hybrid", "semantic", "keyword"]) {
        const value = await request("/search", {
          query: "幻觉",
          mode,
          documentId: id,
        });
        assert.ok(value.results.length > 0);
        assert.ok(value.results.every((r) => r.documentId === id));
      }
    },
  );
  await check("keyword miss is empty rather than fabricated", async () => {
    const value = await request("/search", {
      query: "unfindablezzzz987654321",
      mode: "keyword",
    });
    assert.deepEqual(value.results, []);
  });
  await check(
    "source preview includes full source and exact passage location",
    async () => {
      source = await request("/passages/" + passageId, undefined, "GET");
      assert.ok(source.pages.some((p) => p.text.includes(source.text)));
      assert.ok(source.paragraph >= 1 && source.part >= 1);
    },
  );
  await check("bookmark set is idempotent and removal works", async () => {
    await request("/bookmarks/" + passageId, { saved: true }, "PUT");
    await request("/bookmarks/" + passageId, { saved: true }, "PUT");
    assert.equal(
      (await request("/bookmarks", undefined, "GET")).filter(
        (r) => r.id === passageId,
      ).length,
      1,
    );
    await request("/bookmarks/" + passageId, { saved: false }, "PUT");
    assert.ok(
      !(await request("/bookmarks", undefined, "GET")).some(
        (r) => r.id === passageId,
      ),
    );
    await request("/bookmarks/" + passageId, { saved: true }, "PUT");
  });
  // Minimal valid two-page PDF fixture: tests extraction/page numbering, not a generated UI mock.
  function pdfFixture() {
    const stream = (text) => `BT /F1 12 Tf 40 750 Td (${text}) Tj ET`;
    const streams = [
      stream("Research verification page one."),
      stream(
        "PaperTrail page two discusses hybrid retrieval and source citations.",
      ),
    ];
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      ...[5, 6].map(
        (id) =>
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${id} 0 R >>`,
      ),
      ...streams.map(
        (s) => `<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`,
      ),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((obj, i) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join(
        "",
      )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf);
  }
  await check(
    "PDF import and page-2 citation reflect extracted PDF text",
    async () => {
      const form = new FormData();
      form.append(
        "files",
        new Blob([pdfFixture()], { type: "application/pdf" }),
        "verification-two-pages.pdf",
      );
      const value = await request("/import", form);
      assert.ok(!value.results[0].error, value.results[0].error);
      const result = await request("/search", {
        query: "retrieval",
        mode: "keyword",
        documentId: value.results[0].id,
      });
      assert.ok(result.results.length > 0);
      assert.equal(result.results[0].page, 2);
      assert.match(result.results[0].citation, /第 2 页/);
    },
  );
  await check(
    "unsupported and empty files report individual errors",
    async () => {
      const form = new FormData();
      form.append("files", new Blob(["bad"]), "bad.exe");
      form.append("files", new Blob(["   "]), "empty.txt");
      const value = await request("/import", form);
      assert.ok(value.results.every((r) => r.error));
    },
  );
  await check("untrusted HTML is preserved as text in storage", async () => {
    const form = new FormData();
    const content =
      "<script>window.__papertrail_xss=1</script>\n\n验证引用与界面转义。";
    form.append("files", new Blob([content]), "verification-escape.txt");
    const value = await request("/import", form);
    assert.ok(!value.results[0].error);
    const result = await request("/search", {
      query: "script",
      mode: "keyword",
      documentId: value.results[0].id,
    });
    assert.ok(result.results.some((r) => r.text.includes("<script>")));
  });
  await check("bad queries and foreign origins are rejected", async () => {
    const r = await fetch(base + "/api/search", {
      method: "POST",
      body: JSON.stringify({ query: "", mode: "hybrid" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(r.status, 400);
    const foreign = await fetch(base + "/api/samples", {
      method: "POST",
      headers: { Origin: "https://example.com" },
    });
    assert.equal(foreign.status, 403);
  });
  const audit = await request("/audit", undefined, "GET");
  await check(
    "seekdb audit records real candidate IDs and retrieval operations",
    async () => {
      const record = audit.find((r) => r.id === searchTrace.id);
      assert.ok(record);
      assert.ok(record.detail.resultIds.includes(passageId));
      assert.match(record.detail.operation, /RRF/);
    },
  );
  await mkdir(".data", { recursive: true });
  await writeFile(
    ".data/verification-state.json",
    JSON.stringify({ documentId: source.documentId, passageId }),
  );
  await mkdir("evidence", { recursive: true });
  // Only self-authored samples and test fixture results; no user documents or credentials.
  await writeFile(
    "evidence/verification.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        kind: "local functional verification, not user impact metrics",
        health,
        checks,
        modeResults,
        source: {
          id: source.id,
          title: source.title,
          paragraph: source.paragraph,
          citation: source.citation,
        },
        audit: audit.filter((r) => r.id === searchTrace.id),
      },
      null,
      2,
    ),
  );
  console.log(`Verified ${checks.length} checks against ${health.version}`);
}
