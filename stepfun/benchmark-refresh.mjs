import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { corpus } from './sample-data.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.EVIDENCE_DIR || 'evidence/refresh';
await mkdir(output, { recursive: true });
const report = { started: new Date().toISOString(), documents: corpus.length, rounds: [] };
const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : ['--enable-unsafe-webgpu'] });
try {
  const page = await browser.newPage();
  await page.goto(process.env.APP_URL || 'http://127.0.0.1:8788/');
  await page.waitForFunction(() => window.localPages?.selected);
  // Generate once in this browser. Both strategies write these identical vectors.
  report.embedding = await page.evaluate(async docs => {
    const result = await window.localPages.embed(docs.map(item => item.text));
    window.refreshBenchmarkDocuments = docs.map((item, i) => ({ ...item, embedding: result.vectors[i] }));
    const { vectors, ...info } = result;
    return info;
  }, corpus);
  for (let round = 0; round < 3; round++) {
    const record = { round };
    for (const strategy of ['each-document', 'once-per-import']) {
      record[strategy] = await page.evaluate(async ({ title, strategy }) => {
        const collection = await window.localPages.api('collections', { title });
        const documents = window.refreshBenchmarkDocuments;
        const batches = strategy === 'each-document' ? documents.map(item => [item]) : [documents];
        const started = performance.now();
        let writeMs = 0, refreshMs = 0, count = 0;
        for (const batch of batches) {
          const result = await window.localPages.api('import', { collection: collection.name, documents: batch });
          writeMs += result.writeMs; refreshMs += result.refreshMs; count = result.count;
        }
        if (count !== documents.length) throw new Error('Refresh benchmark count mismatch');
        return { writeMs, refreshMs, totalMs: performance.now() - started, refreshCalls: batches.length, count, collection: collection.name };
      }, { title: '刷新实测 ' + report.started + ' ' + round + ' ' + strategy, strategy });
      console.log(round, strategy, Math.round(record[strategy].totalMs));
    }
    report.rounds.push(record);
    await writeFile(output + '/raw.json', JSON.stringify(report, null, 2));
  }
  report.passed = true;
} catch (error) { report.failure = error.stack; process.exitCode = 1; console.error(error.stack); }
finally { report.finished = new Date().toISOString(); await writeFile(output + '/raw.json', JSON.stringify(report, null, 2)); await browser.close(); }
