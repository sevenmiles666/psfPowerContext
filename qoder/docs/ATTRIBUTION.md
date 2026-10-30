# 来源与改动

- 比赛基础：[oceanbase/powercontext 的 2026-competition-ecosystem 分支](https://github.com/oceanbase/powercontext/tree/2026-competition-ecosystem)。本项目只在 `qoder/` 新增文件，不修改 `dify/`、`gaode/`、`stepfun/` 等参赛目录。
- 现有 `stepfun/server.mjs` 提供 seekdb-js 服务端接入、显式向量与混合检索的参考模式。本项目没有拷贝其浏览器模型或英文样例；重新实现服务端多语言嵌入、PDF 解析与定位、全文/语义/混合切换、资料过滤、引用、收藏持久化、输入限制和本机接口校验。
- [seekdb](https://github.com/oceanbase/seekdb)、[seekdb-js](https://github.com/oceanbase/seekdb-js)：Apache-2.0。真实存储、全文与向量索引、RRF 混合检索。Docker 配置参照[官方镜像说明](https://github.com/oceanbase/docker-images/tree/main/seekdb)。
- [Xenova/paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2)：原始 Sentence Transformers 多语言 MiniLM 的 ONNX 版本，Apache-2.0；不训练或改动权重，固定 revision、本地 q8 推理。
- [Transformers.js](https://github.com/huggingface/transformers.js)：Apache-2.0；[PDF.js](https://github.com/mozilla/pdf.js)：Apache-2.0。
- React / Vite / Express / Multer / Lucide / Playwright：通过 npm 使用，遵循各自包中的 MIT / ISC / Apache-2.0 等许可证；版本与传递依赖见锁文件。项目图标由 Lucide 提供，书形 favicon 为项目内代码绘制。
- `samples/`：本项目自编教学资料；PDF 与浏览器测试文件由测试脚本生成，不引用外部论文，不伪造论文身份或实验结论。
- `docs/design/concept.png`：本次会话使用内置 Image Gen 生成的 UI 参考图；产品界面为 React/CSS，不使用该图替代网页功能。实际界面截图另放在 `docs/screenshots/`。
- 本目录的开发来源为本次 Codex 会话。后续在 Qoder 中完成的工作应追加独立、真实记录，不改写本次工具来源。
