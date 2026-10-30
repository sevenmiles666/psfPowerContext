import express from "express";
import multer from "multer";
import { readFile } from "node:fs/promises";
import { resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkPages, documentId, validateQuery } from "./text.mjs";
import { modelInfo } from "./embedding.mjs";
import * as store from "./store.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const app = express();
app.disable("x-powered-by");
// This is a single-user localhost workspace. Reject cross-site mutations and DNS rebinding.
app.use("/api", (req, res, next) => {
  const host = req.hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
    return res.status(403).json({ error: "请通过本机地址访问" });
  if (
    req.headers.origin &&
    ![
      "http://127.0.0.1:8790",
      "http://localhost:8790",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      `http://127.0.0.1:${process.env.PORT || 8790}`,
      `http://localhost:${process.env.PORT || 8790}`,
    ].includes(req.headers.origin)
  )
    return res.status(403).json({ error: "不允许跨站操作" });
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "100kb" }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 8, fileSize: 10 * 1024 * 1024 },
});
const engine = await store.connect();
async function parseFile(buffer, filename) {
  const extension = extname(filename).toLowerCase();
  let pages, kind;
  if (extension === ".pdf") {
    kind = "PDF";
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      isEvalSupported: false,
    }).promise;
    try {
      if (pdf.numPages > 200) throw new Error("单个 PDF 最多支持 200 页");
      pages = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        pages.push({
          page: number,
          text: content.items
            .map((item) => item.str + (item.hasEOL ? "\n" : " "))
            .join("")
            .trim(),
        });
        page.cleanup();
      }
    } finally {
      await pdf.destroy();
    }
  } else if ([".txt", ".md", ".markdown"].includes(extension)) {
    kind = extension === ".txt" ? "TXT" : "Markdown";
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error("文本请保存为 UTF-8 编码后再导入");
    }
    if (text.includes("\0")) throw new Error("文件不是有效文本");
    pages = [{ page: 0, text }];
  } else throw new Error("仅支持 PDF、Markdown 和 TXT");
  const length = pages.reduce((sum, p) => sum + p.text.length, 0);
  if (!length) throw new Error("未提取到文字。扫描 PDF 需先进行 OCR");
  if (length > 300000)
    throw new Error("单个文件最多支持 30 万字符，请拆分导入");
  const chunks = chunkPages(pages);
  if (!chunks.length) throw new Error("文件没有可检索的文字内容");
  const heading =
    kind === "Markdown" ? pages[0].text.match(/^#\s+(.+)$/m)?.[1] : null;
  return {
    id: documentId(buffer),
    title: (heading || basename(filename, extension)).slice(0, 300),
    filename: filename.slice(0, 300),
    kind,
    pages,
    chunks,
  };
}

app.get("/api/health", async (req, res) =>
  res.json({
    ...engine,
    model: modelInfo(),
    documents: (await store.serial(store.documents)).length,
  }),
);
app.get("/api/documents", async (req, res) =>
  res.json(await store.serial(store.documents)),
);
app.post("/api/import", upload.array("files", 8), async (req, res) => {
  if (!req.files?.length)
    return res.status(400).json({ error: "请先选择文件" });
  const results = [];
  for (const file of req.files) {
    // Multer receives multipart filenames as Latin-1 on Node; browsers send UTF-8.
    const name = Buffer.from(file.originalname, "latin1").toString("utf8");
    try {
      const doc = await parseFile(file.buffer, name);
      results.push({
        filename: name,
        ...(await store.serial(() => store.importDocument(doc))),
      });
    } catch (error) {
      results.push({ filename: name, error: error.message });
    }
  }
  res.json({ results });
});
app.post("/api/samples", async (req, res) => {
  const results = [];
  for (const name of ["rag-notes.md", "hybrid-search.md", "evaluation.md"]) {
    const doc = await parseFile(
      await readFile(resolve(root, "samples", name)),
      name,
    );
    results.push(await store.serial(() => store.importDocument(doc)));
  }
  res.json({ results });
});
app.post("/api/search", async (req, res) =>
  res.json(await store.serial(() => store.search(validateQuery(req.body)))),
);
app.get("/api/passages/:id", async (req, res) => {
  if (!/^[a-f0-9]{32}_\d{1,5}$/.test(req.params.id))
    return res.status(400).json({ error: "片段编号无效" });
  const item = await store.serial(() => store.passage(req.params.id));
  if (!item) return res.status(404).json({ error: "原文不存在" });
  res.json(item);
});
app.get("/api/bookmarks", async (req, res) =>
  res.json(await store.serial(store.bookmarks)),
);
app.put("/api/bookmarks/:id", async (req, res) => {
  if (
    !/^[a-f0-9]{32}_\d{1,5}$/.test(req.params.id) ||
    typeof req.body.saved !== "boolean"
  )
    return res.status(400).json({ error: "收藏参数无效" });
  res.json(
    await store.serial(() => store.bookmark(req.params.id, req.body.saved)),
  );
});
app.get("/api/audit", async (req, res) =>
  res.json(await store.serial(store.recentAudit)),
);
app.use("/api", (req, res) => res.status(404).json({ error: "接口不存在" }));
app.use(express.static(resolve(root, "dist")));
app.get("/", (req, res) => res.sendFile(resolve(root, "dist/index.html")));
app.use((error, req, res, next) => {
  console.error(error.message);
  res
    .status(400)
    .json({
      error:
        error.code === "LIMIT_FILE_SIZE"
          ? "单个文件不能超过 10 MiB"
          : error.message || "操作未完成",
    });
});
const server = app.listen(Number(process.env.PORT || 8790), "127.0.0.1", () =>
  console.log("知页 http://127.0.0.1:" + (process.env.PORT || 8790)),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(async () => {
      await store.close();
      process.exit(0);
    }),
  );
