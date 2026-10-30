# Qoder 正式版本验收说明

本文件只记录 `qoder/papertrail/` 正式版本的实际验证，不复用 `qoder/` 根目录 Codex 原型的结果。所有导入文献均为自编教学或测试材料，不冒充发表论文，不代表真实用户效果。

## 最新结果

验证日期：2026-10-29。

| 命令 / 环节 | 实测结果 | 原始证据 |
| --- | --- | --- |
| `npm test` | 6/6 通过 | 终端输出；`tests/text.test.mjs` |
| `npm run verify` | 34/34 通过 | `evidence/verification.json` |
| 应用与 seekdb 实际重启后 `npm run verify:persistence` | 9/9 通过 | `evidence/persistence.json` |
| `npm run verify:browser` | 19/19 通过 | `evidence/browser.json`、真实截图 |
| `npm run build` | 成功，36 个模块完成转换 | 终端输出；`dist/` |

实测数据库为 `5.7.25-OceanBase seekdb-v1.4.0.0`，数据库 `qoder_papertrail_qoder`，Collection `ptq_passages_34c9e32ff8`。模型签名和每项检查 ID 以 JSON 中的最新记录为准。

## 1. 单元测试

`npm test` 覆盖：

- CRLF 归一化与空段忽略。
- 长段落连续切片且不丢失原文。
- 优先保留句子边界。
- 严格 UTF-8 解码和文件错误。
- 文档/片段 ID 稳定性与资料库隔离。
- 引用包含逐字原文和稳定定位。

## 2. 真实 seekdb 接口验收

先启动正式应用，再执行 `npm run verify`。脚本每次新建带唯一后缀的两个资料库，避免依赖旧测试数据。

34 项检查覆盖：

- seekdb 1.4 健康检查与两个独立主题资料库。
- 三份自编样例真实导入、向量生成和索引刷新。
- 重复导入按内容摘要去重，文献数与片段数不增加。
- 关键词、语义、混合检索均返回当前库片段，并支持指定文献过滤。
- 混合检索记录数据库 RRF 参数：候选窗口 30、常数 60、公式 `1/(60+branchRank)`。
- 无关关键词返回空结果，不生成替代答案。
- 完整文件名、定位和 `sourceText.slice(sourceStart, sourceEnd)` 与命中片段逐字一致。
- 同一内容可独立存在于另一资料库；三种检索不返回第二库独有片段。
- 收藏按资料库隔离；删除清理索引与收藏，重复删除幂等，不能跨库删除。
- pdf-lib 生成的真实两页 PDF 可导入，引用定位第 2 页，长段落偏移一致。
- 长 Markdown 段落实际拆成多个片段，并可按稳定片段编号定位。
- DOCX、空白 Markdown、无文字 PDF、超长文本均明确失败，不产生零片段成功文献。
- 中文文件名 `转义与定位样例.md` 原样保存；HTML/脚本字符串作为可检索文本保留。
- 审计含资料库、查询、模式、模型、结果 ID、数据库耗时与总耗时；导入、异常和删除均有记录。

结果写入 `evidence/verification.json`，最新测试状态写入被 Git 忽略的 `.data/verification-state.json`，供后续两项验收使用。

## 3. 应用与数据库重启持久化

本轮实际停止正式应用，执行：

```sh
docker restart qoder-papertrail-seekdb
```

随后重新启动正式应用，再执行：

```sh
npm run verify:persistence
```

9 项检查确认：应用与 seekdb 可用，资料库、Markdown/PDF/中文名文献、收藏均保留，原文偏移仍逐字一致，全文索引可检索，已删除文献没有恢复。

`verify:persistence` 是检查脚本，不会自动重启服务。复现时应先运行接口验收，再真实重启应用和所使用的数据库。

## 4. 真实浏览器验收

```sh
npm run verify:browser
```

本次使用本机 Edge，通过 Playwright 操作真实页面，不使用静态模拟响应。19 项检查覆盖：

- 1440×1000 桌面检索、首个结果与原文高亮逐字一致。
- 真实剪贴板引用包含原文、文件名和稳定 ID。
- 检索结果、审计 JSON、阅读清单均产生真实下载并检查内容。
- 收藏与取消收藏调用真实 API。
- 切换资料库后文献列表不显示他库或已删除文献。
- 中文名 Markdown 上传、列表刷新、重复上传去重、明确删除确认和真实删除。
- 创建空资料库并显示诚实空状态。
- 导入 HTML/脚本字符串只作为文本显示，未创建 XSS 全局标记。
- PDF 第 2 页来源在浏览器可见。
- 390×844 手机原文加载后滚动到可见位置，无横向溢出。
- 整段流程 `consoleErrors` 与 `pageErrors` 均为空数组。

真实截图：

- `docs/screenshots/search-desktop.png`
- `docs/screenshots/search-mobile.png`
- `docs/screenshots/source-mobile.png`

手机原文截图会等待平滑滚动基本结束后再拍摄，避免只截到滚动起点。浏览器下载保存在被 Git 忽略的 `.data/browser-downloads/`。

## 5. 构建与未覆盖范围

`npm run build` 已成功生成生产前端。最新构建输出包括 `dist/index.html`、CSS 和 JS 资源。

本次没有开展真实用户效果评估，没有测试公网多用户安全，没有实现 OCR，也没有发布 Sites。语义相关性、导入成功和自动化检查通过不等于文献内容真实或论文结论正确。

依赖安装过程曾报告无漏洞，但一次独立 `npm audit` 因审计端点错误未完成，因此本记录不宣称已完成一次成功的独立安全审计。
