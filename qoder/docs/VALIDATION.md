# 评审验证样例

按 `../README.md` 启动应用与 seekdb。使用自编公开样例，不需要真实论文或 API Key。

## 初始数据

`samples/rag-notes.md`、`samples/hybrid-search.md`、`samples/evaluation.md`，各 5 个片段，共 3 份、15 个片段（全新资料库）。它们明确标注自编示例，引用文本可以直接与文件比对。

## 手动验证

| 步骤 | 输入与操作 | 预期结果 / 核对点 |
| --- | --- | --- |
| 1 | 点击「导入示例资料」 | 文献页出现 3 篇，原文、片段、索引写入 seekdb；首次需下载模型 |
| 2 | 再次导入示例 | 每篇显示「已存在，已跳过」，文献和片段数不增加 |
| 3 | 混合检索「如何减少检索增强生成中的幻觉？」 | 返回讨论幻觉、来源核对的原文；第一批结果应包含《RAG 实践笔记》等自编资料，具体排名以实际模型输出为准 |
| 4 | 关键词检索「幻觉」 | 结果原文包含匹配术语；检索记录显示 fulltext only |
| 5 | 语义检索「如何避免模型编造事实」 | 召回涉及幻觉/事实核对的片段，记录显示 HNSW cosine |
| 6 | 资料范围选「RAG 实践笔记」，分别运行三种模式 | 所有结果的来源均为此文档 |
| 7 | 关键词检索 `unfindablezzzz987654321` | 显示没有匹配的段落，不生成答案 |
| 8 | 点击任意结果「查看原文」 | 段落文本存在于源文件；右侧高亮对应段落，展示文件名/段落号 |
| 9 | 复制引用并导出结果 | 引用带文件名、页码（若有）、段落、片段 ID 和逐字原文；Markdown 导出另含查询记录编号 |
| 10 | 收藏一个片段，刷新，再重启应用 | 阅读清单仍有该片段；数据来自 seekdb，不依赖浏览器 localStorage |
| 11 | 「查看检索记录」并导出 JSON | 存在真实 query、mode、resultIds、dbMs、elapsedMs、模型 revision 与 RRF 配置，可和结果 ID 对照 |

## 自动验证

保持应用运行，执行 `npm test` 与 `npm run verify`。接口验收另生成一个**两页有效 PDF**，检索 `retrieval` 后断言引用为第 2 页；上传不支持扩展名、空白文件并检查单文件错误；上传包含 `<script>` 的文本供浏览器验证 React 转义。

`npm run verify:browser`（环境配置见 README）继续验证实际 DOM 与下载、剪贴板、中文文件名、收藏刷新、语义筛选、空结果、脚本转义及 390px 手机布局。

再次启动应用后运行 `npm run verify:persistence`；不要删除 `.data/verification-state.json` 或数据库卷。此项读取上一次验收保存的片段 ID，不制造新的文档/收藏。

## 证据含义

- `evidence/verification.json`：本机接口验收和样例检索的真实结果，不含真实用户效果数据。
- `docs/screenshots/`：由实际浏览器运行生成，非设计稿截图。
- `docs/design/concept.png`：AI 生成的界面参考，仅作为设计来源，不能证明功能或 Qoder 使用。
- Qoder 对话、UID、公开站点和真实用户材料须独立补齐；见 `SUBMISSION.md`。
