export const IMPORT_LIMITS = Object.freeze({
  maxFiles: 8,
  maxFileBytes: 10 * 1024 * 1024,
  maxCharacters: 300_000,
  maxPdfPages: 200,
  chunkCharacters: 420,
});

export function decodeUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    throw new Error('文本文件不是有效的 UTF-8，请转换编码后重试。');
  }
}

export function normalizeExtractedText(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function assertImportText(text) {
  if (!text || !text.trim()) {
    throw new Error('未提取到文字。空白文件或扫描 PDF 不会产生空文献；扫描件请先进行 OCR。');
  }
  if (text.length > IMPORT_LIMITS.maxCharacters) {
    throw new Error(`提取文本超过 ${IMPORT_LIMITS.maxCharacters.toLocaleString('zh-CN')} 字符限制。`);
  }
}

export function paragraphsFromText(source, { pageNumber = null, sourceOffset = 0, firstParagraph = 1 } = {}) {
  const normalized = source.replace(/\r\n?/g, '\n');
  const paragraphs = [];
  const separator = /\n[ \t]*\n+/g;
  let cursor = 0;
  let paragraphIndex = firstParagraph;

  const append = (rawStart, rawEnd) => {
    const raw = normalized.slice(rawStart, rawEnd);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const start = rawStart + leading;
    const end = rawEnd - trailing;
    if (end <= start) return;
    paragraphs.push({
      text: normalized.slice(start, end),
      start: sourceOffset + start,
      end: sourceOffset + end,
      pageNumber,
      paragraphIndex: paragraphIndex++,
    });
  };

  for (const match of normalized.matchAll(separator)) {
    append(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  append(cursor, normalized.length);
  return paragraphs;
}

function findChunkBoundary(text, start, hardEnd) {
  const minimum = start + Math.floor((hardEnd - start) * 0.55);
  const window = text.slice(minimum, hardEnd);
  let boundary = -1;

  for (const match of window.matchAll(/[。！？!?；;\n]/g)) {
    boundary = minimum + match.index + 1;
  }
  if (boundary > start) return boundary;

  for (const match of window.matchAll(/\s/g)) {
    boundary = minimum + match.index;
  }
  return boundary > start ? boundary : hardEnd;
}

export function chunkParagraph(paragraph, firstChunkIndex = 1, maxCharacters = IMPORT_LIMITS.chunkCharacters) {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 40) {
    throw new Error('切片长度必须是大于等于 40 的整数。');
  }

  const chunks = [];
  let cursor = paragraph.start;
  while (cursor < paragraph.end) {
    while (cursor < paragraph.end && /\s/.test(paragraph.text[cursor - paragraph.start])) cursor += 1;
    if (cursor >= paragraph.end) break;

    const remaining = paragraph.end - cursor;
    const hardEnd = remaining <= maxCharacters ? paragraph.end : cursor + maxCharacters;
    let chunkEnd = remaining <= maxCharacters
      ? paragraph.end
      : findChunkBoundary(paragraph.text, cursor - paragraph.start, hardEnd - paragraph.start) + paragraph.start;

    while (chunkEnd > cursor && /\s/.test(paragraph.text[chunkEnd - paragraph.start - 1])) chunkEnd -= 1;
    if (chunkEnd <= cursor) chunkEnd = hardEnd;

    chunks.push({
      text: paragraph.text.slice(cursor - paragraph.start, chunkEnd - paragraph.start),
      start: cursor,
      end: chunkEnd,
      paragraphStart: paragraph.start,
      paragraphEnd: paragraph.end,
      paragraphIndex: paragraph.paragraphIndex,
      pageNumber: paragraph.pageNumber,
      chunkIndex: firstChunkIndex + chunks.length,
    });
    cursor = Math.max(chunkEnd, cursor + 1);
  }
  return chunks;
}

export function createChunks(paragraphs) {
  const chunks = [];
  for (const paragraph of paragraphs) {
    chunks.push(...chunkParagraph(paragraph, chunks.length + 1));
  }
  return chunks;
}

export function titleFromFilename(filename) {
  return filename.replace(/\.(?:pdf|md|markdown|txt)$/i, '').trim() || filename;
}
