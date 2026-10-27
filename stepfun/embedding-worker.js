import { env, pipeline } from '@huggingface/transformers';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = '/runtime/';

let extractor;
let current;
let requestKey;
let adapterPromise;
let queue = Promise.resolve();

function adapterWithTimeout() {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 3000);
    Promise.resolve(navigator.gpu?.requestAdapter()).then(adapter => { clearTimeout(timer); resolve(adapter || null); }, () => { clearTimeout(timer); resolve(null); });
  });
}

async function createExtractor(backend, dtype, progress) {
  if (backend !== 'webgpu') return pipeline('feature-extraction', 'minilm', { device: backend, dtype, progress_callback: progress });
  let expired = false;
  let timer;
  const initialized = pipeline('feature-extraction', 'minilm', { device: backend, dtype, progress_callback: progress });
  initialized.then(model => { if (expired) model.dispose().catch(() => {}); }, () => {});
  try {
    return await Promise.race([initialized, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('WebGPU model initialization timed out')); }, 20000); })]);
  } finally { clearTimeout(timer); }
}

async function load(options = {}) {
  const begin = performance.now();
  const key = JSON.stringify([!!options.forceWasm, options.dtype || '', !!options.requireGpu]);
  if (extractor && requestKey === key) return { ...current, loadMs: 0, cached: true };
  if (!options.forceWasm) adapterPromise ||= adapterWithTimeout();
  const adapter = options.forceWasm ? null : await adapterPromise;
  const gpu = !!adapter;
  let backend = gpu ? 'webgpu' : 'wasm';
  let dtype = options.dtype || (gpu && adapter.features.has('shader-f16') ? 'fp16' : 'q8');
  if (backend === 'wasm' && !options.dtype) dtype = 'q8';
  if (current?.backend === backend && current?.dtype === dtype) {
    return { ...current, loadMs: 0, cached: true };
  }
  if (extractor) await extractor.dispose();
  extractor = null;
  current = null;
  const progress = item => self.postMessage({ type: 'progress', item });
  let fallbackReason = gpu ? null : options.forceWasm && !options.automaticFallback ? '已选择 WASM / INT8 验证模式。' : '此环境没有就绪的 WebGPU，已自动使用 WASM / INT8。';
  try {
    extractor = await createExtractor(backend, dtype, progress);
  } catch (error) {
    if (backend !== 'webgpu' || options.requireGpu) throw error;
    backend = 'wasm';
    dtype = 'q8';
    fallbackReason = 'WebGPU 初始化未完成，已自动切换到 WASM / INT8。';
    extractor = await createExtractor(backend, dtype, progress);
  }
  requestKey = key;
  const modelRequests = performance.getEntriesByType('resource').filter(item => item.startTime >= begin && item.name.includes('/models/'));
  const modelFetchMs = modelRequests.length ? Math.max(...modelRequests.map(item => item.responseEnd)) - Math.min(...modelRequests.map(item => item.startTime)) : 0;
  current = { backend, dtype, fallbackReason, adapter: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : null, model: 'Xenova/all-MiniLM-L6-v2', revision: '751bff37182d3f1213fa05d7196b954e230abad9', dimension: 384 };
  return { ...current, loadMs: performance.now() - begin, modelFetchMs, cached: false };
}

async function handle(value) {
  if (value.type === 'load') return load(value.options);
  if (value.type !== 'embed') throw new Error('Unknown worker operation');
  const info = await load(value.options);
  if (!Array.isArray(value.texts) || value.texts.some(t => typeof t !== 'string' || !t.trim())) throw new Error('请输入非空文本');
  const batch = Math.max(1, Math.min(32, value.batchSize || 8));
  const vectors = [];
  const begin = performance.now();
  for (let i = 0; i < value.texts.length; i += batch) {
    const output = await extractor(value.texts.slice(i, i + batch), { pooling: 'mean', normalize: true, truncation: true, max_length: 128 });
    vectors.push(...output.tolist());
    self.postMessage({ type: 'embedding-progress', done: vectors.length, total: value.texts.length });
  }
  if (vectors.length !== value.texts.length || vectors.some(v => v.length !== 384 || v.some(n => !Number.isFinite(n)))) throw new Error('模型返回了无效向量');
  return { vectors, ...info, embeddingMs: performance.now() - begin, batchSize: batch };
}

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      self.postMessage({ id: data.id, result: await handle(data) });
    } catch (error) {
      self.postMessage({ id: data.id, error: String(error.message || error) });
    }
  });
};
