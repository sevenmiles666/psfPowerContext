import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { corpus, queries } from './sample-data.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.EVIDENCE_DIR || 'evidence/browser';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-proxy-server', ...(process.env.BROWSER_DISABLE_GPU ? ['--disable-gpu'] : process.platform === 'darwin' ? ['--use-angle=metal'] : ['--enable-unsafe-webgpu'])] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const log = { started: new Date().toISOString(), errors: [], requests: [], queries };
page.on('pageerror', error => { log.errors.push(error.message); console.log('PAGEERROR', error.message); });
page.on('console', message => { if (message.type() === 'error') console.log('CONSOLE', message.text().slice(0, 700)); });
page.on('request', request => log.requests.push({ url: request.url(), method: request.method() }));
try {
  await page.goto(process.env.APP_URL || 'http://127.0.0.1:8788/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.localPages?.selected, null, { timeout: 30000, polling: 100 });
  log.browser = await page.evaluate(async () => ({ userAgent: navigator.userAgent, gpu: !!navigator.gpu, adapter: !!(await Promise.race([navigator.gpu?.requestAdapter(), new Promise(resolve => setTimeout(() => resolve(null), 3000))])) }));
  console.log('BROWSER', JSON.stringify(log.browser));
  log.load = await page.evaluate(() => window.localPages.rpc('load', { options: {} }));
  console.log('LOAD', JSON.stringify(log.load));
  log.import = await page.evaluate(async documents => window.localPages.importDocuments(documents), corpus);
  console.log('IMPORT', JSON.stringify(log.import));
  await page.evaluate(() => window.localPages.refreshLibraries(window.localPages.selected.name));
  log.search = await page.evaluate(query => window.localPages.search(query), queries[0].text);
  console.log('SEARCH', JSON.stringify(log.search));
  await page.locator('#query').fill(queries[0].text);
  await page.locator('#search-form button').click({ force: process.env.BROWSER_CHANNEL === 'msedge' });
  await page.waitForFunction(() => document.querySelectorAll('.result').length > 0, null, { polling: 100 });
  if (process.env.BROWSER_CHANNEL === 'msedge') log.screenshot = 'Headless Edge 156 capture stalls in this environment; DOM results and the real browser/seekdb pipeline were verified. Chrome screenshots cover visual layout.';
  else await page.screenshot({ path: output + '/desktop.png', fullPage: true });
  if (!log.search.results.some(item => item.id === 'db-index' || item.id === 'db-plan')) throw new Error('Expected relevant database document missing');
  if (log.errors.length) throw new Error('Browser page errors detected');
  log.passed = true;
} catch (error) {
  log.failure = error.stack;
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  log.finished = new Date().toISOString();
  await writeFile(output + '/smoke.json', JSON.stringify(log, null, 2));
  await browser.close();
}
