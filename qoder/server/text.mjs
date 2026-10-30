import { createHash } from "node:crypto";

export function chunkPages(pages, maxLength = 420) {
  const chunks = [];
  for (const { page, text } of pages) {
    const paragraphs = text
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const [paragraph, content] of paragraphs.entries()) {
      // Keep offsets into extracted page text for reproducible source locations.
      for (let offset = 0; offset < content.length; ) {
        let end = Math.min(offset + maxLength, content.length);
        if (end < content.length) {
          const boundary = Math.max(
            content.lastIndexOf("。", end),
            content.lastIndexOf(". ", end),
            content.lastIndexOf("\n", end),
          );
          if (boundary > offset + maxLength / 2) end = boundary + 1;
        }
        const part = content.slice(offset, end).trim();
        if (part)
          chunks.push({
            text: part,
            page,
            paragraph: paragraph + 1,
            offset,
            part: chunks.length + 1,
          });
        offset = end;
      }
    }
  }
  return chunks;
}

export function documentId(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 32);
}
export function citation(item) {
  return `《${item.title}》 · ${item.filename} · ${item.page ? `第 ${item.page} 页，` : ""}第 ${item.paragraph} 段（片段 ${item.part}）\n“${item.text}”\n[PaperTrail:${item.id}]`;
}
export function validateQuery(input) {
  if (
    typeof input.query !== "string" ||
    !input.query.trim() ||
    input.query.trim().length > 500
  )
    throw new Error("查询需为 1–500 个字符");
  if (!["hybrid", "semantic", "keyword"].includes(input.mode))
    throw new Error("请选择有效的检索模式");
  if (input.documentId && !/^[a-f0-9]{32}$/.test(input.documentId))
    throw new Error("资料编号无效");
  return {
    query: input.query.trim(),
    mode: input.mode,
    documentId: input.documentId || null,
  };
}
