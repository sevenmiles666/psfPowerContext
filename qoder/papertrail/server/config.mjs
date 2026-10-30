import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export const config = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8791),
  database: {
    host: process.env.SEEKDB_HOST || '127.0.0.1',
    port: Number(process.env.SEEKDB_PORT || 2883),
    user: process.env.SEEKDB_USER || 'root',
    password: process.env.SEEKDB_PASSWORD || '',
    name: process.env.SEEKDB_DATABASE || 'qoder_papertrail_qoder',
  },
  model: {
    id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900',
    dimensions: 384,
    cacheDir: path.resolve(process.env.MODEL_CACHE_DIR || path.join(projectRoot, '.cache/models')),
  },
  projectRoot,
});

export const modelSignature = `${config.model.id}@${config.model.revision}:${config.model.dimensions}`;
