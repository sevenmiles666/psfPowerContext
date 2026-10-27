import './style.css';
import { corpus } from './sample-data.js';

const $ = id => document.getElementById(id);
const worker = new Worker(new URL('./embedding-worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let counter = 0;
let libraries = [];
let selected;
let busy = false;
const forceWasm = new URLSearchParams(location.search).get('wasm') === '1';
const records = [];
let backendInfo;
let adapterReadiness;

function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function backend(info) {
  backendInfo = info;
  $('backend').textContent = `${info.backend === 'webgpu' ? 'WebGPU' : 'WASM'} · ${info.dtype === 'q8' ? 'INT8' : info.dtype.toUpperCase()} · 本地运行`;
  $('backend').title = info.fallbackReason || '浏览器正在本地计算向量';
}
worker.onmessage = ({ data }) => {
  if (data.type === 'embedding-progress') status(`正在本地向量化 ${data.done} / ${data.total}…`);
  if (data.type === 'progress' && data.item.status === 'progress') status(`首次准备模型文件… ${Math.round(data.item.progress || 0)}%`);
  const item = pending.get(data.id);
  if (!item) return;
  pending.delete(data.id);
  if (data.error) item.reject(new Error(data.error));
  else { backend(data.result); item.resolve(data.result); }
};
worker.onerror = event => {
  for (const item of pending.values()) item.reject(new Error(event.message || '本地推理没有完成，请刷新重试'));
  pending.clear();
};
async function rpc(type, payload = {}) {
  if (forceWasm) payload = { ...payload, options: { ...payload.options, forceWasm: true } };
  if ((type === 'load' || type === 'embed') && !payload.options?.forceWasm) {
    adapterReadiness ||= new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 3000);
      Promise.resolve(navigator.gpu?.requestAdapter()).then(adapter => { clearTimeout(timer); resolve(!!adapter); }, () => { clearTimeout(timer); resolve(false); });
    });
    if (!(await adapterReadiness)) payload = { ...payload, options: { ...payload.options, forceWasm: true, automaticFallback: true } };
  }
  return new Promise((resolve, reject) => {
    const id = ++counter;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload });
  });
}
async function api(path, value) {
  const response = await fetch('/api/' + path, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '连接没有完成');
  return result;
}
async function exclusive(fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  try { return await fn(); }
  catch (error) { status(error.message, true); throw error; }
  finally { busy = false; document.querySelectorAll('button').forEach(button => button.disabled = false); }
}
function renderLibraries() {
  $('collections').replaceChildren();
  for (const library of libraries) {
    const button = document.createElement('button');
    button.textContent = library.title;
    const count = document.createElement('span'); count.textContent = library.count; button.append(count);
    button.className = library.name === selected?.name ? 'active' : '';
    button.onclick = () => { if (!busy) choose(library); };
    $('collections').append(button);
  }
}
function choose(library) {
  selected = library;
  localStorage.setItem('local-pages-library', library.name);
  $('library-title').textContent = library.title;
  $('breadcrumb').textContent = '资料库 / ' + library.title;
  $('document-count').textContent = `${library.count} 个片段 · 已刷新，可检索`;
  $('results').replaceChildren();
  status(library.count ? '资料已就绪。用一句话，找到想看的那一页。' : '先导入一份资料，开启你的第一场检索。');
  $('timing').textContent = '';
  renderLibraries();
}
async function refreshLibraries(preferred) {
  libraries = await api('collections');
  if (!libraries.length) { const first = await api('collections', { title: '我的资料' }); libraries = [first]; }
  choose(libraries.find(item => item.name === preferred) || libraries[0]);
}
async function embed(texts, options = {}, batchSize = 8) {
  const result = await rpc('embed', { texts, batchSize, options: { forceWasm, ...options } });
  records.push({ stage: 'embedding', texts: texts.length, backend: result.backend, dtype: result.dtype, batchSize, embeddingMs: result.embeddingMs, loadMs: result.loadMs });
  return result;
}
async function importDocuments(documents, collection = selected?.name, options = {}, batchSize = 8) {
  if (!collection) throw new Error('请先创建资料库');
  const started = performance.now();
  const result = await embed(documents.map(item => item.text), options, batchSize);
  status('向量化完成，正在写入并刷新检索索引…');
  const saved = await api('import', { collection, documents: documents.map((item, i) => ({ ...item, embedding: result.vectors[i] })) });
  const entry = { stage: 'import', collection, documents: documents.length, loadMs: result.loadMs, embeddingMs: result.embeddingMs, writeMs: saved.writeMs, refreshMs: saved.refreshMs, totalMs: performance.now() - started, backend: result.backend, dtype: result.dtype, batchSize };
  records.push(entry);
  return { ...saved, ...entry };
}
async function search(query, collection = selected?.name, options = {}) {
  if (!collection) throw new Error('请先创建资料库');
  const started = performance.now();
  const embedded = await embed([query], options);
  const result = await api('search', { collection, query, embedding: embedded.vectors[0] });
  const metrics = { stage: 'search', collection, query, queryEmbeddingMs: embedded.embeddingMs, loadMs: embedded.loadMs, retrievalMs: result.retrievalMs, totalMs: performance.now() - started, backend: embedded.backend, dtype: embedded.dtype };
  records.push(metrics);
  return { ...result, metrics };
}
function renderResults(result) {
  $('results').replaceChildren();
  for (const [i, item] of result.results.entries()) {
    const article = document.createElement('article'); article.className = 'result';
    const number = document.createElement('span'); number.className = 'result-index'; number.textContent = String(i + 1).padStart(2, '0');
    const content = document.createElement('div');
    const title = document.createElement('h3'); title.textContent = item.metadata?.title || '未命名资料';
    const text = document.createElement('p'); text.textContent = item.text;
    const source = document.createElement('small'); source.textContent = `出处：${item.metadata?.source || item.id} · 第 ${item.metadata?.part || 1} 段`;
    content.append(title, text, source); article.append(number, content); $('results').append(article);
  }
  status(result.results.length ? `找到了 ${result.results.length} 段相关原文。` : '还没有找到相关内容，试试换一种说法。');
  $('timing').textContent = `本地向量 ${Math.round(result.metrics.queryEmbeddingMs)} ms · 检索 ${Math.round(result.retrievalMs)} ms`;
}
async function hash(text) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), x => x.toString(16).padStart(2, '0')).join(''); }
async function filesToDocuments(files) {
  const documents = [];
  for (const file of files) {
    if (file.size > 2 * 1024 * 1024) throw new Error('每份文本最多 2 MiB');
    if (!/\.(txt|md|text)$/i.test(file.name)) throw new Error('请选择 TXT 或 Markdown 文件');
    const text = (await file.text()).trim();
    if (!text) continue;
    const parts = text.match(/[\s\S]{1,1400}/g) || [];
    for (const [i, part] of parts.entries()) documents.push({ id: (await hash(file.name + ':' + i + ':' + part)), title: file.name.replace(/\.[^.]+$/, ''), source: file.name, part: i + 1, text: part });
  }
  if (!documents.length || documents.length > 500) throw new Error('一次需要 1–500 个非空文本片段');
  return documents;
}
async function importFiles(files) {
  // FileList is live: resetting the picker must not drop later files while reading.
  const selectedFiles = Array.from(files);
  await exclusive(async () => {
    const collection = selected.name;
    const result = await importDocuments(await filesToDocuments(selectedFiles), collection);
    await refreshLibraries(collection);
    status(`已收好 ${result.imported} 个片段，索引刷新完成。现在可以检索了。`);
    $('timing').textContent = `向量 ${Math.round(result.embeddingMs)} ms · 写入/刷新 ${Math.round(result.writeMs + result.refreshMs)} ms`;
  });
}
$('import').onclick = () => $('file').click();
$('file').onchange = () => { importFiles($('file').files).catch(() => {}); $('file').value = ''; };
$('sample').onclick = () => exclusive(async () => {
  const collection = selected.name;
  const result = await importDocuments(corpus, collection);
  await refreshLibraries(collection);
  status(`已收好 ${result.imported} 份示例摘录。试试搜索 database、plants 或 sleep。`);
}).catch(() => {});
$('search-form').onsubmit = event => {
  event.preventDefault();
  const query = $('query').value.trim();
  if (!query) return status('写下一句你想找的内容。');
  exclusive(async () => { status('正在本地理解这句话…'); renderResults(await search(query)); }).catch(() => {});
};
for (const type of ['dragenter', 'dragover']) $('drop').addEventListener(type, event => { event.preventDefault(); $('drop').classList.add('drag'); });
for (const type of ['dragleave', 'drop']) $('drop').addEventListener(type, event => { event.preventDefault(); $('drop').classList.remove('drag'); });
$('drop').addEventListener('drop', event => { if (!busy) importFiles(event.dataTransfer.files).catch(() => {}); });
$('new-collection').onclick = () => { $('new-name').value = ''; $('new-dialog').showModal(); $('new-name').focus(); };
$('create-confirm').onclick = event => {
  event.preventDefault();
  const title = $('new-name').value.trim();
  if (!title) return $('new-name').focus();
  $('new-dialog').close();
  exclusive(async () => { const library = await api('collections', { title }); await refreshLibraries(library.name); }).catch(() => {});
};
$('export-metrics').onclick = () => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify({ browser: navigator.userAgent, backend: backendInfo, records }, null, 2)], { type: 'application/json' }));
  link.download = 'local-pages-run.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 5000);
};
window.localPages = { embed, importDocuments, search, api, rpc, records, get selected() { return selected; }, corpus, refreshLibraries, forceWasm };
refreshLibraries(localStorage.getItem('local-pages-library')).catch(error => status(error.message, true));
