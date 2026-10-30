import { createHash, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import {
  FulltextIndexConfig,
  Schema,
  SeekdbAdminClient,
  SeekdbClient,
  VectorIndexConfig,
} from 'seekdb';
import { config, modelSignature } from './config.mjs';

if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(config.database.name)) {
  throw new Error('SEEKDB_DATABASE 只能包含字母、数字和下划线，且必须以字母开头。');
}

const connection = {
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
};

export const collectionName = `ptq_passages_${createHash('sha256').update(modelSignature).digest('hex').slice(0, 10)}`;
let pool;
let client;
let collection;

export async function connectDatabase() {
  const admin = new SeekdbAdminClient(connection);
  try {
    if (!(await admin.listDatabases()).some((item) => item.name === config.database.name)) {
      await admin.createDatabase(config.database.name);
    }
  } finally {
    await admin.close();
  }

  pool = mysql.createPool({
    ...connection,
    database: config.database.name,
    connectionLimit: 8,
    waitForConnections: true,
    supportBigNumbers: true,
  });
  client = new SeekdbClient({ ...connection, database: config.database.name });

  await query(`CREATE TABLE IF NOT EXISTS ptq_libraries (
    id VARCHAR(32) PRIMARY KEY,
    name VARCHAR(80) NOT NULL UNIQUE,
    created_at VARCHAR(32) NOT NULL
  )`);
  await query(`CREATE TABLE IF NOT EXISTS ptq_documents (
    id VARCHAR(32) PRIMARY KEY,
    library_id VARCHAR(32) NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    title VARCHAR(300) NOT NULL,
    filename VARCHAR(300) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    source_text LONGTEXT NOT NULL,
    page_count INT,
    paragraph_count INT NOT NULL,
    chunk_count INT NOT NULL,
    status VARCHAR(16) NOT NULL,
    created_at VARCHAR(32) NOT NULL,
    UNIQUE KEY uq_ptq_document_hash (library_id, content_hash),
    KEY idx_ptq_document_library (library_id, status)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS ptq_bookmarks (
    library_id VARCHAR(32) NOT NULL,
    document_id VARCHAR(32) NOT NULL,
    chunk_id VARCHAR(80) NOT NULL,
    created_at VARCHAR(32) NOT NULL,
    PRIMARY KEY (library_id, chunk_id),
    KEY idx_ptq_bookmark_document (library_id, document_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS ptq_audit (
    id VARCHAR(36) PRIMARY KEY,
    library_id VARCHAR(32) NOT NULL,
    operation VARCHAR(32) NOT NULL,
    detail LONGTEXT NOT NULL,
    created_at VARCHAR(32) NOT NULL,
    KEY idx_ptq_audit_library (library_id, created_at)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS ptq_metadata (
    id INT PRIMARY KEY,
    model_signature VARCHAR(300) NOT NULL,
    collection_name VARCHAR(128) NOT NULL,
    created_at VARCHAR(32) NOT NULL
  )`);

  const metadata = await query('SELECT * FROM ptq_metadata WHERE id=1');
  if (metadata.length && metadata[0].model_signature !== modelSignature) {
    throw new Error(`模型版本已变化（数据库：${metadata[0].model_signature}；当前：${modelSignature}）。为防止新旧向量混用，请配置新的 SEEKDB_DATABASE 并重新导入。`);
  }
  if (!metadata.length) {
    await query('INSERT INTO ptq_metadata (id,model_signature,collection_name,created_at) VALUES (1,?,?,?)', [
      modelSignature,
      collectionName,
      new Date().toISOString(),
    ]);
  }

  const schema = new Schema({
    fulltextIndex: new FulltextIndexConfig('ik', { ik_mode: 'smart' }),
    vectorIndex: new VectorIndexConfig({
      hnsw: { dimension: config.model.dimensions, distance: 'cosine' },
      embeddingFunction: null,
    }),
  });
  collection = await client.getOrCreateCollection({
    name: collectionName,
    schema,
    embeddingFunction: null,
  });
  return databaseHealth();
}

export async function closeDatabase() {
  await Promise.allSettled([pool?.end(), client?.close()]);
}

export async function query(sql, params = []) {
  if (!pool) throw new Error('seekdb 尚未连接。');
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function transaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work({
      async query(sql, params = []) {
        const [rows] = await connection.execute(sql, params);
        return rows;
      },
    });
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export function passages() {
  if (!collection) throw new Error('seekdb Collection 尚未连接。');
  return collection;
}

export async function databaseHealth() {
  const rows = await query('SELECT VERSION() AS version');
  return {
    engine: 'seekdb',
    version: rows[0].version,
    database: config.database.name,
    collection: collectionName,
    modelSignature,
  };
}

export async function recordAudit(libraryId, operation, detail) {
  const record = {
    id: randomUUID(),
    libraryId,
    operation,
    detail,
    createdAt: new Date().toISOString(),
  };
  await query('INSERT INTO ptq_audit (id,library_id,operation,detail,created_at) VALUES (?,?,?,?,?)', [
    record.id,
    libraryId,
    operation,
    JSON.stringify(detail),
    record.createdAt,
  ]);
  return record;
}
