import { config, modelSignature } from './config.mjs';

let loader = null;
let embedder = null;
let state = { status: 'idle', message: '模型将在首次导入或语义检索时加载。', signature: modelSignature };

function update(patch) {
  state = { ...state, ...patch };
}

async function loadModel() {
  update({ status: 'loading', message: '正在加载本地多语言模型；首次运行需要下载约 135 MB。' });
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = config.model.cacheDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    embedder = await pipeline('feature-extraction', config.model.id, {
      revision: config.model.revision,
      dtype: 'q8',
      progress_callback(progress) {
        if (progress.status === 'progress' && Number.isFinite(progress.progress)) {
          update({
            status: 'loading',
            message: `正在下载模型 ${Math.round(progress.progress)}%（${progress.file || '模型文件'}）`,
          });
        }
      },
    });
    update({ status: 'ready', message: '本地模型已就绪。' });
    return embedder;
  } catch (error) {
    update({ status: 'error', message: `模型加载失败：${error.message}` });
    throw new Error(`本地嵌入模型加载失败。首次使用需联网下载固定模型；请检查网络或模型缓存。${error.message}`);
  }
}

export async function embedTexts(texts) {
  if (!texts.length) return [];
  if (!embedder) {
    if (!loader) loader = loadModel().finally(() => { loader = null; });
    await loader;
  }
  update({ status: 'loading', message: `正在本地编码 ${texts.length} 段文本…` });
  try {
    const vectors = [];
    for (const text of texts) {
      const output = await embedder(text, {
        pooling: 'mean',
        normalize: true,
        truncation: true,
        max_length: 256,
      });
      const vector = Array.from(output.data, Number);
      if (vector.length !== config.model.dimensions) {
        throw new Error(`模型返回 ${vector.length} 维，预期 ${config.model.dimensions} 维。`);
      }
      vectors.push(vector);
    }
    update({ status: 'ready', message: '本地模型已就绪。' });
    return vectors;
  } catch (error) {
    update({ status: 'error', message: `文本编码失败：${error.message}` });
    throw error;
  }
}

export function getModelStatus() {
  return state;
}
