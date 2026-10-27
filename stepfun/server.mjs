import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SeekdbClient, SeekdbAdminClient, Schema, FulltextIndexConfig, VectorIndexConfig } from 'seekdb';

const root = dirname(fileURLToPath(import.meta.url));
const database = process.env.SEEKDB_DATABASE || 'stepfun_pages';
const connection = { host: process.env.SEEKDB_HOST || '127.0.0.1', port: Number(process.env.SEEKDB_PORT || 2881), user: process.env.SEEKDB_USER || 'root', password: process.env.SEEKDB_PASSWORD || '' };
const admin = new SeekdbAdminClient(connection);
const databases = await admin.listDatabases();
if (!databases.some(item => item.name === database)) await admin.createDatabase(database);
await admin.close();
const client = new SeekdbClient({ ...connection, database });
const schema = new Schema({ fulltextIndex: new FulltextIndexConfig('space'), vectorIndex: new VectorIndexConfig({ hnsw: { dimension: 384, distance: 'cosine' }, embeddingFunction: null }) });
const provenance = JSON.parse(await readFile(resolve(root, 'evidence/model-files.json'), 'utf8'));
await client.execute('CREATE TABLE IF NOT EXISTS local_pages_libraries (name VARCHAR(80) PRIMARY KEY, title VARCHAR(80) NOT NULL, model_revision VARCHAR(64) NOT NULL)');
let databaseQueue = Promise.resolve();
const serialized = fn => {
  const result = databaseQueue.then(fn);
  databaseQueue = result.catch(() => {});
  return result;
};
function validName(name) {
  if (typeof name !== 'string' || !/^pages_[a-z0-9_]{1,60}$/.test(name)) throw new Error('无效的资料库');
  return name;
}
function vector(value) {
  if (!Array.isArray(value) || value.length !== 384 || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('需要 384 维有效向量');
  return value;
}
async function getCollection(name) {
  return client.getCollection({ name: validName(name), embeddingFunction: null });
}
async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error('一次最多导入 16 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.onnx': 'application/octet-stream', '.wasm': 'application/wasm', '.mjs': 'application/javascript', '.svg': 'image/svg+xml' };
const server = http.createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/') && request.headers.origin && request.headers.origin !== 'http://' + request.headers.host) {
      response.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '请从本地应用页面操作' }));
      return;
    }
    let output;
    if (url.pathname === '/api/info' && request.method === 'GET') {
      output = { model: provenance, sdk: 'seekdb-js 1.4.0', database: 'seekdb', inference: 'browser only' };
    } else if (url.pathname === '/api/collections' && request.method === 'GET') {
      output = await serialized(async () => {
        const collections = await client.listCollections({ withEmbeddingFunction: false });
        const registry = await client.execute('SELECT name,title FROM local_pages_libraries');
        const titles = new Map(registry.map(row => [row.name, row.title]));
        const result = [];
        for (const c of collections.filter(c => c.name.startsWith('pages_'))) result.push({ name: c.name, title: titles.get(c.name) || '我的资料', count: await c.count() });
        return result;
      });
    } else if (url.pathname === '/api/collections' && request.method === 'POST') {
      const value = await body(request);
      const title = typeof value.title === 'string' ? value.title.trim() : '';
      if (!title || title.length > 80) throw new Error('资料库名称需为 1–80 个字符');
      const name = 'pages_' + createHash('sha256').update(title).digest('hex').slice(0, 24);
      output = await serialized(async () => {
        const c = await client.getOrCreateCollection({ name, schema, embeddingFunction: null });
        await client.execute('INSERT INTO local_pages_libraries(name,title,model_revision) VALUES(?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),model_revision=VALUES(model_revision)', [name, title, provenance.revision]);
        return { name, title, count: await c.count() };
      });
    } else if (url.pathname === '/api/import' && request.method === 'POST') {
      const value = await body(request);
      validName(value.collection);
      if (!Array.isArray(value.documents) || !value.documents.length || value.documents.length > 500) throw new Error('每批需要 1–500 个文本片段');
      const seen = new Set();
      for (const document of value.documents) {
        if (typeof document.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(document.id) || seen.has(document.id)) throw new Error('文档编号无效或重复');
        seen.add(document.id);
        if (typeof document.text !== 'string' || !document.text.trim() || document.text.length > 20000) throw new Error('文档内容无效');
        if (typeof document.title !== 'string' || document.title.length > 300) throw new Error('文档标题无效');
        vector(document.embedding);
      }
      output = await serialized(async () => {
        const collection = await getCollection(value.collection);
        const start = performance.now();
        await collection.upsert({ ids: value.documents.map(d => d.id), documents: value.documents.map(d => d.text), embeddings: value.documents.map(d => d.embedding), metadatas: value.documents.map(d => ({ title: d.title, source: d.source || d.title, part: Number(d.part || 1) })) });
        const writeMs = performance.now() - start;
        const refreshStart = performance.now();
        await collection.refresh_index();
        const count = await collection.count();
        return { imported: value.documents.length, count, writeMs, refreshMs: performance.now() - refreshStart, refreshed: true, collection: value.collection };
      });
    } else if (url.pathname === '/api/search' && request.method === 'POST') {
      const value = await body(request);
      validName(value.collection);
      vector(value.embedding);
      if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 1000) throw new Error('请输入 1–1000 个字符的查询');
      output = await serialized(async () => {
        const collection = await getCollection(value.collection);
        const begin = performance.now();
        // Both candidate retrieval and RRF ranking execute inside seekdb.
        const stopwords = new Set('a an the i me my we our you your how can could should do does did is are was were be been to for of in on at and or with it this that what why when after'.split(' '));
        const terms = value.query.match(/[\p{L}\p{N}_]+/gu) || [];
        const lexical = terms.filter(term => !stopwords.has(term.toLowerCase())).join(' ') || value.query;
        const result = await collection.hybridSearch({ query: { whereDocument: { $contains: lexical }, nResults: 20 }, knn: { queryEmbeddings: [value.embedding], nResults: 20 }, rank: { rrf: { rankWindowSize: 20, rankConstant: 60 } }, nResults: 5, include: ['documents', 'metadatas', 'distances'] });
        return { collection: value.collection, retrievalMs: performance.now() - begin, operation: 'seekdb Collection.hybridSearch / DBMS_HYBRID_SEARCH + RRF', results: (result.ids?.[0] || []).map((id, i) => ({ id, text: result.documents?.[0]?.[i], metadata: result.metadatas?.[0]?.[i], distance: result.distances?.[0]?.[i] })) };
      });
    } else if (url.pathname.startsWith('/api/')) {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '未找到接口' }));
      return;
    } else {
      let path;
      if (url.pathname.startsWith('/models/') || url.pathname.startsWith('/runtime/')) path = resolve(root, 'public', '.' + decodeURIComponent(url.pathname));
      else path = resolve(root, 'dist', '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      const allowed = [resolve(root, 'dist') + sep, resolve(root, 'public/models') + sep, resolve(root, 'public/runtime') + sep];
      if (!allowed.some(base => path.startsWith(base)) || !(await stat(path)).isFile()) throw new Error('文件不存在');
      response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
      if (url.pathname.startsWith('/models/')) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      response.end(await readFile(path));
      return;
    }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(output));
  } catch (error) {
    console.error(error.name + ': ' + error.message);
    response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error.message || '操作未完成' }));
  }
});
server.listen(Number(process.env.PORT || 8788), '127.0.0.1', () => console.log('本页 http://127.0.0.1:' + (process.env.PORT || 8788)));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { server.close(); await client.close(); process.exit(0); });
