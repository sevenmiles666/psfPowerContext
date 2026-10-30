import React, { useEffect, useRef, useState } from 'react';
import { api, libraryPath } from './api.js';
import { Icon } from './icons.jsx';
import SourcePreview from './SourcePreview.jsx';
import { downloadText, resultsMarkdown } from './utils.js';

const modes = [
  ['hybrid', '混合检索'],
  ['semantic', '语义检索'],
  ['keyword', '关键词检索'],
];

export default function SearchPage({ libraryId, documents, initialDocumentId, onOpenImport, onOpenAudit, onBookmarkChange, onNotify }) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('hybrid');
  const [documentId, setDocumentId] = useState(initialDocumentId || '');
  const [results, setResults] = useState([]);
  const [trace, setTrace] = useState(null);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [passage, setPassage] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewRef = useRef(null);
  const previewSequence = useRef(0);

  useEffect(() => {
    setDocumentId(initialDocumentId || '');
  }, [initialDocumentId]);

  useEffect(() => {
    setResults([]);
    setTrace(null);
    setSearched(false);
    setPassage(null);
    setError('');
  }, [libraryId]);

  const openPassage = async (id) => {
    const sequence = ++previewSequence.current;
    setPreviewLoading(true);
    setPassage(null);
    try {
      const data = await api(libraryPath(libraryId, `/passages/${id}`));
      if (sequence !== previewSequence.current) return;
      setPassage(data.passage);
      if (window.matchMedia('(max-width: 780px)').matches) {
        requestAnimationFrame(() => previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    } catch (loadError) {
      if (sequence === previewSequence.current) onNotify(loadError.message, 'error');
    } finally {
      if (sequence === previewSequence.current) setPreviewLoading(false);
    }
  };

  const runSearch = async (event) => {
    event?.preventDefault();
    if (!query.trim()) return onNotify('请输入问题或术语。', 'error');
    setLoading(true);
    setError('');
    setSearched(true);
    try {
      const data = await api(libraryPath(libraryId, '/search'), {
        method: 'POST',
        body: JSON.stringify({ query, mode, documentId: documentId || null }),
      });
      setResults(data.results);
      setTrace(data.trace);
      setPassage(null);
      if (data.results[0]) await openPassage(data.results[0].id);
    } catch (searchError) {
      setResults([]);
      setTrace(null);
      setError(searchError.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleBookmark = async (item) => {
    try {
      await api(libraryPath(libraryId, `/bookmarks/${item.id}`), {
        method: 'PUT',
        body: JSON.stringify({ saved: !item.saved }),
      });
      setResults((current) => current.map((result) => result.id === item.id ? { ...result, saved: !item.saved } : result));
      await onBookmarkChange();
      onNotify(item.saved ? '已从阅读清单移除。' : '已保存到阅读清单。');
    } catch (bookmarkError) {
      onNotify(bookmarkError.message, 'error');
    }
  };

  const exportResults = () => {
    downloadText('知页-检索结果.md', resultsMarkdown('知页 · 检索阅读清单', results, {
      query: trace?.query,
      mode: trace?.mode,
      traceId: trace?.id,
    }));
    onNotify('检索结果已导出为 Markdown。');
  };

  return <>
    <header className="page-header search-header">
      <div>
        <p className="eyebrow">文献与资料检索</p>
        <h1>从资料中，找到答案。</h1>
        <p className="subtitle">让每一次检索，都有原文可循。</p>
      </div>
      <button className="button secondary desktop-import" onClick={onOpenImport}><Icon name="upload" />导入资料</button>
    </header>

    <div className="search-controls">
      <form className="search-form" onSubmit={runSearch}>
        <Icon name="search" size={21} />
        <input aria-label="检索问题或术语" data-testid="search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入问题、术语或研究线索" maxLength={300} />
        <button className="button primary" data-testid="search-submit" disabled={loading}>{loading ? '检索中…' : '检索'}<Icon name="arrow" /></button>
      </form>
      <div className="search-options">
        <div className="mode-tabs" aria-label="检索模式">
          {modes.map(([value, label]) => <button key={value} className={mode === value ? 'mode active' : 'mode'} aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}
        </div>
        <select aria-label="限定文献" value={documentId} onChange={(event) => setDocumentId(event.target.value)}>
          <option value="">当前资料库全部文献</option>
          {documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}
        </select>
      </div>
    </div>

    {!documents.length && <div className="inline-callout"><Icon name="file" /><span>当前资料库还没有可检索的文献。</span><button className="text-button" onClick={onOpenImport}>导入资料或自编样例</button></div>}
    {trace?.modelSignature && <div className="model-note">本地模型已用于本次检索 · {trace.modelSignature.split('@')[0]}</div>}

    <div className="search-workspace">
      <section className="results-panel">
        <div className="section-heading">
          <div><h2>检索结果 {searched && !loading && <span>{results.length} 个相关段落</span>}</h2></div>
          <button className="button quiet" onClick={exportResults} disabled={!results.length} data-testid="export-results"><Icon name="download" />导出结果</button>
        </div>
        <div className="result-subhead">
          {trace && <span>seekdb · {trace.dbMs} ms / 总计 {trace.elapsedMs} ms</span>}
          <button className="text-button" onClick={onOpenAudit}>查看检索记录 <Icon name="arrow" size={14} /></button>
        </div>
        {trace?.rrf && <div className="rrf-note">全文与向量各取 30 条候选，由 seekdb 按 RRF 公式 1/(60+rank) 融合；排序分不代表事实可信度。</div>}
        {loading && <div className="content-state"><span className="spinner" /><p>正在查询 seekdb，语义与混合模式还需本地编码。</p></div>}
        {!loading && error && <div className="content-state error-state"><h3>检索未完成</h3><p>{error}</p></div>}
        {!loading && !error && !searched && <div className="content-state"><Icon name="search" size={32} /><h3>从一个问题开始</h3><p>结果只来自当前资料库，不会生成无出处的论文结论。</p></div>}
        {!loading && !error && searched && !results.length && <div className="content-state"><Icon name="file" size={32} /><h3>没有匹配的段落</h3><p>可尝试更短的关键词或切换检索模式。系统没有生成替代答案。</p></div>}
        {!loading && results.length > 0 && <div className="result-list" data-testid="result-list">
          {results.map((item, index) => <article className={passage?.id === item.id ? 'result-item selected' : 'result-item'} key={item.id} data-testid="result-item" data-chunk-id={item.id}>
            <span className="result-number">{String(index + 1).padStart(2, '0')}</span>
            <div className="result-content">
              <h3>{item.title}</h3>
              <p className="result-meta">{item.filename} · {item.kind} · {item.location}</p>
              <p className="result-text">{item.text}</p>
              <button className="text-button view-source" data-testid="view-source" onClick={() => openPassage(item.id)}>查看原文 <Icon name="arrow" size={14} /></button>
            </div>
            <button className={item.saved ? 'bookmark-button saved' : 'bookmark-button'} aria-label={item.saved ? `取消收藏 ${item.title}` : `收藏 ${item.title}`} aria-pressed={item.saved} onClick={() => toggleBookmark(item)}><Icon name="bookmark" filled={item.saved} /></button>
          </article>)}
        </div>}
      </section>
      <SourcePreview ref={previewRef} passage={passage} loading={previewLoading} onNotify={onNotify} />
    </div>
  </>;
}
