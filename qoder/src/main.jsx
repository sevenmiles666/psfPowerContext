import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  Search,
  Files,
  Bookmark,
  CircleHelp,
  Upload,
  ArrowRight,
  Download,
  Copy,
  X,
  FileText,
  Check,
  LoaderCircle,
  Activity,
} from "lucide-react";
import "./style.css";

const DEFAULT_QUERY = "如何减少检索增强生成中的幻觉？";
const MODES = [
  ["hybrid", "混合检索"],
  ["semantic", "语义检索"],
  ["keyword", "关键词检索"],
];
const NAV = [
  ["search", Search, "检索资料"],
  ["library", Files, "我的文献"],
  ["saved", Bookmark, "阅读清单"],
  ["help", CircleHelp, "使用说明"],
];
async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    ...options,
    headers:
      options.body instanceof FormData
        ? undefined
        : { "Content-Type": "application/json" },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求未完成");
  return value;
}
function download(name, content, type = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function location(item) {
  return `${item.kind} · ${item.page ? `第 ${item.page} 页 · ` : ""}第 ${item.paragraph} 段`;
}
function Highlight({ text, query }) {
  const terms = [
    ...new Set(
      (query.match(/[\p{Script=Han}]{2,}|[a-zA-Z][\w-]+/gu) || []).flatMap(
        (t) => (/\p{Script=Han}/u.test(t) ? t.match(/.{1,4}/gu) : [t]),
      ),
    ),
  ].filter((t) => t.length > 1);
  if (!terms.length) return text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text
    .split(new RegExp(`(${escaped.join("|")})`, "gi"))
    .map((part, index) =>
      terms.some((t) => t.toLowerCase() === part.toLowerCase()) ? (
        <mark key={index}>{part}</mark>
      ) : (
        part
      ),
    );
}

function App() {
  const [tab, setTab] = useState("search");
  const [documents, setDocuments] = useState([]);
  const [saved, setSaved] = useState([]);
  const [health, setHealth] = useState(null);
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [mode, setMode] = useState("hybrid");
  const [filter, setFilter] = useState("");
  const [results, setResults] = useState([]);
  const [trace, setTrace] = useState(null);
  const [searched, setSearched] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [files, setFiles] = useState([]);
  const [importResults, setImportResults] = useState([]);
  const [audit, setAudit] = useState(null);
  const [copied, setCopied] = useState(false);
  const previewSeq = useRef(0);
  const revealPreview = useRef(false);
  const dialogRef = useRef(null);
  const restoreFocus = useRef(null);
  const savedIds = new Set(saved.map((s) => s.id));
  async function refresh() {
    const [docs, marks, info] = await Promise.all([
      api("/documents"),
      api("/bookmarks"),
      api("/health"),
    ]);
    setDocuments(docs);
    setSaved(marks);
    setHealth(info);
  }
  useEffect(() => {
    refresh().catch((e) => setError("后端未就绪：" + e.message));
  }, []);
  useEffect(() => {
    if (importOpen) {
      restoreFocus.current = document.activeElement;
      dialogRef.current?.showModal();
    } else if (dialogRef.current?.open) {
      dialogRef.current.close();
      restoreFocus.current?.focus();
    }
  }, [importOpen]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (previewLoading || !preview || !revealPreview.current) return;
    revealPreview.current = false;
    if (window.matchMedia("(max-width: 760px)").matches) {
      document
        .querySelector(".source-panel")
        ?.scrollIntoView({ block: "start" });
    }
  }, [previewLoading, preview]);
  async function run(label, action) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  async function openPreview(item, reveal = false) {
    const seq = ++previewSeq.current;
    revealPreview.current = reveal;
    setPreviewLoading(true);
    setPreviewError("");
    setPreview({ ...item, pages: [] });
    try {
      const value = await api("/passages/" + item.id);
      if (seq === previewSeq.current) setPreview(value);
    } catch (e) {
      if (seq === previewSeq.current) setPreviewError(e.message);
    } finally {
      if (seq === previewSeq.current) {
        setPreviewLoading(false);
      }
    }
  }
  async function doSearch(event) {
    event?.preventDefault();
    await run("正在检索", async () => {
      const data = await api("/search", {
        method: "POST",
        body: JSON.stringify({ query, mode, documentId: filter || null }),
      });
      setResults(data.results);
      setTrace(data.trace);
      setSearched(true);
      setTab("search");
      if (data.results[0]) await openPreview(data.results[0]);
      else {
        ++previewSeq.current;
        setPreview(null);
      }
    });
  }
  async function seed() {
    await run("正在导入示例，首次使用需下载模型", async () => {
      const output = await api("/samples", { method: "POST" });
      await refresh();
      setImportResults(output.results);
      setNotice("示例已就绪，可以开始检索。");
    });
  }
  async function importFiles(event) {
    event.preventDefault();
    await run("正在解析并建立索引，首次使用需下载模型", async () => {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      const output = await api("/import", { method: "POST", body: form });
      setImportResults(output.results);
      await refresh();
      if (output.results.every((r) => !r.error)) {
        setFiles([]);
        setNotice("导入完成，检索索引已更新。");
      }
    });
  }
  async function toggleSave(item) {
    await run("正在更新阅读清单", async () => {
      await api("/bookmarks/" + item.id, {
        method: "PUT",
        body: JSON.stringify({ saved: !savedIds.has(item.id) }),
      });
      setSaved(await api("/bookmarks"));
      setNotice(savedIds.has(item.id) ? "已从阅读清单移除" : "已加入阅读清单");
    });
  }
  async function copyCitation(item) {
    try {
      await navigator.clipboard.writeText(item.citation);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("浏览器未允许复制，请使用导出结果保存引用。");
    }
  }
  function exportItems(items, name) {
    const content = `# ${name}\n\n导出时间：${new Date().toISOString()}\n${trace && tab === "search" ? `查询：${trace.query}\n模式：${trace.mode}\nseekdb 查询记录：${trace.id}\n` : ""}\n${items.map((item, i) => `## ${i + 1}. ${item.title}\n\n${item.citation}\n`).join("\n")}\n---\n引用来自导入文本，请核对原始文献。此文件不包含模型生成的回答。\n`;
    download(name + ".md", content);
    setNotice("已导出带来源的 Markdown 文件");
  }
  const activeResults = tab === "saved" ? saved : results;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setTab("search");
          }}
          aria-label="知页首页"
        >
          <BookOpen size={36} strokeWidth={1.6} />
          <span>
            <strong>知页</strong>
            <small>PaperTrail</small>
          </span>
        </a>
        <nav aria-label="主导航">
          {NAV.map(([key, Icon, title]) => (
            <button
              key={key}
              className={tab === key ? "nav-item active" : "nav-item"}
              onClick={() => {
                setTab(key);
                setAudit(null);
              }}
            >
              <Icon size={19} />
              <span>{title}</span>
              {key === "saved" && saved.length > 0 ? (
                <small>{saved.length}</small>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span>个人研究空间</span>
          <small>
            <i className={health ? "dot connected" : "dot"} />
            seekdb {health ? "已连接" : "等待连接"}
          </small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>文献与资料检索</span>
          <button
            className="outline accent"
            disabled={!!busy}
            onClick={() => {
              setImportOpen(true);
              setImportResults([]);
            }}
          >
            <Upload size={16} />
            导入资料
          </button>
        </header>
        <div className="workspace">
          <section className="intro">
            <h1>
              {tab === "library"
                ? "让知识，有迹可循。"
                : tab === "saved"
                  ? "值得留下的，每一段。"
                  : tab === "help"
                    ? "从这里，开始探索。"
                    : "从资料中，找到答案。"}
            </h1>
            <p>
              {tab === "library"
                ? "你的文献与笔记，汇集在同一个研究空间。"
                : tab === "saved"
                  ? "保存原文片段，慢慢构建自己的阅读脉络。"
                  : tab === "help"
                    ? "导入资料、检索原文，再把线索带回研究。"
                    : "让每一次检索，都有原文可循。"}
            </p>
          </section>
          {error ? (
            <div role="alert" className="message error">
              {error}
              <button aria-label="关闭错误提示" onClick={() => setError("")}>
                <X size={15} />
              </button>
            </div>
          ) : null}
          {notice ? (
            <div role="status" className="message success">
              {notice}
            </div>
          ) : null}
          {busy ? (
            <div role="status" className="busy">
              <LoaderCircle size={16} className="spin" />
              {busy}…
            </div>
          ) : null}
          {tab === "search" ? (
            <>
              <form className="search-form" onSubmit={doSearch}>
                <div className="search-row">
                  <label className="search-input">
                    <Search size={22} />
                    <input
                      aria-label="检索问题"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      maxLength={500}
                      placeholder="输入关键词，或描述你想找的内容"
                      required
                    />
                  </label>
                  <button
                    className="primary search-button"
                    disabled={!!busy || !documents.length}
                  >
                    检索
                    <ArrowRight size={17} />
                  </button>
                </div>
                <div className="search-options">
                  <div className="mode-tabs" aria-label="检索模式">
                    {MODES.map(([key, title]) => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={mode === key}
                        className={mode === key ? "selected" : ""}
                        onClick={() => setMode(key)}
                      >
                        {title}
                      </button>
                    ))}
                  </div>
                  <select
                    aria-label="资料范围"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="">全部资料</option>
                    {documents.map((doc) => (
                      <option key={doc.id} value={doc.id}>
                        {doc.title}
                      </option>
                    ))}
                  </select>
                </div>
              </form>
              {!documents.length ? (
                <div className="empty welcome">
                  <BookOpen size={38} strokeWidth={1.3} />
                  <h2>先放入一份资料，让线索浮现。</h2>
                  <p>
                    支持
                    PDF、Markdown、TXT。也可以用三篇自编笔记，体验检索到引用的完整流程。
                  </p>
                  <button className="primary" disabled={!!busy} onClick={seed}>
                    导入示例资料
                    <ArrowRight size={16} />
                  </button>
                  <small>
                    示例用于功能验证，不是已发表论文。首次使用会下载多语言模型。
                  </small>
                </div>
              ) : !searched ? (
                <div className="empty">
                  <Search size={32} strokeWidth={1.4} />
                  <h2>资料已就绪，开始一次检索。</h2>
                  <p>
                    已有 {documents.length} 份资料 ·
                    试试“如何减少检索增强生成中的幻觉？”
                  </p>
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={doSearch}
                  >
                    检索示例问题
                    <ArrowRight size={16} />
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
          {(tab === "search" && searched) || tab === "saved" ? (
            <div className="results-workspace">
              <section className="results-list">
                <div className="section-heading">
                  <h2>{tab === "saved" ? "阅读清单" : "检索结果"}</h2>
                  <span>
                    {activeResults.length} 个
                    {tab === "saved" ? "已收藏" : "相关"}段落
                  </span>
                  <button
                    className="outline accent export"
                    disabled={!activeResults.length}
                    onClick={() =>
                      exportItems(
                        activeResults,
                        tab === "saved" ? "阅读清单" : "检索结果",
                      )
                    }
                  >
                    <Download size={15} />
                    导出结果
                  </button>
                </div>
                {trace && tab === "search" ? (
                  <div className="trace-line">
                    <span>
                      seekdb · {MODES.find(([k]) => k === trace.mode)?.[1]} ·{" "}
                      {trace.dbMs} ms
                    </span>
                    <button
                      className="text-button"
                      onClick={() =>
                        run("读取检索记录", async () =>
                          setAudit(await api("/audit")),
                        )
                      }
                    >
                      查看检索记录
                      <ArrowRight size={13} />
                    </button>
                  </div>
                ) : null}
                {!activeResults.length ? (
                  <div className="empty compact">
                    <Bookmark size={28} />
                    <h3>
                      {tab === "saved"
                        ? "把有用的段落留在这里。"
                        : "没有找到匹配的段落。"}
                    </h3>
                    <p>
                      {tab === "saved"
                        ? "在检索结果中点击书签，即可加入阅读清单。"
                        : "试试更短的关键词，或切换为语义检索。"}
                    </p>
                  </div>
                ) : (
                  activeResults.map((item, i) => (
                    <article
                      className={
                        "result " + (preview?.id === item.id ? "current" : "")
                      }
                      key={item.id}
                    >
                      <span className="result-number">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div className="result-body">
                        <button
                          className="result-title"
                          onClick={() => openPreview(item, true)}
                        >
                          {item.title}
                        </button>
                        <div className="metadata">{location(item)}</div>
                        <p>
                          <Highlight
                            text={item.text}
                            query={tab === "search" ? trace?.query || "" : ""}
                          />
                        </p>
                        <div className="result-actions">
                          <button
                            className="text-button"
                            onClick={() => openPreview(item, true)}
                          >
                            查看原文
                            <ArrowRight size={15} />
                          </button>
                          <button
                            className={
                              "icon-button save-button " +
                              (savedIds.has(item.id) ? "saved" : "")
                            }
                            disabled={!!busy}
                            aria-label={
                              savedIds.has(item.id)
                                ? "取消收藏 " + item.title
                                : "收藏 " + item.title
                            }
                            aria-pressed={savedIds.has(item.id)}
                            onClick={() => toggleSave(item)}
                          >
                            <Bookmark
                              size={20}
                              fill={
                                savedIds.has(item.id) ? "currentColor" : "none"
                              }
                            />
                          </button>
                        </div>
                      </div>
                    </article>
                  ))
                )}
              </section>
              <aside
                className={"source-panel " + (preview ? "has-preview" : "")}
              >
                <div className="section-heading">
                  <h2>原文预览</h2>
                  <button
                    className="icon-button close-preview"
                    aria-label="关闭原文预览"
                    onClick={() => {
                      ++previewSeq.current;
                      setPreview(null);
                      document
                        .querySelector(".results-workspace")
                        ?.scrollIntoView({ block: "start" });
                    }}
                  >
                    <X size={18} />
                  </button>
                </div>
                {preview ? (
                  <>
                    <div className="source-title">
                      <FileText size={23} />
                      <div>
                        <h3>{preview.title}</h3>
                        <p>
                          {preview.filename}
                          <br />
                          {location(preview)}
                        </p>
                      </div>
                    </div>
                    {previewLoading ? (
                      <p className="muted">正在读取原文…</p>
                    ) : previewError ? (
                      <p role="alert" className="error-text">
                        {previewError}
                      </p>
                    ) : (
                      <div className="source-content">
                        {preview.pages
                          .filter((p) => p.page === preview.page)
                          .map((p, i) => (
                            <div key={i}>
                              {p.text
                                .split(/\n\s*\n/)
                                .map((paragraph, index) => (
                                  <p
                                    key={index}
                                    className={
                                      index + 1 === preview.paragraph
                                        ? "source-highlight"
                                        : ""
                                    }
                                  >
                                    {paragraph}
                                  </p>
                                ))}
                            </div>
                          ))}
                      </div>
                    )}
                    <button
                      className="outline accent citation-button"
                      onClick={() => copyCitation(preview)}
                    >
                      {copied ? <Check size={17} /> : <Copy size={17} />}{" "}
                      {copied ? "已复制引用" : "复制引用"}
                    </button>
                    <small className="source-note">
                      检索结果来自导入的原文，请核对来源。
                    </small>
                  </>
                ) : (
                  <div className="empty compact">
                    <FileText size={30} />
                    <p>选择一个段落，阅读原文上下文。</p>
                  </div>
                )}
              </aside>
            </div>
          ) : null}
          {tab === "library" ? (
            <section className="library">
              <div className="section-heading">
                <h2>我的文献</h2>
                <span>
                  {documents.length} 份资料 ·{" "}
                  {documents.reduce((n, d) => n + d.chunks, 0)} 个片段
                </span>
                <button
                  className="text-button export"
                  onClick={seed}
                  disabled={!!busy}
                >
                  导入示例资料
                  <ArrowRight size={15} />
                </button>
              </div>
              {documents.length ? (
                <div className="document-table">
                  {documents.map((doc) => (
                    <div className="document-row" key={doc.id}>
                      <div className="file-symbol">
                        <FileText size={23} />
                      </div>
                      <div>
                        <h3>{doc.title}</h3>
                        <p>
                          {doc.filename} · {doc.kind} · {doc.chunks} 个片段
                        </p>
                      </div>
                      <button
                        className="outline"
                        disabled={!!busy}
                        onClick={() => {
                          setFilter(doc.id);
                          setTab("search");
                          setSearched(false);
                        }}
                      >
                        检索此资料
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <Files size={32} />
                  <h3>你的资料库还是空的。</h3>
                  <p>点击“导入资料”，添加第一份文献或笔记。</p>
                </div>
              )}
            </section>
          ) : null}
          {tab === "help" ? (
            <section className="help-content">
              <h2>一个可以核对的检索流程</h2>
              <ol>
                <li>
                  <strong>导入资料</strong>
                  <p>
                    上传含可提取文字的 PDF，或 UTF-8 编码的
                    Markdown、TXT。每次最多 8 个文件，单个 10 MiB、30
                    万字符，PDF 最多 200 页。扫描 PDF 需先 OCR。
                  </p>
                </li>
                <li>
                  <strong>选择检索方式</strong>
                  <p>
                    关键词检索用于术语匹配；语义检索用多语言模型理解近似表达；混合检索由
                    seekdb 将全文与向量候选进行 RRF
                    排名融合。所有资料与索引持久保存在 seekdb。
                  </p>
                </li>
                <li>
                  <strong>回到原文</strong>
                  <p>
                    点击段落预览上下文，复制带文件名和页码/段落的引用。Markdown/TXT
                    使用段落定位；PDF
                    使用提取文本的页码与段落定位，不是原始版面查看器。
                  </p>
                </li>
                <li>
                  <strong>留下研究线索</strong>
                  <p>
                    点击书签保存片段，阅读清单在刷新和重启后保留。导出 Markdown
                    时携带片段来源与检索记录编号。
                  </p>
                </li>
              </ol>
              <div className="help-note">
                <h3>来源透明，结果可追溯</h3>
                <p>
                  此工具检索原文，不生成论文结论。向量距离和排序分数不表示事实可信度。无相关资料时应核对问题与来源。
                </p>
                <button
                  className="outline"
                  onClick={() =>
                    run("读取记录", async () => setAudit(await api("/audit")))
                  }
                >
                  <Activity size={16} />
                  查看技术验证记录
                </button>
              </div>
              <p className="muted">
                模型：Xenova/paraphrase-multilingual-MiniLM-L12-v2 · 384 维 ·
                本地 CPU
                推理。首次使用需联网下载模型，文献文本不发往推理服务。当前版本为单人本机工作空间。
              </p>
              <a
                href="https://github.com/sevenmiles666/psfPowerContext/tree/2026-competition-ecosystem/qoder"
                target="_blank"
                rel="noreferrer"
                className="text-button"
              >
                项目源码与运行说明
                <ArrowRight size={15} />
              </a>
            </section>
          ) : null}
          {audit ? (
            <section className="audit-panel">
              <div className="section-heading">
                <h2>seekdb 操作记录</h2>
                <button
                  className="text-button export"
                  onClick={() =>
                    download(
                      "seekdb-audit.json",
                      JSON.stringify(audit, null, 2),
                      "application/json",
                    )
                  }
                >
                  导出 JSON
                  <Download size={15} />
                </button>
                <button
                  className="icon-button"
                  aria-label="关闭操作记录"
                  onClick={() => setAudit(null)}
                >
                  <X size={17} />
                </button>
              </div>
              <p className="muted">
                最近 30
                条真实写入/查询记录，包含候选结果编号、检索方式与耗时。仅代表本机验证，不是使用效果数据。
              </p>
              <pre>{JSON.stringify(audit, null, 2)}</pre>
            </section>
          ) : null}
        </div>
      </main>
      <dialog
        ref={dialogRef}
        className="import-dialog"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setImportOpen(false);
        }}
        onClose={() => setImportOpen(false)}
      >
        <div className="dialog-heading">
          <div>
            <h2>把资料放进研究空间</h2>
            <p>保留原文出处，建立可检索的知识线索。</p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭导入"
            disabled={!!busy}
            onClick={() => setImportOpen(false)}
          >
            <X size={21} />
          </button>
        </div>
        <form onSubmit={importFiles}>
          <label className="dropzone">
            <Upload size={29} strokeWidth={1.5} />
            <strong>选择论文、笔记或实验记录</strong>
            <span>PDF / Markdown / TXT · 单个最多 10 MiB</span>
            <input
              type="file"
              aria-label="选择资料文件"
              accept=".pdf,.md,.markdown,.txt"
              multiple
              disabled={!!busy}
              onChange={(e) => {
                setFiles(Array.from(e.target.files || []));
                setImportResults([]);
              }}
            />
          </label>
          {files.length ? (
            <ul className="file-list">
              {files.map((file, i) => (
                <li key={i}>
                  <FileText size={16} />
                  {file.name}
                  <span>{Math.ceil(file.size / 1024)} KB</span>
                </li>
              ))}
            </ul>
          ) : null}
          {importResults.map((r, i) => (
            <p key={i} className={r.error ? "error-text" : "import-success"}>
              {r.filename || r.title}：
              {r.error ||
                (r.duplicate ? "已存在，已跳过" : `已导入 ${r.chunks} 个片段`)}
            </p>
          ))}
          {busy ? (
            <p role="status" className="busy">
              <LoaderCircle size={16} className="spin" />
              {busy}…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="error-text">
              {error}
            </p>
          ) : null}
          <div className="dialog-footer">
            <button
              type="button"
              className="text-button"
              disabled={!!busy}
              onClick={seed}
            >
              先试试示例资料
            </button>
            <button
              className="primary"
              type="submit"
              disabled={!files.length || files.length > 8 || !!busy}
            >
              导入并建立索引
              <ArrowRight size={16} />
            </button>
          </div>
        </form>
        <small className="muted">
          仅处理你有权使用的资料。相同文件内容自动去重；首次加载模型可能需要几分钟。
        </small>
      </dialog>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
