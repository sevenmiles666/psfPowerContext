import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { libraryPath, request, uploadForm } from './http.mjs';
import { noTextPdf, twoPagePdf } from './fixtures.mjs';

const checks = [];
const startedAt = new Date().toISOString();
const pass = (name, condition, detail = null) => {
  assert.ok(condition, name);
  checks.push({ name, status: 'passed', detail });
  console.log(`PASS ${name}`);
};
const search = (libraryId, body) => request(libraryPath(libraryId, '/search'), { method: 'POST', body }).then((result) => result.data);
const documents = (libraryId) => request(libraryPath(libraryId, '/documents')).then((result) => result.data.documents);
const bookmarks = (libraryId) => request(libraryPath(libraryId, '/bookmarks')).then((result) => result.data.bookmarks);
const saveBookmark = (libraryId, chunkId, saved = true) => request(libraryPath(libraryId, `/bookmarks/${chunkId}`), { method: 'PUT', body: { saved } });
const evidenceUrl = new URL('../evidence/verification.json', import.meta.url);

try {
  const health = (await request('/api/health')).data;
  pass('真实 seekdb 1.4 与健康检查', health.database.engine === 'seekdb' && health.database.version.includes('1.4.0.0'), health.database);

  const suffix = `${Date.now()}`;
  const primary = (await request('/api/libraries', { method: 'POST', body: { name: `Qoder验收-RAG-${suffix}` }, expected: 201 })).data.library;
  const secondary = (await request('/api/libraries', { method: 'POST', body: { name: `Qoder验收-隔离-${suffix}` }, expected: 201 })).data.library;
  pass('创建两个独立主题资料库', primary.id !== secondary.id, { primary, secondary });

  const firstSamples = (await request(libraryPath(primary.id, '/samples'), { method: 'POST', body: {} })).data.results;
  pass('导入三份明确标注的自编样例', firstSamples.length === 3 && firstSamples.every((item) => item.status === 'imported' && item.chunkCount > 0), firstSamples.map((item) => ({ filename: item.filename, status: item.status, chunks: item.chunkCount })));
  const initialDocuments = await documents(primary.id);
  const initialCount = initialDocuments.length;
  const initialChunks = initialDocuments.reduce((sum, item) => sum + item.chunkCount, 0);
  const duplicateSamples = (await request(libraryPath(primary.id, '/samples'), { method: 'POST', body: {} })).data.results;
  const afterDuplicate = await documents(primary.id);
  pass('重复导入按内容摘要去重且不增加片段', duplicateSamples.every((item) => item.status === 'duplicate') && afterDuplicate.length === initialCount && afterDuplicate.reduce((sum, item) => sum + item.chunkCount, 0) === initialChunks, duplicateSamples.map((item) => ({ filename: item.filename, status: item.status })));

  const ragDocument = initialDocuments.find((item) => item.filename === 'rag-basics.md');
  const evidenceDocument = initialDocuments.find((item) => item.filename === 'evidence-notes.md');
  const modeTraces = {};
  let primaryKeyword;
  for (const mode of ['keyword', 'semantic', 'hybrid']) {
    const query = mode === 'keyword' ? '幻觉' : '如何避免模型编造事实？';
    const result = await search(primary.id, { query, mode });
    modeTraces[mode] = result.trace;
    pass(`${mode} 检索实际返回当前库片段`, result.results.length > 0 && result.results.every((item) => item.libraryId === primary.id), { count: result.results.length, trace: result.trace });
    if (mode === 'keyword') primaryKeyword = result;
    if (mode === 'hybrid') pass('混合检索记录数据库 RRF 参数与结果 ID', result.trace.rrf?.execution === 'seekdb DBMS_HYBRID_SEARCH' && result.trace.rrf.rankConstant === 60 && result.trace.resultIds.length === result.results.length, result.trace.rrf);

    const filtered = await search(primary.id, { query, mode, documentId: ragDocument.id });
    pass(`${mode} 检索严格限定指定文献`, filtered.results.length > 0 && filtered.results.every((item) => item.libraryId === primary.id && item.documentId === ragDocument.id), { count: filtered.results.length, documentId: ragDocument.id });
  }

  const noMatch = await search(primary.id, { query: 'unfindablezzzz987654321', mode: 'keyword' });
  pass('无关关键词诚实返回空结果', noMatch.results.length === 0, noMatch.trace);

  const firstSource = (await request(libraryPath(primary.id, `/passages/${primaryKeyword.results[0].id}`))).data.passage;
  pass('原文核对保留完整文件、定位与逐字偏移', firstSource.filename === 'rag-basics.md' && firstSource.sourceText.slice(firstSource.sourceStart, firstSource.sourceEnd) === firstSource.text && firstSource.citation.includes(firstSource.id), { id: firstSource.id, location: firstSource.location });

  const secondaryFiles = [
    { name: 'rag-basics.md', buffer: await (await import('node:fs/promises')).readFile(new URL('../samples/rag-basics.md', import.meta.url)) },
    { name: 'isolation-notes.txt', buffer: Buffer.from('自编隔离样例\n\nZEPHYRISOLATION7341 是第二资料库独有的识别词。\n\n植物观察笔记记录光照与浇水，不讨论检索增强生成。') },
  ];
  const secondaryImports = (await request(libraryPath(secondary.id, '/import'), { method: 'POST', form: uploadForm(secondaryFiles) })).data.results;
  pass('同一内容可独立存在于另一资料库', secondaryImports.every((item) => item.status === 'imported') && secondaryImports[0].documentId !== ragDocument.id, secondaryImports.map((item) => ({ filename: item.filename, documentId: item.documentId })));
  const secondaryDocuments = await documents(secondary.id);
  const secondaryRag = secondaryDocuments.find((item) => item.filename === 'rag-basics.md');
  const secondaryUnique = secondaryDocuments.find((item) => item.filename === 'isolation-notes.txt');

  for (const mode of ['keyword', 'semantic', 'hybrid']) {
    const isolated = await search(primary.id, { query: 'ZEPHYRISOLATION7341', mode });
    pass(`${mode} 不返回第二资料库片段`, isolated.results.every((item) => item.libraryId === primary.id && item.documentId !== secondaryUnique.id), { count: isolated.results.length, resultIds: isolated.trace.resultIds });
  }
  const uniqueResult = await search(secondary.id, { query: 'ZEPHYRISOLATION7341', mode: 'keyword' });
  pass('第二资料库可检索自己的独有资料', uniqueResult.results.length > 0 && uniqueResult.results.every((item) => item.documentId === secondaryUnique.id), uniqueResult.trace);

  const secondaryKeyword = await search(secondary.id, { query: '幻觉', mode: 'keyword', documentId: secondaryRag.id });
  await saveBookmark(primary.id, primaryKeyword.results[0].id);
  await saveBookmark(secondary.id, secondaryKeyword.results[0].id);
  pass('收藏按资料库隔离保存', (await bookmarks(primary.id)).some((item) => item.id === primaryKeyword.results[0].id) && (await bookmarks(secondary.id)).every((item) => item.libraryId === secondary.id), { primary: primaryKeyword.results[0].id, secondary: secondaryKeyword.results[0].id });

  const deleted = (await request(libraryPath(secondary.id, `/documents/${secondaryRag.id}`), { method: 'DELETE' })).data;
  pass('删除当前库文献并清理其收藏', deleted.deleted && !(await documents(secondary.id)).some((item) => item.id === secondaryRag.id) && !(await bookmarks(secondary.id)).some((item) => item.documentId === secondaryRag.id), deleted);
  const afterDeleteSearch = await search(secondary.id, { query: '幻觉', mode: 'keyword' });
  const primaryAfterDelete = await search(primary.id, { query: '幻觉', mode: 'keyword', documentId: ragDocument.id });
  pass('删除后索引不再返回且不影响另一库', afterDeleteSearch.results.length === 0 && primaryAfterDelete.results.length > 0 && (await bookmarks(primary.id)).some((item) => item.id === primaryKeyword.results[0].id), { secondary: afterDeleteSearch.trace.resultIds, primary: primaryAfterDelete.trace.resultIds });
  const repeatedDelete = (await request(libraryPath(secondary.id, `/documents/${secondaryRag.id}`), { method: 'DELETE' })).data;
  pass('重复删除返回幂等结果', repeatedDelete.alreadyDeleted && !repeatedDelete.deleted, repeatedDelete);
  const crossDelete = (await request(libraryPath(secondary.id, `/documents/${ragDocument.id}`), { method: 'DELETE' })).data;
  pass('不能使用第二资料库删除第一库文献', crossDelete.alreadyDeleted && (await documents(primary.id)).some((item) => item.id === ragDocument.id), crossDelete);

  const pdfImport = (await request(libraryPath(primary.id, '/import'), { method: 'POST', form: uploadForm([{ name: 'two-page-evidence.pdf', buffer: await twoPagePdf(), type: 'application/pdf' }]) })).data.results[0];
  pass('真实两页 PDF 导入并生成片段', pdfImport.status === 'imported' && pdfImport.chunkCount > 1, pdfImport);
  const pdfResult = await search(primary.id, { query: 'retrieval', mode: 'keyword', documentId: pdfImport.documentId });
  pass('PDF 引用准确定位第 2 页', pdfResult.results.length > 0 && pdfResult.results.every((item) => item.pageNumber === 2), pdfResult.results.map((item) => ({ id: item.id, page: item.pageNumber, chunk: item.chunkIndex })));
  const pdfSource = (await request(libraryPath(primary.id, `/passages/${pdfResult.results[0].id}`))).data.passage;
  pass('PDF 长段落片段与原文偏移一致', pdfSource.pageNumber === 2 && pdfSource.sourceText.slice(pdfSource.sourceStart, pdfSource.sourceEnd) === pdfSource.text && pdfSource.paragraphEnd > pdfSource.sourceEnd, { id: pdfSource.id, location: pdfSource.location });

  pass('长 Markdown 段落实际拆成多个片段', evidenceDocument.chunkCount > evidenceDocument.paragraphCount, { paragraphs: evidenceDocument.paragraphCount, chunks: evidenceDocument.chunkCount });
  const longResult = await search(primary.id, { query: '字符起止位置', mode: 'keyword', documentId: evidenceDocument.id });
  pass('长段落可按稳定片段编号定位', longResult.results.length > 0 && longResult.results[0].paragraphIndex > 0 && longResult.results[0].chunkIndex > 0, longResult.results.map((item) => ({ id: item.id, paragraph: item.paragraphIndex, chunk: item.chunkIndex })));

  const beforeInvalidCount = (await documents(primary.id)).length;
  const invalidFiles = [
    { name: 'unsupported.docx', buffer: Buffer.from('not a supported format') },
    { name: 'blank.md', buffer: Buffer.from(' \n\n\t') },
    { name: 'no-text.pdf', buffer: await noTextPdf(), type: 'application/pdf' },
    { name: 'too-long.txt', buffer: Buffer.from('a'.repeat(300_001)) },
  ];
  const invalidResults = (await request(libraryPath(primary.id, '/import'), { method: 'POST', form: uploadForm(invalidFiles) })).data.results;
  pass('不支持、空白、无文字 PDF 与超长文本均明确失败', invalidResults.length === 4 && invalidResults.every((item) => item.status === 'error' && item.error) && /OCR|未提取到文字/.test(invalidResults[2].error), invalidResults.map((item) => ({ filename: item.filename, error: item.error })));
  pass('失败导入不产生成功但零片段的文献', (await documents(primary.id)).length === beforeInvalidCount, { before: beforeInvalidCount, after: (await documents(primary.id)).length });

  const escapeText = '自编 HTML 转义样例\n\nXSSMARK <script>window.__papertrailXss = "executed"</script> <img src=x onerror="window.__papertrailXss=1"> 这段文字必须按纯文本显示。\n\n第二段用于核对中文文件名与稳定引用。';
  const escapeImport = (await request(libraryPath(primary.id, '/import'), { method: 'POST', form: uploadForm([{ name: '转义与定位样例.md', buffer: Buffer.from(escapeText) }]) })).data.results[0];
  pass('中文文件名与 HTML 测试文本真实导入', escapeImport.status === 'imported' && escapeImport.filename === '转义与定位样例.md', escapeImport);
  const escapeResult = await search(primary.id, { query: 'XSSMARK', mode: 'keyword', documentId: escapeImport.documentId });
  pass('转义样例可检索且原文保留标签字符串', escapeResult.results.length > 0 && escapeResult.results[0].text.includes('<script>'), { id: escapeResult.results[0]?.id, text: escapeResult.results[0]?.text });

  const audit = (await request(libraryPath(primary.id, '/audit'))).data.audit;
  const secondaryAudit = (await request(libraryPath(secondary.id, '/audit'))).data.audit;
  const hybridAudit = audit.find((item) => item.operation === 'search' && item.detail.mode === 'hybrid');
  pass('审计包含资料库、查询、模式、模型、结果 ID 与两类耗时', hybridAudit && hybridAudit.libraryId === primary.id && hybridAudit.detail.query && hybridAudit.detail.model.revision && hybridAudit.detail.resultIds.length > 0 && Number.isFinite(hybridAudit.detail.dbMs) && Number.isFinite(hybridAudit.detail.elapsedMs), hybridAudit);
  pass('真实导入、异常与删除均有可导出记录', ['import', 'search'].every((operation) => audit.some((item) => item.operation === operation)) && audit.some((item) => item.detail.status === 'error') && secondaryAudit.some((item) => item.operation === 'delete' && item.detail.status === 'deleted'), { primaryAuditCount: audit.length, secondaryAuditCount: secondaryAudit.length });

  const state = {
    createdAt: new Date().toISOString(),
    primaryLibraryId: primary.id,
    primaryLibraryName: primary.name,
    secondaryLibraryId: secondary.id,
    secondaryLibraryName: secondary.name,
    ragDocumentId: ragDocument.id,
    pdfDocumentId: pdfImport.documentId,
    pdfChunkId: pdfResult.results[0].id,
    escapeDocumentId: escapeImport.documentId,
    escapeChunkId: escapeResult.results[0].id,
    persistedBookmarkId: primaryKeyword.results[0].id,
    secondaryDeletedDocumentId: secondaryRag.id,
  };
  await mkdir(new URL('../.data/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.data/verification-state.json', import.meta.url), JSON.stringify(state, null, 2));
  const evidence = {
    status: 'passed',
    startedAt,
    completedAt: new Date().toISOString(),
    database: health.database,
    sampleDeclaration: 'All imported documents are self-authored teaching fixtures; none are represented as published papers or user-effect data.',
    state,
    checks,
  };
  await writeFile(evidenceUrl, JSON.stringify(evidence, null, 2));
  console.log(`Integration verification passed: ${checks.length} checks. Evidence: evidence/verification.json`);
} catch (error) {
  await writeFile(evidenceUrl, JSON.stringify({ status: 'failed', startedAt, failedAt: new Date().toISOString(), checks, error: { message: error.message, stack: error.stack } }, null, 2));
  console.error(error);
  process.exitCode = 1;
}
