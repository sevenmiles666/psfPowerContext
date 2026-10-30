import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from './config.mjs';
import { IMPORT_LIMITS } from './text.mjs';
import {
  createLibrary,
  getPassage,
  health,
  importFile,
  initializeStore,
  listAudit,
  listBookmarks,
  listDocuments,
  listLibraries,
  removeDocument,
  search,
  setBookmark,
  shutdownStore,
} from './store.mjs';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { files: IMPORT_LIMITS.maxFiles, fileSize: IMPORT_LIMITS.maxFileBytes },
});
let initializationError = null;

app.disable('x-powered-by');
app.use((req, res, next) => {
  const allowedHosts = new Set([
    `${config.host}:${config.port}`,
    `127.0.0.1:${config.port}`,
    `localhost:${config.port}`,
    '127.0.0.1:5173',
    'localhost:5173',
  ]);
  if (!allowedHosts.has(req.headers.host)) return res.status(403).json({ error: '不允许的主机地址。' });
  if (req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      if (!['127.0.0.1', 'localhost'].includes(origin.hostname)) {
        return res.status(403).json({ error: '不允许的跨站请求。' });
      }
    } catch {
      return res.status(403).json({ error: '无效的请求来源。' });
    }
  }
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use('/api', (req, res, next) => {
  if (initializationError && req.path !== '/health') {
    return res.status(503).json({ error: `seekdb 不可用：${initializationError.message}` });
  }
  next();
});

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const validId = (value) => /^[a-f0-9]{32}$/.test(value);
const validChunkId = (value) => /^[a-f0-9]{32}:[1-9][0-9]*$/.test(value);

function validateScope(req, res, next) {
  if (!validId(req.params.libraryId)) return res.status(400).json({ error: '无效的资料库 ID。' });
  if (req.params.documentId && !validId(req.params.documentId)) return res.status(400).json({ error: '无效的文献 ID。' });
  if (req.params.chunkId && !validChunkId(req.params.chunkId)) return res.status(400).json({ error: '无效的片段 ID。' });
  next();
}

app.get('/api/health', asyncRoute(async (req, res) => {
  if (initializationError) return res.status(503).json({ error: `seekdb 不可用：${initializationError.message}` });
  res.json(await health());
}));

app.get('/api/libraries', asyncRoute(async (req, res) => {
  res.json({ libraries: await listLibraries() });
}));

app.post('/api/libraries', asyncRoute(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) {
    return res.status(400).json({ error: '资料库名称需为 1–80 个可见字符。' });
  }
  res.status(201).json({ library: await createLibrary(name) });
}));

app.get('/api/libraries/:libraryId/documents', validateScope, asyncRoute(async (req, res) => {
  res.json({ documents: await listDocuments(req.params.libraryId) });
}));

app.post('/api/libraries/:libraryId/import', validateScope, upload.array('files', IMPORT_LIMITS.maxFiles), asyncRoute(async (req, res) => {
  if (!req.files.length) return res.status(400).json({ error: '请选择至少一个文件。' });
  const results = [];
  for (const file of req.files) results.push(await importFile(req.params.libraryId, file));
  res.json({ results });
}));

app.post('/api/libraries/:libraryId/samples', validateScope, asyncRoute(async (req, res) => {
  const names = ['rag-basics.md', 'evidence-notes.md', 'course-retrieval.txt'];
  const results = [];
  for (const name of names) {
    const buffer = await readFile(path.join(config.projectRoot, 'samples', name));
    results.push(await importFile(req.params.libraryId, { originalname: name, buffer }));
  }
  res.json({ results });
}));

app.post('/api/libraries/:libraryId/search', validateScope, asyncRoute(async (req, res) => {
  const query = typeof req.body.query === 'string' ? req.body.query.trim() : '';
  const mode = req.body.mode;
  const documentId = req.body.documentId || null;
  if (!query || query.length > 300) return res.status(400).json({ error: '查询需为 1–300 个字符。' });
  if (!['keyword', 'semantic', 'hybrid'].includes(mode)) return res.status(400).json({ error: '不支持的检索模式。' });
  if (documentId && !validId(documentId)) return res.status(400).json({ error: '无效的文献范围。' });
  res.json(await search(req.params.libraryId, { query, mode, documentId }));
}));

app.get('/api/libraries/:libraryId/passages/:chunkId', validateScope, asyncRoute(async (req, res) => {
  res.json({ passage: await getPassage(req.params.libraryId, req.params.chunkId) });
}));

app.get('/api/libraries/:libraryId/bookmarks', validateScope, asyncRoute(async (req, res) => {
  res.json({ bookmarks: await listBookmarks(req.params.libraryId) });
}));

app.put('/api/libraries/:libraryId/bookmarks/:chunkId', validateScope, asyncRoute(async (req, res) => {
  if (typeof req.body.saved !== 'boolean') return res.status(400).json({ error: 'saved 必须是布尔值。' });
  res.json(await setBookmark(req.params.libraryId, req.params.chunkId, req.body.saved));
}));

app.delete('/api/libraries/:libraryId/documents/:documentId', validateScope, asyncRoute(async (req, res) => {
  res.json(await removeDocument(req.params.libraryId, req.params.documentId));
}));

app.get('/api/libraries/:libraryId/audit', validateScope, asyncRoute(async (req, res) => {
  res.json({ audit: await listAudit(req.params.libraryId) });
}));

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在。' }));

const distDirectory = path.join(config.projectRoot, 'dist');
const indexFile = path.join(distDirectory, 'index.html');
if (existsSync(indexFile)) {
  app.use(express.static(distDirectory, { index: false }));
  app.use((req, res, next) => {
    if (req.method === 'GET' && req.accepts('html')) return res.sendFile(indexFile);
    next();
  });
}

app.use((error, req, res, next) => {
  console.error(`[${req.method} ${req.originalUrl}]`, error);
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? '单个文件不能超过 10 MiB。'
      : error.code === 'LIMIT_FILE_COUNT'
        ? '每批最多导入 8 个文件。'
        : `上传失败：${error.message}`;
    return res.status(413).json({ error: message });
  }
  const status = error.httpStatus || (['ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'].includes(error.code) ? 503 : 500);
  res.status(status).json({ error: error.message || '服务器处理失败。' });
});

const server = app.listen(config.port, config.host, async () => {
  console.log(`知页 PaperTrail（Qoder 正式版本）http://${config.host}:${config.port}`);
  try {
    const detail = await initializeStore();
    console.log(`seekdb 已连接：${detail.version} / ${detail.database}`);
  } catch (error) {
    initializationError = error;
    console.error('seekdb 初始化失败，API 将返回明确错误，不使用内存替代。', error);
  }
});

async function shutdown() {
  server.close(async () => {
    await shutdownStore();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
