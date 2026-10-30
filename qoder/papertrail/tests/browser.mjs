import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { baseUrl } from './http.mjs';

const state = JSON.parse(await readFile(new URL('../.data/verification-state.json', import.meta.url), 'utf8'));
const screenshots = new URL('../docs/screenshots/', import.meta.url);
const downloads = new URL('../.data/browser-downloads/', import.meta.url);
await mkdir(screenshots, { recursive: true });
await mkdir(downloads, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
const checks = [];
const consoleErrors = [];
const pageErrors = [];
const pass = (name, condition, detail = null) => {
  assert.ok(condition, name);
  checks.push({ name, status: 'passed', detail });
  console.log(`PASS ${name}`);
};
const screenshot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name, screenshots)), fullPage: false });

async function search(page, query, { mode = '关键词检索', documentId } = {}) {
  await page.getByTestId('search-input').fill(query);
  await page.getByRole('button', { name: mode, exact: true }).click();
  if (documentId !== undefined) await page.getByLabel('限定文献').selectOption(documentId);
  await page.getByTestId('search-submit').click();
  await page.getByTestId('result-list').waitFor({ state: 'visible', timeout: 120_000 });
}

async function saveDownload(download, filename) {
  const path = fileURLToPath(new URL(filename, downloads));
  await download.saveAs(path);
  return readFile(path, 'utf8');
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByTestId('library-switcher').selectOption(state.primaryLibraryId);
  await search(page, '幻觉', { documentId: state.ragDocumentId });
  const firstResult = page.getByTestId('result-item').first();
  const firstText = await firstResult.locator('.result-text').textContent();
  const highlighted = await page.locator('.source-paragraph mark').textContent();
  pass('桌面检索与原文片段精确高亮', firstText === highlighted && (await firstResult.getAttribute('data-chunk-id')) === state.persistedBookmarkId, { id: state.persistedBookmarkId });
  await screenshot(page, 'search-desktop.png');

  await page.getByRole('button', { name: '复制引用', exact: true }).click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  pass('复制引用包含逐字原文、文件名和稳定 ID', clipboard.includes(firstText) && clipboard.includes('rag-basics.md') && clipboard.includes(state.persistedBookmarkId), { length: clipboard.length });

  const resultDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-results').click();
  const resultMarkdown = await saveDownload(await resultDownloadPromise, 'search-results.md');
  pass('检索结果真实导出 Markdown', resultMarkdown.includes('幻觉') && resultMarkdown.includes(state.persistedBookmarkId) && resultMarkdown.includes(firstText), { bytes: resultMarkdown.length });

  const bookmarkButton = firstResult.locator('.bookmark-button');
  if (await bookmarkButton.getAttribute('aria-pressed') === 'true') {
    await bookmarkButton.click();
    await page.waitForFunction((id) => document.querySelector(`[data-chunk-id="${id}"] .bookmark-button`)?.getAttribute('aria-pressed') === 'false', state.persistedBookmarkId);
  }
  await bookmarkButton.click();
  await page.waitForFunction((id) => document.querySelector(`[data-chunk-id="${id}"] .bookmark-button`)?.getAttribute('aria-pressed') === 'true', state.persistedBookmarkId);
  pass('收藏与取消收藏均调用真实 API', await bookmarkButton.getAttribute('aria-pressed') === 'true', state.persistedBookmarkId);

  await page.getByTestId('library-switcher').selectOption(state.secondaryLibraryId);
  await page.getByRole('button', { name: '我的文献', exact: true }).click();
  await page.locator('[data-testid="document-row"]').first().waitFor();
  const secondaryText = await page.locator('.document-list').textContent();
  pass('浏览器切换资料库不显示他库或已删除文献', secondaryText.includes('isolation-notes.txt') && !secondaryText.includes('rag-basics.md'), { libraryId: state.secondaryLibraryId });
  await page.getByTestId('library-switcher').selectOption(state.primaryLibraryId);

  const browserUpload = `自编浏览器验收资料\n\nBROWSERUPLOADMARK 这段文字由 Playwright 真实上传。<script>window.__browserUploadXss=1</script>\n\n用于验证上传、去重和删除界面。`;
  await page.getByRole('button', { name: '我的文献', exact: true }).click();
  const beforeUploadRows = await page.locator('[data-testid="document-row"]').count();
  await page.getByRole('button', { name: '导入资料', exact: true }).first().click();
  await page.getByTestId('file-input').setInputFiles({ name: '浏览器上传.md', mimeType: 'text/markdown', buffer: Buffer.from(browserUpload) });
  await page.getByTestId('upload-submit').click();
  await page.getByTestId('import-results').getByText('已导入', { exact: false }).waitFor({ timeout: 120_000 });
  pass('浏览器上传 Markdown 并显示单文件结果', (await page.getByTestId('import-results').textContent()).includes('浏览器上传.md'), { beforeUploadRows });
  await page.getByRole('button', { name: '关闭导入资料', exact: true }).click();
  const uploadRow = page.locator('[data-testid="document-row"]').filter({ hasText: '浏览器上传.md' });
  await uploadRow.waitFor();
  pass('上传后文献列表真实刷新', await page.locator('[data-testid="document-row"]').count() === beforeUploadRows + 1, { after: beforeUploadRows + 1 });

  await page.getByRole('button', { name: '导入资料', exact: true }).first().click();
  await page.getByTestId('file-input').setInputFiles({ name: '浏览器上传.md', mimeType: 'text/markdown', buffer: Buffer.from(browserUpload) });
  await page.getByTestId('upload-submit').click();
  await page.getByTestId('import-results').getByText('内容摘要已存在', { exact: false }).waitFor({ timeout: 120_000 });
  pass('浏览器重复上传显示去重结果', (await page.getByTestId('import-results').textContent()).includes('已跳过'), { filename: '浏览器上传.md' });
  await page.getByRole('button', { name: '关闭导入资料', exact: true }).click();

  await page.getByRole('button', { name: '新建资料库', exact: true }).click();
  const browserLibraryName = `浏览器验收-${Date.now()}`;
  await page.getByTestId('library-name').fill(browserLibraryName);
  await page.getByTestId('create-library').click();
  await page.getByText('当前资料库还没有可检索的文献', { exact: false }).waitFor();
  pass('浏览器创建空资料库并显示诚实空状态', (await page.getByTestId('library-switcher').inputValue()) !== state.primaryLibraryId, browserLibraryName);
  await page.getByTestId('library-switcher').selectOption(state.primaryLibraryId);

  await search(page, 'XSSMARK', { documentId: state.escapeDocumentId });
  pass('React 将导入 HTML 作为文本而非脚本执行', (await page.locator('.result-text').textContent()).includes('<script>') && await page.evaluate(() => window.__papertrailXss === undefined && window.__browserUploadXss === undefined), { documentId: state.escapeDocumentId });

  await page.getByRole('button', { name: '查看检索记录', exact: false }).click();
  await page.locator('.audit-record').first().waitFor();
  const auditDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-audit').click();
  const auditJson = await saveDownload(await auditDownloadPromise, 'audit.json');
  pass('浏览器导出含真实模型与结果 ID 的审计 JSON', auditJson.includes(state.primaryLibraryId) && auditJson.includes('modelSignature') && auditJson.includes('resultIds'), { bytes: auditJson.length });
  await page.getByRole('button', { name: '关闭真实操作记录', exact: true }).click();

  await page.getByRole('button', { name: /阅读清单/ }).click();
  await page.locator('[data-testid="bookmark-item"]').first().waitFor();
  pass('刷新后的阅读清单仍含持久收藏', (await page.locator('[data-testid="bookmark-item"]').first().textContent()).includes('rag-basics'), state.persistedBookmarkId);
  const readingDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出清单', exact: true }).click();
  const readingMarkdown = await saveDownload(await readingDownloadPromise, 'reading-list.md');
  pass('阅读清单真实导出', readingMarkdown.includes(state.persistedBookmarkId), { bytes: readingMarkdown.length });

  await page.getByRole('button', { name: '我的文献', exact: true }).click();
  const deleteRow = page.locator('[data-testid="document-row"]').filter({ hasText: '浏览器上传.md' });
  await deleteRow.getByRole('button', { name: /删除/ }).click();
  pass('删除确认明确显示资料库与目标文献', (await page.locator('.delete-warning').textContent()).includes(state.primaryLibraryName) && (await page.locator('.delete-warning').textContent()).includes('浏览器上传'), state.primaryLibraryName);
  await page.getByTestId('confirm-delete').click();
  await deleteRow.waitFor({ state: 'detached' });
  pass('浏览器确认后真实删除文献', await page.locator('[data-testid="document-row"]').filter({ hasText: '浏览器上传.md' }).count() === 0, { filename: '浏览器上传.md' });

  await page.getByRole('button', { name: '检索资料', exact: true }).click();
  await search(page, 'retrieval', { documentId: state.pdfDocumentId });
  pass('浏览器展示 PDF 第 2 页来源', (await page.locator('.source-meta').textContent()).includes('第 2 页'), state.pdfChunkId);
  await context.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await mobileContext.newPage();
  mobile.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  mobile.on('pageerror', (error) => pageErrors.push(error.message));
  await mobile.goto(baseUrl, { waitUntil: 'networkidle' });
  await mobile.getByTestId('library-switcher').selectOption(state.primaryLibraryId);
  await search(mobile, '幻觉', { documentId: state.ragDocumentId });
  await mobile.evaluate(() => window.scrollTo(0, 0));
  const items = mobile.getByTestId('result-item');
  if (await items.count() > 1) await items.nth(1).getByTestId('view-source').click();
  else await items.first().getByTestId('view-source').click();
  await mobile.locator('.source-paragraph mark').waitFor();
  await mobile.waitForFunction(() => {
    const preview = document.querySelector('.source-preview');
    const rect = preview.getBoundingClientRect();
    return rect.top >= -4 && rect.top <= 100 && rect.bottom > window.innerHeight / 2 && window.scrollY > 0;
  });
  pass('手机原文加载完成后滚动到可见位置', true, { viewport: [390, 844] });
  await screenshot(mobile, 'source-mobile.png');
  await mobile.evaluate(() => window.scrollTo(0, 0));
  pass('390px 手机布局无横向溢出', await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), await mobile.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })));
  await screenshot(mobile, 'search-mobile.png');
  await mobileContext.close();

  pass('浏览器控制台与页面无脚本错误', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors, pageErrors });
  await writeFile(new URL('../evidence/browser.json', import.meta.url), JSON.stringify({ status: 'passed', verifiedAt: new Date().toISOString(), checks, consoleErrors, pageErrors }, null, 2));
  console.log(`Browser verification passed: ${checks.length} checks.`);
} catch (error) {
  await writeFile(new URL('../evidence/browser.json', import.meta.url), JSON.stringify({ status: 'failed', failedAt: new Date().toISOString(), checks, consoleErrors, pageErrors, error: { message: error.message, stack: error.stack } }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
