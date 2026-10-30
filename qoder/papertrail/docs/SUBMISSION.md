# 知页 PaperTrail · 正式版本提交材料

更新日期：2026-10-30。本清单只记录真实状态，未完成项不填写虚构内容。

| 材料 | 状态与内容 |
| --- | --- |
| 项目网站网址 | 已发布并公开访问：https://zhiye-papertrail-dtwmawby435.qoder.website/ |
| 网站可见范围 | 「任何人都可访问」，已用无登录状态的全新浏览器上下文验证首页与静态资源 200、无控制台错误 |
| 网站内容 | 静态展示页：真实界面截图、验收结果与原始 JSON 下载、三份样例下载、一次完整检索的输入/步骤/结果、运行说明、功能边界与来源说明 |
| 代码仓库 | https://github.com/sevenmiles666/psfseekdb/tree/2026-competition-ecosystem （公开仓库），正式实现目录 `qoder/papertrail/`；2026-10-30 已推送，未改动本地 origin |
| 提交 commit | `0eb5835` · Add Qoder PaperTrail formal app with real seekdb hybrid retrieval |
| 运行说明 | `papertrail/README.md`：环境、依赖版本、seekdb 两种接入方式、安装到启动、首次使用与验收命令 |
| 验证样例 | 初始数据 `papertrail/samples/`；输入「如何避免模型编造事实？」混合模式；步骤与实测结果见展示站点「复现」一节与 `docs/VALIDATION.md` |
| 技术作用记录 | `evidence/verification.json`（34/34）、`evidence/persistence.json`（9/9）、`evidence/browser.json`（19/19），含 seekdb 版本、Collection、模型签名、RRF 参数与耗时 |
| Qoder 开发记录 | 文字记录 `qoder/docs/QODER_DEVELOPMENT.md`；真实会话窗口截图 `qoder/docs/qoder-record/qoder-session-2026-10-30.png`；Qoder 账号 UID `01a1879e-0898-72c9-9713-cc4dc5ebc14c`（同时填写在测试平台） |
| 使用效果材料 | 尚未开展真实用户评估，不提交虚构数字 |
| 凭据 | `.env` 未提交；`.env.example` 使用占位密码；站点与文档不含真实密钥 |

提交前还需完成：

1. 配置本人 Git 身份，审查并提交 `qoder/` 改动，推送到比赛分支，确认评审可访问且包含 `qoder/papertrail/`。
2. 保存本次 Qoder 对话的关键环节截图或录屏（需求拆解、代码生成、错误修复、真实检索验证、Sites 发布）。
3. 在大赛测试平台填写网站网址、仓库地址和本人 Qoder UID，上传运行说明、验证样例、证据与开发记录。
4. 提交前用无痕窗口再次打开网站确认可访问；评审结束前不要暂停或删除站点，改动后需重新发布。
