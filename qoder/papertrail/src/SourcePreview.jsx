import React, { forwardRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { copyText } from './utils.js';

function SourceText({ passage }) {
  const { sourceText, paragraphStart, paragraphEnd, sourceStart, sourceEnd } = passage;
  const before = sourceText.slice(0, paragraphStart);
  const paragraph = sourceText.slice(paragraphStart, paragraphEnd);
  const after = sourceText.slice(paragraphEnd);
  const chunkOffset = sourceStart - paragraphStart;
  const chunkLength = sourceEnd - sourceStart;

  return <div className="source-text" data-testid="source-text">
    {before && <div className="source-context">{before}</div>}
    <div className="source-paragraph">
      {paragraph.slice(0, chunkOffset)}
      <mark>{paragraph.slice(chunkOffset, chunkOffset + chunkLength)}</mark>
      {paragraph.slice(chunkOffset + chunkLength)}
    </div>
    {after && <div className="source-context">{after}</div>}
  </div>;
}

const SourcePreview = forwardRef(function SourcePreview({ passage, loading, onNotify, title = '原文预览' }, ref) {
  const [copying, setCopying] = useState(false);
  const copyCitation = async () => {
    if (!passage) return;
    setCopying(true);
    try {
      await copyText(passage.citation);
      onNotify('引用已复制，包含逐字原文与稳定定位。');
    } catch (error) {
      onNotify(error.message, 'error');
    } finally {
      setCopying(false);
    }
  };

  return <section className="source-preview" ref={ref} aria-label={title}>
    <div className="section-heading"><h2>{title}</h2>{passage && <span className="source-kind">{passage.kind}</span>}</div>
    {loading && <div className="preview-state"><span className="spinner" />正在读取完整源文…</div>}
    {!loading && !passage && <div className="preview-state empty-preview"><Icon name="book" size={30} /><p>选择一个检索片段，<br />在这里核对原文上下文。</p></div>}
    {!loading && passage && <>
      <div className="source-meta">
        <h3>{passage.title}</h3>
        <p>{passage.filename}</p>
        <p>{passage.location}</p>
        <code>{passage.id}</code>
      </div>
      <SourceText passage={passage} />
      <div className="source-actions">
        <button className="button secondary full" onClick={copyCitation} disabled={copying}><Icon name="copy" />{copying ? '复制中…' : '复制引用'}</button>
        <p>高亮为当前片段，浅色区域为原段落。请结合上下文核对。</p>
      </div>
    </>}
  </section>;
});

export default SourcePreview;
