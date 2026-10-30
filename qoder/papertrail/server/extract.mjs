import {
  IMPORT_LIMITS,
  assertImportText,
  createChunks,
  decodeUtf8,
  normalizeExtractedText,
  paragraphsFromText,
} from './text.mjs';

function pageLines(items) {
  let output = '';
  let previousY = null;
  for (const item of items) {
    if (!('str' in item)) continue;
    const y = item.transform?.[5] ?? previousY;
    const newLine = previousY !== null && y !== null && Math.abs(y - previousY) > 2;
    if (output && newLine && !output.endsWith('\n')) output += '\n';
    else if (output && !newLine && item.str && !/\s$/.test(output) && !/^\s/.test(item.str)) output += ' ';
    output += item.str;
    if (item.hasEOL && !output.endsWith('\n')) output += '\n';
    previousY = y;
  }
  return output;
}

async function extractPdf(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let loadingTask;
  let pdf;
  try {
    loadingTask = getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    pdf = await loadingTask.promise;
  } catch (error) {
    throw new Error(`PDF 无法解析：${error.message}`);
  }

  try {
    if (pdf.numPages > IMPORT_LIMITS.maxPdfPages) {
      throw new Error(`PDF 共 ${pdf.numPages} 页，超过 ${IMPORT_LIMITS.maxPdfPages} 页限制。`);
    }

    let source = '';
    const paragraphs = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = normalizeExtractedText(pageLines(content.items));
      page.cleanup();
      if (!pageText) continue;

      const sourceOffset = source.length + (source ? 2 : 0);
      source += `${source ? '\n\n' : ''}${pageText}`;
      const extracted = paragraphsFromText(pageText, {
        pageNumber,
        sourceOffset,
        firstParagraph: paragraphs.length + 1,
      });
      paragraphs.push(...extracted);
    }

    assertImportText(source);
    return { source, paragraphs, pageCount: pdf.numPages, kind: 'PDF' };
  } finally {
    await loadingTask.destroy();
  }
}

export async function extractDocument(file) {
  const extension = file.originalname.split('.').pop()?.toLowerCase();
  if (!['pdf', 'md', 'markdown', 'txt'].includes(extension)) {
    throw new Error('仅支持 PDF、Markdown 和 TXT 文件。');
  }
  if (!file.buffer?.length) throw new Error('文件为空，请选择包含文字的资料。');

  const extracted = extension === 'pdf'
    ? await extractPdf(file.buffer)
    : {
        source: normalizeExtractedText(decodeUtf8(file.buffer)),
        pageCount: null,
        kind: extension === 'txt' ? 'TXT' : 'Markdown',
      };

  if (extension !== 'pdf') {
    assertImportText(extracted.source);
    extracted.paragraphs = paragraphsFromText(extracted.source);
  }

  const chunks = createChunks(extracted.paragraphs);
  if (!chunks.length) throw new Error('未生成文本片段，请检查文件内容。');
  return { ...extracted, chunks };
}
