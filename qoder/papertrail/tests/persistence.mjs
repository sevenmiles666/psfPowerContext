import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { libraryPath, request } from './http.mjs';

const state = JSON.parse(await readFile(new URL('../.data/verification-state.json', import.meta.url), 'utf8'));
const checks = [];
const check = (name, condition, detail) => {
  assert.ok(condition, name);
  checks.push({ name, status: 'passed', detail });
  console.log(`PASS ${name}`);
};

const health = (await request('/api/health')).data;
check('应用与 seekdb 在重启后可用', health.database.engine === 'seekdb', health.database);
const libraries = (await request('/api/libraries')).data.libraries;
check('资料库在重启后保留', libraries.some((item) => item.id === state.primaryLibraryId), state.primaryLibraryId);
const documents = (await request(libraryPath(state.primaryLibraryId, '/documents'))).data.documents;
for (const documentId of [state.ragDocumentId, state.pdfDocumentId, state.escapeDocumentId]) {
  check(`文献 ${documentId} 在重启后保留`, documents.some((item) => item.id === documentId), documentId);
}
const bookmarks = (await request(libraryPath(state.primaryLibraryId, '/bookmarks'))).data.bookmarks;
check('收藏在应用与数据库重启后保留', bookmarks.some((item) => item.id === state.persistedBookmarkId), state.persistedBookmarkId);
const passage = (await request(libraryPath(state.primaryLibraryId, `/passages/${state.persistedBookmarkId}`))).data.passage;
check('重启后原文偏移仍逐字一致', passage.sourceText.slice(passage.sourceStart, passage.sourceEnd) === passage.text, { id: passage.id, location: passage.location });
const search = (await request(libraryPath(state.primaryLibraryId, '/search'), {
  method: 'POST',
  body: { query: '幻觉', mode: 'keyword', documentId: state.ragDocumentId },
})).data;
check('重启后真实全文索引仍可检索', search.results.length > 0 && search.results.every((item) => item.documentId === state.ragDocumentId), search.trace);
const secondaryDocuments = (await request(libraryPath(state.secondaryLibraryId, '/documents'))).data.documents;
check('重启不会恢复已删除文献', !secondaryDocuments.some((item) => item.id === state.secondaryDeletedDocumentId), state.secondaryDeletedDocumentId);

const evidence = { status: 'passed', verifiedAt: new Date().toISOString(), health: health.database, checks };
await writeFile(new URL('../evidence/persistence.json', import.meta.url), JSON.stringify(evidence, null, 2));
console.log(`Persistence verification passed: ${checks.length} checks.`);
