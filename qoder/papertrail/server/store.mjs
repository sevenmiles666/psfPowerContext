import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { config, modelSignature } from './config.mjs';
import {
  closeDatabase,
  connectDatabase,
  databaseHealth,
  passages,
  query,
  recordAudit,
  transaction,
} from './database.mjs';
import { embedTexts, getModelStatus } from './embeddings.mjs';
import { extractDocument } from './extract.mjs';
import { titleFromFilename } from './text.mjs';
import { citationFor, locationLabel, unpackCollection } from './citations.mjs';

let queue = Promise.resolve();
const isoNow = () => new Date().toISOString();
const serial = (work) => {
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
};

function scopedError(message, httpStatus = 400) {
  return Object.assign(new Error(message), { httpStatus });
}

export const chunkIdFor = (documentId, chunkIndex) => `${documentId}:${chunkIndex}`;
export const documentIdFor = (libraryId, contentHash) => createHash('sha256')
  .update(`${libraryId}:${contentHash}`)
  .digest('hex')
  .slice(0, 32);

async function requireLibrary(libraryId) {
  const rows = await query('SELECT id,name FROM ptq_libraries WHERE id=?', [libraryId]);
  if (!rows.length) throw scopedError('资料库不存在，请刷新后重试。', 404);
  return rows[0];
}

async function requireDocument(libraryId, documentId) {
  const rows = await query('SELECT * FROM ptq_documents WHERE id=? AND library_id=?', [documentId, libraryId]);
  if (!rows.length) throw scopedError('当前资料库中不存在该文献。', 404);
  return rows[0];
}

export async function initializeStore() {
  const health = await connectDatabase();
  const unfinished = await query("SELECT * FROM ptq_documents WHERE status<>'ready'");
  for (const document of unfinished) {
    await cleanupDocument(document);
  }
  const libraries = await query('SELECT id FROM ptq_libraries LIMIT 1');
  if (!libraries.length) await createLibrary('RAG 文献');
  return health;
}

export async function shutdownStore() {
  await closeDatabase();
}

export async function health() {
  return {
    database: await databaseHealth(),
    model: { ...getModelStatus(), id: config.model.id, revision: config.model.revision },
  };
}

export async function listLibraries() {
  return query(`SELECT l.id,l.name,l.created_at AS createdAt,
    (SELECT COUNT(*) FROM ptq_documents d WHERE d.library_id=l.id AND d.status='ready') AS documentCount,
    (SELECT COUNT(*) FROM ptq_bookmarks b WHERE b.library_id=l.id) AS bookmarkCount
    FROM ptq_libraries l ORDER BY l.created_at`);
}

export async function createLibrary(name) {
  const library = { id: randomUUID().replaceAll('-', ''), name, createdAt: isoNow() };
  try {
    await query('INSERT INTO ptq_libraries (id,name,created_at) VALUES (?,?,?)', [
      library.id,
      library.name,
      library.createdAt,
    ]);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw scopedError('资料库名称已存在，请换一个名称。', 409);
    throw error;
  }
  return library;
}

export async function listDocuments(libraryId) {
  await requireLibrary(libraryId);
  const rows = await query(`SELECT d.id,d.title,d.filename,d.kind,d.page_count AS pageCount,
    d.paragraph_count AS paragraphCount,d.chunk_count AS chunkCount,d.status,d.created_at AS createdAt,
    (SELECT COUNT(*) FROM ptq_bookmarks b WHERE b.library_id=d.library_id AND b.document_id=d.id) AS bookmarkCount
    FROM ptq_documents d WHERE d.library_id=? ORDER BY d.created_at DESC`, [libraryId]);
  return rows.filter((row) => row.status === 'ready' || row.status === 'deleting');
}

async function cleanCollectionChunks(document) {
  const ids = Array.from({ length: document.chunk_count }, (_, index) => chunkIdFor(document.id, index + 1));
  if (ids.length) await passages().delete({ ids });
  await passages().refresh_index();
}

async function cleanupDocument(document) {
  await cleanCollectionChunks(document);
  await transaction(async (tx) => {
    await tx.query('DELETE FROM ptq_bookmarks WHERE library_id=? AND document_id=?', [document.library_id, document.id]);
    await tx.query('DELETE FROM ptq_documents WHERE library_id=? AND id=?', [document.library_id, document.id]);
  });
}

function metadataFor(document, chunk) {
  return {
    libraryId: document.libraryId,
    documentId: document.id,
    title: document.title,
    filename: document.filename,
    kind: document.kind,
    pageNumber: chunk.pageNumber || 0,
    paragraphIndex: chunk.paragraphIndex,
    chunkIndex: chunk.chunkIndex,
    sourceStart: chunk.start,
    sourceEnd: chunk.end,
    paragraphStart: chunk.paragraphStart,
    paragraphEnd: chunk.paragraphEnd,
  };
}

async function duplicateResult(libraryId, document, filename, started) {
  const audit = await recordAudit(libraryId, 'import', {
    filename,
    documentId: document.id,
    contentHash: document.content_hash,
    status: 'duplicate',
    chunkCount: document.chunk_count,
    modelSignature,
    elapsedMs: Math.round(performance.now() - started),
  });
  return {
    filename,
    status: 'duplicate',
    duplicate: true,
    documentId: document.id,
    title: document.title,
    chunkCount: document.chunk_count,
    auditId: audit.id,
  };
}

export async function importFile(libraryId, file) {
  const started = performance.now();
  await requireLibrary(libraryId);
  const filename = path.basename(file.originalname || '未命名资料').slice(0, 300);
  let extracted;
  try {
    extracted = await extractDocument({ ...file, originalname: filename });
  } catch (error) {
    await recordAudit(libraryId, 'import', {
      filename,
      status: 'error',
      message: error.message,
      elapsedMs: Math.round(performance.now() - started),
    });
    return { filename, status: 'error', duplicate: false, error: error.message };
  }

  const contentHash = createHash('sha256').update(extracted.source).digest('hex');
  const documentId = documentIdFor(libraryId, contentHash);
  const existing = await query('SELECT * FROM ptq_documents WHERE library_id=? AND content_hash=?', [libraryId, contentHash]);
  if (existing[0]?.status === 'ready') return duplicateResult(libraryId, existing[0], filename, started);

  const vectors = await embedTexts(extracted.chunks.map((chunk) => chunk.text));
  return serial(async () => {
    const repeated = await query('SELECT * FROM ptq_documents WHERE library_id=? AND content_hash=?', [libraryId, contentHash]);
    if (repeated[0]?.status === 'ready') return duplicateResult(libraryId, repeated[0], filename, started);
    if (repeated[0]) await cleanupDocument(repeated[0]);

    const document = {
      id: documentId,
      libraryId,
      contentHash,
      title: titleFromFilename(filename),
      filename,
      kind: extracted.kind,
      source: extracted.source,
      pageCount: extracted.pageCount,
      paragraphCount: extracted.paragraphs.length,
      chunkCount: extracted.chunks.length,
    };
    await query(`INSERT INTO ptq_documents
      (id,library_id,content_hash,title,filename,kind,source_text,page_count,paragraph_count,chunk_count,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
      document.id,
      libraryId,
      contentHash,
      document.title,
      document.filename,
      document.kind,
      document.source,
      document.pageCount,
      document.paragraphCount,
      document.chunkCount,
      'importing',
      isoNow(),
    ]);

    const dbStarted = performance.now();
    const ids = extracted.chunks.map((chunk) => chunkIdFor(documentId, chunk.chunkIndex));
    try {
      for (let offset = 0; offset < extracted.chunks.length; offset += 64) {
        const batch = extracted.chunks.slice(offset, offset + 64);
        await passages().upsert({
          ids: ids.slice(offset, offset + 64),
          documents: batch.map((chunk) => chunk.text),
          embeddings: vectors.slice(offset, offset + 64),
          metadatas: batch.map((chunk) => metadataFor(document, chunk)),
        });
      }
      await passages().refresh_index();
      const stored = unpackCollection(await passages().get({ ids, include: ['metadatas'] }));
      if (stored.length !== ids.length) {
        throw new Error(`片段核验失败：预期 ${ids.length}，实际 ${stored.length}。`);
      }
      await query("UPDATE ptq_documents SET status='ready' WHERE library_id=? AND id=? AND status='importing'", [libraryId, documentId]);
    } catch (error) {
      try {
        await cleanupDocument({ id: documentId, library_id: libraryId, chunk_count: document.chunkCount });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '导入失败，且自动清理未完成；请重试，系统会先清理不完整数据。');
      }
      throw error;
    }

    const audit = await recordAudit(libraryId, 'import', {
      filename,
      documentId,
      contentHash,
      status: 'imported',
      chunkIds: ids,
      chunkCount: ids.length,
      modelSignature,
      refreshedIndex: true,
      dbMs: Math.round(performance.now() - dbStarted),
      elapsedMs: Math.round(performance.now() - started),
    });
    return {
      filename,
      status: 'imported',
      duplicate: false,
      documentId,
      title: document.title,
      chunkCount: ids.length,
      auditId: audit.id,
    };
  });
}

function searchWhere(libraryId, documentId) {
  const conditions = [{ libraryId: { $eq: libraryId } }];
  if (documentId) conditions.push({ documentId: { $eq: documentId } });
  return conditions.length === 1 ? conditions[0] : { $and: conditions };
}

async function attachBookmarkState(libraryId, results) {
  if (!results.length) return results;
  const placeholders = results.map(() => '?').join(',');
  const saved = await query(`SELECT chunk_id FROM ptq_bookmarks WHERE library_id=? AND chunk_id IN (${placeholders})`, [
    libraryId,
    ...results.map((item) => item.id),
  ]);
  const ids = new Set(saved.map((item) => item.chunk_id));
  return results.map((item) => ({ ...item, saved: ids.has(item.id) }));
}

function assertResultScope(results, libraryId, documentId) {
  if (results.some((item) => item.libraryId !== libraryId || (documentId && item.documentId !== documentId))) {
    throw new Error('检索返回了越出当前资料库范围的数据，已阻止展示。');
  }
}

export async function search(libraryId, { query: searchQuery, mode, documentId = null }) {
  const started = performance.now();
  await requireLibrary(libraryId);
  if (documentId) await requireDocument(libraryId, documentId);
  const vector = mode === 'keyword' ? null : (await embedTexts([searchQuery]))[0];

  return serial(async () => {
    const where = searchWhere(libraryId, documentId);
    const dbStarted = performance.now();
    let raw;
    let operation;
    if (mode === 'semantic') {
      operation = 'Collection.query · HNSW cosine';
      raw = await passages().query({
        queryEmbeddings: [vector],
        where,
        nResults: 10,
        include: ['documents', 'metadatas', 'distances'],
      });
    } else {
      operation = mode === 'hybrid'
        ? 'Collection.hybridSearch · IK fulltext + HNSW cosine + database RRF'
        : 'Collection.hybridSearch · IK fulltext only';
      raw = await passages().hybridSearch({
        query: { whereDocument: { $contains: searchQuery }, where, nResults: 30 },
        ...(vector ? { knn: { queryEmbeddings: [vector], where, nResults: 30 } } : {}),
        rank: { rrf: { rankWindowSize: 30, rankConstant: 60 } },
        nResults: 10,
        include: ['documents', 'metadatas', 'distances'],
      });
    }
    const dbMs = Math.round(performance.now() - dbStarted);
    const unpacked = unpackCollection(raw);
    assertResultScope(unpacked, libraryId, documentId);
    const results = await attachBookmarkState(libraryId, unpacked);
    const elapsedMs = Math.round(performance.now() - started);
    const rrf = mode === 'hybrid'
      ? { rankWindowSize: 30, rankConstant: 60, formula: '1 / (60 + branchRank)', execution: 'seekdb DBMS_HYBRID_SEARCH' }
      : null;
    const audit = await recordAudit(libraryId, 'search', {
      libraryId,
      query: searchQuery,
      mode,
      documentId,
      operation,
      resultIds: results.map((item) => item.id),
      model: mode === 'keyword' ? null : { id: config.model.id, revision: config.model.revision, signature: modelSignature },
      rrf,
      dbMs,
      elapsedMs,
    });
    return {
      results,
      trace: {
        id: audit.id,
        libraryId,
        query: searchQuery,
        mode,
        documentId,
        operation,
        resultIds: results.map((item) => item.id),
        dbMs,
        elapsedMs,
        modelSignature: mode === 'keyword' ? null : modelSignature,
        rrf,
      },
    };
  });
}

export async function getPassage(libraryId, chunkId) {
  const item = unpackCollection(await passages().get({ ids: [chunkId], include: ['documents', 'metadatas'] }))[0];
  if (!item || item.libraryId !== libraryId) throw scopedError('当前资料库中不存在该片段。', 404);
  const documents = await query("SELECT * FROM ptq_documents WHERE id=? AND library_id=? AND status='ready'", [item.documentId, libraryId]);
  if (!documents.length) throw scopedError('片段所属文献不可用。', 404);
  return { ...item, sourceText: documents[0].source_text, citation: citationFor(item), location: locationLabel(item) };
}

export async function listBookmarks(libraryId) {
  await requireLibrary(libraryId);
  const rows = await query('SELECT * FROM ptq_bookmarks WHERE library_id=? ORDER BY created_at DESC', [libraryId]);
  if (!rows.length) return [];
  const items = unpackCollection(await passages().get({
    ids: rows.map((row) => row.chunk_id),
    include: ['documents', 'metadatas'],
  }));
  const byId = new Map(items.map((item) => [item.id, item]));
  return rows.flatMap((row) => {
    const item = byId.get(row.chunk_id);
    if (!item || item.libraryId !== libraryId || item.documentId !== row.document_id) return [];
    return [{ ...item, saved: true, savedAt: row.created_at }];
  });
}

export async function setBookmark(libraryId, chunkId, saved) {
  return serial(async () => {
    await requireLibrary(libraryId);
    if (saved) {
      const item = unpackCollection(await passages().get({ ids: [chunkId], include: ['metadatas'] }))[0];
      if (!item || item.libraryId !== libraryId) throw scopedError('不能收藏其他资料库的片段。', 404);
      await requireDocument(libraryId, item.documentId);
      await query(`INSERT INTO ptq_bookmarks (library_id,document_id,chunk_id,created_at)
        VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE created_at=VALUES(created_at)`, [libraryId, item.documentId, chunkId, isoNow()]);
    } else {
      await query('DELETE FROM ptq_bookmarks WHERE library_id=? AND chunk_id=?', [libraryId, chunkId]);
    }
    return { id: chunkId, saved };
  });
}

export async function removeDocument(libraryId, documentId) {
  return serial(async () => {
    const rows = await query('SELECT * FROM ptq_documents WHERE library_id=? AND id=?', [libraryId, documentId]);
    if (!rows.length) {
      await recordAudit(libraryId, 'delete', { libraryId, documentId, status: 'alreadyDeleted' });
      return { documentId, deleted: false, alreadyDeleted: true };
    }
    const document = rows[0];
    const bookmarks = await query('SELECT COUNT(*) AS count FROM ptq_bookmarks WHERE library_id=? AND document_id=?', [libraryId, documentId]);
    await query("UPDATE ptq_documents SET status='deleting' WHERE library_id=? AND id=?", [libraryId, documentId]);
    try {
      await cleanCollectionChunks(document);
      await transaction(async (tx) => {
        await tx.query('DELETE FROM ptq_bookmarks WHERE library_id=? AND document_id=?', [libraryId, documentId]);
        await tx.query('DELETE FROM ptq_documents WHERE library_id=? AND id=?', [libraryId, documentId]);
      });
    } catch (error) {
      throw Object.assign(new Error(`删除未完成，文献已标记为删除中；请重试以完成清理。${error.message}`), { httpStatus: 500 });
    }
    await recordAudit(libraryId, 'delete', {
      libraryId,
      documentId,
      filename: document.filename,
      removedChunks: document.chunk_count,
      removedBookmarks: Number(bookmarks[0].count),
      status: 'deleted',
    });
    return { documentId, deleted: true, alreadyDeleted: false };
  });
}

export async function listAudit(libraryId) {
  await requireLibrary(libraryId);
  const rows = await query('SELECT * FROM ptq_audit WHERE library_id=? ORDER BY created_at DESC LIMIT 60', [libraryId]);
  return rows.map((row) => ({
    id: row.id,
    libraryId: row.library_id,
    operation: row.operation,
    detail: JSON.parse(row.detail),
    createdAt: row.created_at,
  }));
}
