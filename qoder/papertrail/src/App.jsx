import React, { useCallback, useEffect, useState } from 'react';
import { api, libraryPath, uploadFiles } from './api.js';
import { Icon } from './icons.jsx';
import SearchPage from './SearchPage.jsx';
import { DocumentsPage, GuidePage, ReadingPage } from './Pages.jsx';
import { AuditDialog, DeleteDialog, ImportDialog, NewLibraryDialog } from './Dialogs.jsx';

const navigation = [
  ['search', '检索资料', 'search'],
  ['documents', '我的文献', 'file'],
  ['reading', '阅读清单', 'bookmark'],
  ['guide', '使用说明', 'help'],
];

export default function App() {
  const [libraries, setLibraries] = useState([]);
  const [currentLibraryId, setCurrentLibraryId] = useState('');
  const [documents, setDocuments] = useState([]);
  const [bookmarks, setBookmarks] = useState([]);
  const [page, setPage] = useState('search');
  const [searchDocumentId, setSearchDocumentId] = useState('');
  const [health, setHealth] = useState(null);
  const [booting, setBooting] = useState(true);
  const [fatalError, setFatalError] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [newLibraryOpen, setNewLibraryOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [toast, setToast] = useState(null);

  const currentLibrary = libraries.find((library) => library.id === currentLibraryId);
  const notify = useCallback((message, type = 'success') => setToast({ message, type, id: Date.now() }), []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api('/api/health'));
    } catch {
      setHealth(null);
    }
  }, []);

  const refreshLibraries = useCallback(async () => {
    const data = await api('/api/libraries');
    setLibraries(data.libraries);
    setCurrentLibraryId((current) => data.libraries.some((item) => item.id === current) ? current : data.libraries[0]?.id || '');
    return data.libraries;
  }, []);

  const refreshCurrent = useCallback(async () => {
    if (!currentLibraryId) return;
    const [documentData, bookmarkData] = await Promise.all([
      api(libraryPath(currentLibraryId, '/documents')),
      api(libraryPath(currentLibraryId, '/bookmarks')),
    ]);
    setDocuments(documentData.documents);
    setBookmarks(bookmarkData.bookmarks);
  }, [currentLibraryId]);

  useEffect(() => {
    Promise.all([refreshLibraries(), refreshHealth()])
      .catch((error) => setFatalError(error.message))
      .finally(() => setBooting(false));
    const timer = setInterval(refreshHealth, 4000);
    return () => clearInterval(timer);
  }, [refreshLibraries, refreshHealth]);

  useEffect(() => {
    setDocuments([]);
    setBookmarks([]);
    if (currentLibraryId) refreshCurrent().catch((error) => notify(error.message, 'error'));
  }, [currentLibraryId, refreshCurrent, notify]);

  const switchLibrary = (id) => {
    setCurrentLibraryId(id);
    setSearchDocumentId('');
    setPage('search');
  };

  const createLibrary = async (name) => {
    const data = await api('/api/libraries', { method: 'POST', body: JSON.stringify({ name }) });
    await refreshLibraries();
    switchLibrary(data.library.id);
    setNewLibraryOpen(false);
    notify(`已创建资料库“${data.library.name}”。`);
  };

  const afterContentChange = async () => {
    await Promise.all([refreshCurrent(), refreshLibraries(), refreshHealth()]);
  };

  const importDocuments = async (files) => {
    const result = await uploadFiles(currentLibraryId, files);
    await afterContentChange();
    return result;
  };

  const importSamples = async () => {
    const result = await api(libraryPath(currentLibraryId, '/samples'), { method: 'POST', body: JSON.stringify({}) });
    await afterContentChange();
    return result;
  };

  const bookmarkChanged = async () => {
    await afterContentChange();
  };

  const deleteDocument = async (document) => {
    const result = await api(libraryPath(currentLibraryId, `/documents/${document.id}`), { method: 'DELETE' });
    await afterContentChange();
    setDeleteTarget(null);
    notify(result.deleted ? `已删除“${document.title}”及相关片段与收藏。` : '文献已被删除，无需重复操作。');
  };

  const searchDocument = (document) => {
    setSearchDocumentId(document.id);
    setPage('search');
  };

  const loadAudit = useCallback(() => api(libraryPath(currentLibraryId, '/audit')), [currentLibraryId]);
  const activePage = navigation.find(([id]) => id === page);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><Icon name="book" size={32} /><div><strong>知页</strong><span>PaperTrail</span></div></div>
      <div className="library-switcher">
        <label htmlFor="current-library">当前资料库</label>
        <div><select id="current-library" data-testid="library-switcher" value={currentLibraryId} onChange={(event) => switchLibrary(event.target.value)} disabled={!libraries.length}>{libraries.map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}</select><button className="icon-button" aria-label="新建资料库" onClick={() => setNewLibraryOpen(true)}><Icon name="plus" /></button></div>
      </div>
      <nav className="main-nav" aria-label="主要导航">
        {navigation.map(([id, label, icon]) => <button key={id} className={page === id ? 'nav-item active' : 'nav-item'} onClick={() => { setPage(id); if (id !== 'search') setSearchDocumentId(''); }}><Icon name={icon} /><span>{label}</span>{id === 'reading' && <small>{currentLibrary?.bookmarkCount || 0}</small>}</button>)}
      </nav>
      <div className="sidebar-footer"><p>个人研究空间</p><span className={health ? 'connection online' : 'connection'}><i />{health ? 'seekdb 已连接' : 'seekdb 未连接'}</span>{health?.database && <code>{health.database.database}</code>}</div>
    </aside>

    <main className="main-surface">
      <div className="topbar"><span>{activePage?.[1]}</span><button className="button secondary mobile-import" onClick={() => setImportOpen(true)} disabled={!currentLibraryId}><Icon name="upload" />导入资料</button></div>
      {health?.model?.status === 'loading' && <div className="global-banner"><span className="spinner" />{health.model.message}</div>}
      {toast && <div className={`toast ${toast.type}`} role="status">{toast.message}</div>}

      {booting ? <div className="content-state app-loading"><span className="spinner" /><h2>正在连接知页</h2><p>读取资料库与 seekdb 状态…</p></div>
        : fatalError ? <div className="content-state app-loading error-state"><Icon name="database" size={38} /><h2>数据库不可用</h2><p>{fatalError}</p><p>应用不会回退到内存模拟检索。请检查 seekdb 配置后重试。</p><button className="button primary" onClick={() => window.location.reload()}>重新连接</button></div>
          : <div className="page-content">
            {page === 'search' && currentLibraryId && <SearchPage key={currentLibraryId} libraryId={currentLibraryId} documents={documents} initialDocumentId={searchDocumentId} onOpenImport={() => setImportOpen(true)} onOpenAudit={() => setAuditOpen(true)} onBookmarkChange={bookmarkChanged} onNotify={notify} />}
            {page === 'documents' && <DocumentsPage libraryId={currentLibraryId} documents={documents} onOpenImport={() => setImportOpen(true)} onSearchDocument={searchDocument} onDelete={setDeleteTarget} />}
            {page === 'reading' && currentLibraryId && <ReadingPage libraryId={currentLibraryId} bookmarks={bookmarks} onBookmarkChange={bookmarkChanged} onNotify={notify} />}
            {page === 'guide' && <GuidePage database={health?.database} onOpenAudit={() => setAuditOpen(true)} />}
          </div>}
    </main>

    <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={importDocuments} onSamples={importSamples} model={health?.model} />
    <NewLibraryDialog open={newLibraryOpen} onClose={() => setNewLibraryOpen(false)} onCreate={createLibrary} />
    <DeleteDialog document={deleteTarget} libraryName={currentLibrary?.name || ''} onClose={() => setDeleteTarget(null)} onConfirm={deleteDocument} />
    <AuditDialog open={auditOpen} onClose={() => setAuditOpen(false)} onLoad={loadAudit} libraryName={currentLibrary?.name || ''} />
  </div>;
}
