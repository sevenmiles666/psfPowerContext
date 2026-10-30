import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { downloadText, formatBytes } from './utils.js';

function Dialog({ open, onClose, title, children, className = '', busy = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className={`dialog ${className}`} onClose={onClose} onCancel={(event) => { if (busy) event.preventDefault(); }}>
    <div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label={`关闭${title}`} onClick={onClose} disabled={busy}><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

export function ImportDialog({ open, onClose, onImport, onSamples, model }) {
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setFiles([]);
      setResults([]);
      setError('');
    }
  }, [open]);

  const choose = (event) => {
    const selected = Array.from(event.target.files || []);
    if (selected.length > 8) return setError('每批最多选择 8 个文件。');
    if (selected.some((file) => file.size > 10 * 1024 * 1024)) return setError('单个文件不能超过 10 MiB。');
    setFiles(selected);
    setResults([]);
    setError('');
  };

  const submit = async (work) => {
    setBusy(true);
    setError('');
    try {
      const data = await work();
      setResults(data.results);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onClose={onClose} title="导入资料" busy={busy} className="import-dialog">
    <div className="dialog-body">
      <p className="dialog-intro">文件只在当前本机应用中处理，文本与向量写入当前资料库的 seekdb。</p>
      <label className="file-drop">
        <Icon name="upload" size={28} />
        <strong>选择 PDF、Markdown 或 TXT</strong>
        <span>每批 8 个；单个 10 MiB、200 页、30 万字符以内</span>
        <input type="file" data-testid="file-input" accept=".pdf,.md,.markdown,.txt" multiple onChange={choose} disabled={busy} />
      </label>
      {files.length > 0 && <ul className="selected-files">{files.map((file) => <li key={`${file.name}-${file.lastModified}`}><Icon name="file" /><span>{file.name}</span><small>{formatBytes(file.size)}</small></li>)}</ul>}
      {busy && <div className="model-progress"><span className="spinner" /><div><strong>正在导入，请勿关闭</strong><p>{model?.message || '正在提取文本并写入 seekdb…'}</p></div></div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      {results.length > 0 && <div className="import-results" data-testid="import-results"><h3>单文件导入结果</h3>{results.map((result, index) => <div className={`import-result ${result.status}`} key={`${result.filename}-${index}`}><Icon name={result.status === 'error' ? 'close' : 'check'} /><div><strong>{result.filename}</strong><p>{result.status === 'imported' ? `已导入 ${result.chunkCount} 个片段，索引已刷新。` : result.status === 'duplicate' ? '内容摘要已存在，已跳过；片段数未增加。' : result.error}</p></div></div>)}</div>}
      <div className="sample-box"><div><strong>没有手头资料？</strong><p>导入三份明确标注的自编教学样例，不冒充发表论文。</p></div><button className="button quiet" onClick={() => submit(onSamples)} disabled={busy}>导入自编样例</button></div>
    </div>
    <div className="dialog-footer"><button className="button secondary" onClick={onClose} disabled={busy}>关闭</button><button className="button primary" data-testid="upload-submit" onClick={() => submit(() => onImport(files))} disabled={busy || !files.length}><Icon name="upload" />{busy ? '导入中…' : `导入 ${files.length || ''} 个文件`}</button></div>
  </Dialog>;
}

export function NewLibraryDialog({ open, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setName(''); setError(''); } }, [open]);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onCreate(name);
    } catch (createError) {
      setError(createError.message);
    } finally {
      setBusy(false);
    }
  };
  return <Dialog open={open} onClose={onClose} title="新建资料库" busy={busy}>
    <form onSubmit={submit}>
      <div className="dialog-body"><label className="field-label" htmlFor="library-name">资料库名称</label><input id="library-name" className="text-input" data-testid="library-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：课程笔记" maxLength={80} autoFocus required /><p className="field-help">文档、片段、收藏和检索记录都会与这个资料库关联。</p>{error && <div className="form-error">{error}</div>}</div>
      <div className="dialog-footer"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button className="button primary" data-testid="create-library" disabled={busy || !name.trim()}>{busy ? '创建中…' : '创建资料库'}</button></div>
    </form>
  </Dialog>;
}

export function DeleteDialog({ document, libraryName, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (document) setError(''); }, [document]);
  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm(document);
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setBusy(false);
    }
  };
  return <Dialog open={Boolean(document)} onClose={onClose} title="确认删除文献" busy={busy}>
    <div className="dialog-body"><div className="delete-warning"><Icon name="trash" size={26} /><div><p>将从资料库 <strong>“{libraryName}”</strong> 中删除：</p><h3>{document?.title}</h3><p>{document?.filename}</p></div></div><p>此操作会清理该文献的 <strong>{document?.chunkCount} 个片段</strong>和 <strong>{document?.bookmarkCount} 个收藏</strong>，检索记录保留用于审计。其他资料库中的同名或同内容文献不受影响。</p>{error && <div className="form-error">{error}</div>}</div>
    <div className="dialog-footer"><button className="button secondary" onClick={onClose} disabled={busy}>取消</button><button className="button danger-fill" data-testid="confirm-delete" onClick={confirm} disabled={busy}>{busy ? '删除中…' : '确认删除此文献'}</button></div>
  </Dialog>;
}

export function AuditDialog({ open, onClose, onLoad, libraryName }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError('');
    onLoad().then((data) => setRecords(data.audit)).catch((loadError) => setError(loadError.message)).finally(() => setLoading(false));
  }, [open, onLoad]);
  const exportJson = () => downloadText('知页-seekdb-操作记录.json', JSON.stringify({ library: libraryName, exportedAt: new Date().toISOString(), records }, null, 2), 'application/json;charset=utf-8');
  return <Dialog open={open} onClose={onClose} title="真实操作记录" className="audit-dialog">
    <div className="dialog-body"><p className="dialog-intro">记录来自当前资料库的 seekdb 审计表。数据库耗时与含模型计算的总耗时分别保存。</p><div className="audit-actions"><button className="button quiet" onClick={exportJson} disabled={!records.length} data-testid="export-audit"><Icon name="download" />导出 JSON</button></div>
      {loading && <div className="content-state"><span className="spinner" />正在读取记录…</div>}{error && <div className="form-error">{error}</div>}{!loading && !records.length && !error && <div className="content-state"><p>当前资料库还没有操作记录。</p></div>}
      <div className="audit-list">{records.map((record) => <details key={record.id} className="audit-record"><summary><span className={`audit-type ${record.operation}`}>{record.operation}</span><span>{record.detail.query || record.detail.filename || record.detail.status}</span><time>{new Date(record.createdAt).toLocaleString('zh-CN')}</time></summary><div className="audit-detail"><code>{record.id}</code>{record.detail.mode && <p>模式：{record.detail.mode} · 数据库 {record.detail.dbMs} ms · 总计 {record.detail.elapsedMs} ms</p>}{record.detail.modelSignature && <p>模型：{record.detail.modelSignature}</p>}{record.detail.rrf && <p>RRF：window={record.detail.rrf.rankWindowSize}，k={record.detail.rrf.rankConstant}</p>}<p>片段 ID：{record.detail.resultIds?.join(', ') || record.detail.chunkIds?.join(', ') || '—'}</p><pre>{JSON.stringify(record.detail, null, 2)}</pre></div></details>)}</div>
    </div>
  </Dialog>;
}
