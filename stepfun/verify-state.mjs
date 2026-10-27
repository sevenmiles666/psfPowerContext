import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.EVIDENCE_DIR || 'evidence/state';
await mkdir(output, { recursive: true });
const report = { started: new Date().toISOString(), checks: [], pageErrors: [], externalRequests: [] };
const origin = process.env.APP_URL || 'http://127.0.0.1:8788/';
const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : ['--enable-unsafe-webgpu'] });
let fallbackBrowser;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('blob:')) report.externalRequests.push(request.url()); });
  await page.goto(origin);
  await page.waitForFunction(() => window.localPages?.selected);
  const prefix = '验收 ' + new Date().toISOString().slice(0, 19);
  async function create(title) {
    await page.locator('#new-collection').click();
    await page.locator('#new-name').fill(title);
    await page.locator('#create-confirm').click();
    await page.waitForFunction(title => window.localPages.selected.title === title, title);
    return page.evaluate(() => window.localPages.selected);
  }
  async function upload(name, content, count) {
    await page.locator('#file').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
    await page.waitForFunction(expected => window.localPages.selected.count === expected && document.querySelector('#status').textContent.includes('索引刷新完成'), count, { timeout: 120000 });
  }
  const a = await create(prefix + ' 甲');
  await upload('灯塔.txt', 'The ultraviolet lighthouse sentinel records the evening tide every hour. The lighthouse uses an ultraviolet sensor to warn ships.', 1);
  await upload('月光.md', 'Moonlight observatory scientists count meteor showers every winter. They use a telescope to track bright meteors.', 2);
  await upload('灯塔.txt', 'The ultraviolet lighthouse sentinel records the evening tide every hour. The lighthouse uses an ultraviolet sensor to warn ships.', 2);
  report.checks.push('UI: continuous import and duplicate upsert keep count at two');
  const inA = await page.evaluate(() => window.localPages.search('ultraviolet lighthouse sentinel'));
  assert(inA.results.some(item => item.metadata.title === '灯塔'));
  report.checks.push('new data searchable after explicit index refresh');
  const b = await create(prefix + ' 乙');
  await upload('果园.txt', 'The cosmic orchard grows apples near a small river. Harvest ripe apples gently in the autumn.', 1);
  const inB = await page.evaluate(() => window.localPages.search('ultraviolet lighthouse sentinel'));
  assert(inB.results.length > 0 && inB.results.every(item => item.metadata.title === '果园'));
  report.checks.push('collection B never returns collection A documents');
  await page.reload();
  await page.waitForFunction(name => window.localPages?.selected?.name === name, b.name);
  assert.equal(await page.locator('#library-title').textContent(), b.title);
  report.checks.push('reload restores selected collection and readable title');
  await page.getByRole('button', { name: new RegExp(prefix + ' 甲') }).click();
  assert.equal(await page.locator('#library-title').textContent(), a.title);
  await page.locator('#query').fill('ultraviolet lighthouse sentinel');
  await page.locator('#search-form button').click();
  await page.waitForFunction(() => document.querySelectorAll('.result').length === 2);
  assert((await page.locator('.result h3').allTextContents()).includes('灯塔'));
  report.checks.push('UI: switching back restores the correct document set');
  await page.screenshot({ path: output + '/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: output + '/mobile.png', fullPage: true });
  report.checks.push('390px mobile layout has no horizontal overflow');
  report.invalidVector = await page.evaluate(async collection => {
    const response = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collection, query: 'test', embedding: [1, 2] }) });
    return { status: response.status, body: await response.json() };
  }, a.name);
  assert.equal(report.invalidVector.status, 400);
  report.checks.push('invalid vector dimension rejected before database query');
  await create(prefix + ' 多文件');
  await page.locator('#file').setInputFiles([
    { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('The first selected file explains copper lighthouse maintenance.') },
    { name: 'second.md', mimeType: 'text/markdown', buffer: Buffer.from('The second selected file explains silver orchard harvests.') },
  ]);
  await page.waitForFunction(() => window.localPages.selected.count === 2 && document.querySelector('#status').textContent.includes('索引刷新完成'), null, { timeout: 120000 });
  const multiple = await page.evaluate(() => window.localPages.search('lighthouse orchard'));
  assert.deepEqual(multiple.results.map(item => item.metadata.source).sort(), ['first.txt', 'second.md']);
  report.checks.push('UI: selecting two files imports both after the file picker resets');
  fallbackBrowser = await chromium.launch({ headless: true, args: [] });
  const fallbackPage = await fallbackBrowser.newPage();
  await fallbackPage.goto(origin);
  await fallbackPage.waitForFunction(() => window.localPages?.selected);
  report.fallbackEnvironment = await fallbackPage.evaluate(async () => ({ adapterAvailable: !!(await navigator.gpu?.requestAdapter()) }));
  assert.equal(report.fallbackEnvironment.adapterAvailable, false, 'This fallback validation needs an environment with no usable WebGPU adapter');
  report.fallbackLoad = await fallbackPage.evaluate(() => window.localPages.rpc('load', { options: {} }));
  assert.equal(report.fallbackLoad.backend, 'wasm');
  assert.equal(report.fallbackLoad.dtype, 'q8');
  await fallbackPage.evaluate(name => window.localPages.refreshLibraries(name), a.name);
  report.fallbackImport = await fallbackPage.evaluate(() => window.localPages.importDocuments([{ id: 'fallback', title: '降级验证', source: '浏览器验收', text: 'A WASM fallback document about ultraviolet lighthouse maintenance.' }]));
  report.fallbackSearch = await fallbackPage.evaluate(() => window.localPages.search('ultraviolet lighthouse maintenance'));
  assert(report.fallbackSearch.results.some(item => item.id === 'fallback'));
  assert((await fallbackPage.locator('#backend').textContent()).includes('WASM'));
  await fallbackPage.screenshot({ path: output + '/wasm.png', fullPage: true });
  report.checks.push('no WebGPU adapter: automatic WASM/INT8 import and hybrid search succeed, UI reports WASM');
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.externalRequests, []);
  report.passed = true;
  console.log(JSON.stringify(report.checks, null, 2));
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  report.finished = new Date().toISOString();
  await writeFile(output + '/acceptance.json', JSON.stringify(report, null, 2));
  await fallbackBrowser?.close();
  await browser.close();
}
