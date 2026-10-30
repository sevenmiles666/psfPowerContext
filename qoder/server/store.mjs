import {
  SeekdbClient,
  SeekdbAdminClient,
  Schema,
  FulltextIndexConfig,
  VectorIndexConfig,
} from "seekdb";
import { embed, modelInfo } from "./embedding.mjs";
import { citation } from "./text.mjs";
import { randomUUID } from "node:crypto";

const database = process.env.SEEKDB_DATABASE || "qoder_papertrail";
if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(database))
  throw new Error("SEEKDB_DATABASE 只能包含字母、数字和下划线");
const connection = {
  host: process.env.SEEKDB_HOST || "127.0.0.1",
  port: Number(process.env.SEEKDB_PORT || 2883),
  user: process.env.SEEKDB_USER || "root",
  password: process.env.SEEKDB_PASSWORD || "",
};
let client, collection;
let queue = Promise.resolve();
export const serial = (fn) => {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
};

export async function connect() {
  const admin = new SeekdbAdminClient(connection);
  try {
    if (!(await admin.listDatabases()).some((d) => d.name === database))
      await admin.createDatabase(database);
  } finally {
    await admin.close();
  }
  client = new SeekdbClient({ ...connection, database });
  await client.execute(
    "CREATE TABLE IF NOT EXISTS pt_documents (id VARCHAR(32) PRIMARY KEY, title VARCHAR(300) NOT NULL, filename VARCHAR(300) NOT NULL, kind VARCHAR(16) NOT NULL, source_text LONGTEXT NOT NULL, chunk_count INT NOT NULL, created_at VARCHAR(32) NOT NULL)",
  );
  await client.execute(
    "CREATE TABLE IF NOT EXISTS pt_bookmarks (id VARCHAR(96) PRIMARY KEY, created_at VARCHAR(32) NOT NULL)",
  );
  await client.execute(
    "CREATE TABLE IF NOT EXISTS pt_audit (id VARCHAR(36) PRIMARY KEY, created_at VARCHAR(32) NOT NULL, operation VARCHAR(32) NOT NULL, detail LONGTEXT NOT NULL)",
  );
  const schema = new Schema({
    fulltextIndex: new FulltextIndexConfig("ik", { ik_mode: "smart" }),
    vectorIndex: new VectorIndexConfig({
      hnsw: { dimension: 384, distance: "cosine" },
      embeddingFunction: null,
    }),
  });
  collection = await client.getOrCreateCollection({
    name: "papertrail_passages_v1",
    schema,
    embeddingFunction: null,
  });
  const version = await client.execute("SELECT VERSION() AS version");
  return { engine: "seekdb", version: version[0].version, database };
}
export async function close() {
  if (client) await client.close();
}
export async function audit(operation, detail) {
  const record = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    operation,
    detail,
  };
  await client.execute("INSERT INTO pt_audit VALUES (?,?,?,?)", [
    record.id,
    record.createdAt,
    operation,
    JSON.stringify(detail),
  ]);
  return record;
}
export async function recentAudit() {
  return (
    await client.execute(
      "SELECT * FROM pt_audit ORDER BY created_at DESC LIMIT 30",
    )
  ).map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
}
export async function documents() {
  return client.execute(
    "SELECT id,title,filename,kind,chunk_count AS chunks,created_at AS createdAt FROM pt_documents ORDER BY created_at DESC",
  );
}
export async function importDocument(doc) {
  const existing = await client.execute(
    "SELECT id FROM pt_documents WHERE id=?",
    [doc.id],
  );
  if (existing.length) return { id: doc.id, title: doc.title, duplicate: true };
  const start = performance.now();
  const vectors = await embed(doc.chunks.map((c) => c.text));
  const ids = doc.chunks.map((c) => doc.id + "_" + c.part);
  try {
    for (let offset = 0; offset < doc.chunks.length; offset += 64) {
      const parts = doc.chunks.slice(offset, offset + 64);
      await collection.upsert({
        ids: ids.slice(offset, offset + 64),
        documents: parts.map((c) => c.text),
        embeddings: vectors.slice(offset, offset + 64),
        metadatas: parts.map((c) => ({
          documentId: doc.id,
          title: doc.title,
          filename: doc.filename,
          kind: doc.kind,
          page: c.page || 0,
          paragraph: c.paragraph,
          part: c.part,
          offset: c.offset,
        })),
      });
    }
    await collection.refresh_index();
    await client.execute("INSERT INTO pt_documents VALUES (?,?,?,?,?,?,?)", [
      doc.id,
      doc.title,
      doc.filename,
      doc.kind,
      JSON.stringify(doc.pages),
      doc.chunks.length,
      new Date().toISOString(),
    ]);
  } catch (error) {
    try {
      await collection.delete({ ids });
    } catch {
      /* Retry uses stable IDs and upserts. */
    }
    throw error;
  }
  const record = await audit("import", {
    documentId: doc.id,
    title: doc.title,
    chunks: ids.length,
    ids,
    model: modelInfo(),
    refreshed: true,
    elapsedMs: Math.round(performance.now() - start),
  });
  return {
    id: doc.id,
    title: doc.title,
    chunks: ids.length,
    duplicate: false,
    auditId: record.id,
  };
}
function unpack(result) {
  // Query results are grouped by query; get() returns flat arrays.
  const grouped = Array.isArray(result.ids?.[0]);
  const flat = (key) => (grouped ? result[key]?.[0] : result[key]);
  return (flat("ids") || []).map((id, index) => {
    const item = {
      id,
      text: flat("documents")?.[index],
      ...(flat("metadatas")?.[index] || {}),
      distance: flat("distances")?.[index] ?? null,
    };
    return { ...item, citation: citation(item) };
  });
}
export async function search({ query, mode, documentId }) {
  const start = performance.now();
  const where = documentId ? { documentId: { $eq: documentId } } : undefined;
  let vector;
  if (mode !== "keyword") [vector] = await embed([query]);
  const dbStart = performance.now();
  let raw, operation;
  if (mode === "semantic") {
    operation = "Collection.query / HNSW cosine";
    raw = await collection.query({
      queryEmbeddings: [vector],
      where,
      nResults: 10,
      include: ["documents", "metadatas", "distances"],
    });
  } else {
    operation =
      mode === "hybrid"
        ? "Collection.hybridSearch / fulltext + HNSW + RRF"
        : "Collection.hybridSearch / fulltext only";
    raw = await collection.hybridSearch({
      query: { whereDocument: { $contains: query }, where, nResults: 30 },
      ...(vector
        ? { knn: { queryEmbeddings: [vector], where, nResults: 30 } }
        : {}),
      rank: { rrf: { rankWindowSize: 30, rankConstant: 60 } },
      nResults: 10,
      include: ["documents", "metadatas", "distances"],
    });
  }
  const dbMs = Math.round(performance.now() - dbStart);
  const results = unpack(raw);
  const elapsedMs = Math.round(performance.now() - start);
  const record = await audit("search", {
    query,
    mode,
    documentId,
    operation,
    resultIds: results.map((r) => r.id),
    dbMs,
    elapsedMs,
    model: mode === "keyword" ? null : modelInfo(),
    rrf: mode === "hybrid" ? { rankWindowSize: 30, rankConstant: 60 } : null,
  });
  return {
    results,
    trace: {
      id: record.id,
      engine: "seekdb",
      operation,
      dbMs,
      elapsedMs,
      mode,
      query,
      documentId,
      count: results.length,
    },
  };
}
export async function passage(id) {
  const result = unpack(
    await collection.get({ ids: [id], include: ["documents", "metadatas"] }),
  )[0];
  if (!result) return null;
  const docs = await client.execute(
    "SELECT source_text FROM pt_documents WHERE id=?",
    [result.documentId],
  );
  return docs.length
    ? { ...result, pages: JSON.parse(docs[0].source_text) }
    : null;
}
export async function bookmarks() {
  const rows = await client.execute(
    "SELECT id FROM pt_bookmarks ORDER BY created_at DESC",
  );
  if (!rows.length) return [];
  return unpack(
    await collection.get({
      ids: rows.map((r) => r.id),
      include: ["documents", "metadatas"],
    }),
  );
}
export async function bookmark(id, enabled) {
  if (enabled) {
    if (!(await passage(id))) throw new Error("片段不存在");
    await client.execute(
      "INSERT INTO pt_bookmarks VALUES (?,?) ON DUPLICATE KEY UPDATE id=VALUES(id)",
      [id, new Date().toISOString()],
    );
  } else await client.execute("DELETE FROM pt_bookmarks WHERE id=?", [id]);
  return { id, saved: enabled };
}
