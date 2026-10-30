import React, { useEffect, useRef, useState } from 'react';
import { api, libraryPath } from './api.js';
import { Icon } from './icons.jsx';
import SourcePreview from './SourcePreview.jsx';
import { downloadText, resultsMarkdown } from './utils.js';

export function DocumentsPage({ libraryId, documents, onOpenImport, onSearchDocument, onDelete }) {
  return <>
    <header className="page-header">
      <div><p className="eyebrow">资料管理</p><h1>我的文献</h1><p className="subtitle">每一份资料都归属于当前资料库，删除前会明确确认目标。</p></div>
      <button className="button primary" onClick={onOpenImport}><Icon name="upload" />导入资料</button>
    </header>
    <section className="page-section">
      <div className="section-heading"><h2>文献列表 <span>{documents.length} 份</span></h2></div>
      {!documents.length ? <div className="content-state large"><Icon name="file" size={36} /><h3>当前资料库还没有文献</h3><p>导入 PDF、Markdown、TXT，或使用明确标注的自编教学样例。</p><button className="button primary" onClick={onOpenImport}>开始导入</button></div>
        : <div className="document-list">{documents.map((document) => <article className="document-row" key={document.id} data-testid="document-row" data-document-id={document.id}>
          <div className="document-icon"><Icon name="file" size={24} /></div>
          <div className="document-info">
            <h3>{document.title}</h3>
            <p>{document.filename}</p>
            <div className="document-tags"><span>{document.kind}</span>{document.pageCount && <span>{document.pageCount} 页</span>}<span>{document.paragraphCount} 段</span><span>{document.chunkCount} 个片段</span><span>{document.bookmarkCount} 个收藏</span>{document.status === 'deleting' && <span className="warning-tag">删除中，可重试</span>}</div>
          </div>
          <div className="document-actions">
            <button className="button quiet" onClick={() => onSearchDocument(document)} disabled={document.status !== 'ready'}><Icon name="search" />检索此资料</button>
            <button className="icon-button danger" aria-label={`删除 ${document.title}`} onClick={() => onDelete(document)}><Icon name="trash" /></button>
          </div>
        </article>)}</div>}
    </section>
  </>;
}

export function ReadingPage({ libraryId, bookmarks, onBookmarkChange, onNotify }) {
  const [passage, setPassage] = useState(null);
  const [loading, setLoading] = useState(false);
  const previewRef = useRef(null);
  const sequence = useRef(0);

  useEffect(() => {
    if (passage && !bookmarks.some((item) => item.id === passage.id)) setPassage(null);
  }, [bookmarks, passage]);

  const open = async (id) => {
    const current = ++sequence.current;
    setLoading(true);
    setPassage(null);
    try {
      const data = await api(libraryPath(libraryId, `/passages/${id}`));
      if (current !== sequence.current) return;
      setPassage(data.passage);
      if (window.matchMedia('(max-width: 780px)').matches) requestAnimationFrame(() => previewRef.current?.scrollIntoView({ behavior: 'smooth' }));
    } catch (error) {
      onNotify(error.message, 'error');
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  };

  const remove = async (item) => {
    try {
      await api(libraryPath(libraryId, `/bookmarks/${item.id}`), { method: 'PUT', body: JSON.stringify({ saved: false }) });
      await onBookmarkChange();
      onNotify('已从阅读清单移除。');
    } catch (error) {
      onNotify(error.message, 'error');
    }
  };

  return <>
    <header className="page-header"><div><p className="eyebrow">稍后精读</p><h1>阅读清单</h1><p className="subtitle">收藏保存在 seekdb 中，刷新和重启后仍可继续核对。</p></div><button className="button secondary" disabled={!bookmarks.length} onClick={() => downloadText('知页-阅读清单.md', resultsMarkdown('知页 · 阅读清单', bookmarks))}><Icon name="download" />导出清单</button></header>
    <div className="reading-workspace">
      <section className="page-section reading-list">
        <div className="section-heading"><h2>已收藏片段 <span>{bookmarks.length} 个</span></h2></div>
        {!bookmarks.length ? <div className="content-state large"><Icon name="bookmark" size={34} /><h3>阅读清单是空的</h3><p>在检索结果中点击书签，即可保存需要精读的原文片段。</p></div>
          : bookmarks.map((item, index) => <article className={passage?.id === item.id ? 'reading-item selected' : 'reading-item'} key={item.id} data-testid="bookmark-item">
            <span className="result-number">{String(index + 1).padStart(2, '0')}</span>
            <div><h3>{item.title}</h3><p className="result-meta">{item.filename} · {item.location}</p><p className="result-text">{item.text}</p><button className="text-button" onClick={() => open(item.id)}>查看原文 <Icon name="arrow" size={14} /></button></div>
            <button className="bookmark-button saved" aria-label={`取消收藏 ${item.title}`} onClick={() => remove(item)}><Icon name="bookmark" filled /></button>
          </article>)}
      </section>
      <SourcePreview ref={previewRef} passage={passage} loading={loading} onNotify={onNotify} />
    </div>
  </>;
}

export function GuidePage({ database, onOpenAudit }) {
  return <>
    <header className="page-header"><div><p className="eyebrow">可复现使用指南</p><h1>使用说明</h1><p className="subtitle">知页帮助找到原文证据，不生成未经资料支持的论文结论。</p></div></header>
    <div className="guide-grid">
      <section className="guide-card"><span className="guide-step">01</span><h2>创建资料库并导入</h2><p>在左侧切换或新建资料库。支持含可提取文字的 PDF、UTF-8 Markdown / TXT；每批 8 个文件，单个 10 MiB、200 页、30 万字符以内。</p><p>扫描 PDF 需要先 OCR。相同资料库内按规范化文本 SHA-256 去重，不同资料库可分别保存同一内容。</p></section>
      <section className="guide-card"><span className="guide-step">02</span><h2>选择检索方式</h2><p><strong>关键词：</strong>seekdb IK 全文检索，适合明确术语。</p><p><strong>语义：</strong>固定多语言 MiniLM 在本地 CPU 编码，HNSW 余弦近邻召回。</p><p><strong>混合：</strong>全文与向量各取 30 条候选，由数据库执行 RRF 融合。所有分支都按资料库与可选文献过滤。</p></section>
      <section className="guide-card"><span className="guide-step">03</span><h2>核对、收藏与导出</h2><p>点击“查看原文”检查完整源文、页码 / 段落、当前片段高亮和稳定 ID。复制引用、加入阅读清单或导出 Markdown。</p><p>距离和 RRF 只用于排序，不是事实可信度。语义检索可能返回不相关的近邻，必须阅读原文。</p></section>
      <section className="guide-card"><span className="guide-step">04</span><h2>数据与运行边界</h2><p>数据库：{database?.database || '连接后显示'}；应用默认仅监听 127.0.0.1:8791。原文、向量、收藏和审计都保存在 seekdb，不使用内存检索替身。</p><p>模型固定为 Xenova/paraphrase-multilingual-MiniLM-L12-v2，完整 revision 见检索记录。首次加载需联网；无需推理 API Key。</p><button className="text-button" onClick={onOpenAudit}>查看并导出真实操作记录 <Icon name="arrow" size={14} /></button></section>
    </div>
  </>;
}
