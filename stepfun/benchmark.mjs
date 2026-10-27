import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { corpus, queries } from './sample-data.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = process.env.EVIDENCE_DIR || 'evidence/benchmark';
await mkdir(directory, { recursive: true });
const configurations = [
  { name: 'fp32-webgpu-b1', dtype: 'fp32', batchSize: 1, requireGpu: true },
  { name: 'fp16-webgpu-b1', dtype: 'fp16', batchSize: 1, requireGpu: true },
  { name: 'fp16-webgpu-b8', dtype: 'fp16', batchSize: 8, requireGpu: true },
  { name: 'int8-wasm-b8', dtype: 'q8', batchSize: 8, forceWasm: true },
];
const output = { started: new Date().toISOString(), corpus, queries, configurations: [], pageErrors: [], externalRequests: [] };
const median = values => { const ordered = [...values].sort((a, b) => a - b); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2; };
function quality(ids, relevant) {
  const dcg = ids.reduce((sum, id, i) => sum + (relevant.includes(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = relevant.slice(0, 5).reduce((sum, _, i) => sum + 1 / Math.log2(i + 2), 0);
  return { recallAt5: ids.filter(id => relevant.includes(id)).length / relevant.length, ndcgAt5: dcg / ideal };
}
const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : ['--enable-unsafe-webgpu'] });
try {
  for (const config of configurations) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', error => output.pageErrors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:8788/') && !request.url().startsWith('blob:')) output.externalRequests.push(request.url()); });
    await page.goto(process.env.APP_URL || 'http://127.0.0.1:8788/');
    await page.waitForFunction(() => window.localPages?.selected);
    const record = { config, rounds: [] };
    output.configurations.push(record);
    record.environment = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      return { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, adapter: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, shaderF16: adapter.features.has('shader-f16') } : null };
    });
    record.load = await page.evaluate(options => window.localPages.rpc('load', { options }), config);
    if (record.load.dtype !== config.dtype || (config.requireGpu && record.load.backend !== 'webgpu')) throw new Error('Requested configuration did not initialize: ' + config.name);
    record.collection = await page.evaluate(title => window.localPages.api('collections', { title }), '实测 ' + config.name);
    console.log('LOADED', config.name, JSON.stringify(record.load));
    for (let round = 0; round < 4; round++) {
      const imported = await page.evaluate(({ documents, collection, config }) => window.localPages.importDocuments(documents, collection, config, config.batchSize), { documents: corpus, collection: record.collection.name, config });
      const searches = [];
      for (const query of queries) {
        const result = await page.evaluate(({ query, collection, config }) => window.localPages.search(query, collection, config), { query: query.text, collection: record.collection.name, config });
        searches.push({ query: query.text, ids: result.results.map(item => item.id), ...quality(result.results.map(item => item.id), query.relevant), metrics: result.metrics });
      }
      record.rounds.push({ round, import: imported, searches });
      await writeFile(directory + '/raw.json', JSON.stringify(output, null, 2));
      console.log('ROUND', config.name, round, Math.round(imported.embeddingMs), searches.map(item => item.recallAt5).join(','));
    }
    const warm = record.rounds.slice(1);
    const searches = warm.flatMap(item => item.searches);
    record.summary = {
      warmDocumentEmbeddingMs: median(warm.map(item => item.import.embeddingMs)),
      warmDocumentsPerSecond: median(warm.map(item => corpus.length * 1000 / item.import.embeddingMs)),
      warmWriteMs: median(warm.map(item => item.import.writeMs)),
      warmRefreshMs: median(warm.map(item => item.import.refreshMs)),
      warmQueryEmbeddingMs: median(searches.map(item => item.metrics.queryEmbeddingMs)),
      warmRetrievalMs: median(searches.map(item => item.metrics.retrievalMs)),
      warmEndToEndMs: median(searches.map(item => item.metrics.totalMs)),
      recallAt5: searches.reduce((sum, item) => sum + item.recallAt5, 0) / searches.length,
      ndcgAt5: searches.reduce((sum, item) => sum + item.ndcgAt5, 0) / searches.length,
    };
    await context.close();
  }
} catch (error) {
  output.failure = error.stack;
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  output.finished = new Date().toISOString();
  await writeFile(directory + '/raw.json', JSON.stringify(output, null, 2));
  await writeFile(directory + '/summary.json', JSON.stringify(output.configurations.map(item => ({ name: item.config.name, load: item.load, ...item.summary })), null, 2));
  await browser.close();
}
