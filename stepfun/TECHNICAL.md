# 本页：浏览器本地推理与 seekdb 混合检索

**作品与模型。** TXT/Markdown 个人知识库；文档和查询都在浏览器 Worker 中使用 Transformers.js 3.8.1 / ONNX Runtime Web。模型为公开 Apache-2.0 的 [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9)，固定 revision `751bff37182d3f1213fa05d7196b954e230abad9`。采用该仓库预导出的 FP16 转换版和 INT8 权重量化版，mean pooling、L2 归一化、384 维、最多 128 tokens。模型主要适用英文；本队没有重新训练或宣称自行量化。运行时禁止远程模型请求，Node 不计算向量。

**体积与质量。** 同口径统计 ONNX + 同一组 Tokenizer/配置：FP32 **91,100,408 B**，FP16 **46,010,627 B（1.980×）**，INT8 **23,685,172 B（3.846×）**；ONNX 本身分别 90,387,606 / 45,297,825 / 22,972,370 B。SHA-256 见 `evidence/model-files.json`。固定 24 篇原创英文文档、6 条人工相关性标注查询，FP32、FP16、INT8 的 **Recall@5 均为 1.000，nDCG@5 均为 0.9866**；该小数据集未见下降，不泛化为所有语料无损。

**后端与降级。** 显式选择 WebGPU，支持 shader-f16 时使用 FP16，否则尝试 INT8；无适配器或初始化失败自动切换 WASM/INT8。界面显示实际后端。已在 Apple Metal-3 GPU 与真正没有可用 WebGPU 适配器的 headless 环境分别完成文档导入和查询；后者没有依靠强制开关冒充硬件缺失。Worker 保持模型、复用缓存，默认 batch=8；同一配置的重复请求不重新初始化。

**数据与排序。** seekdb-js 1.4.0 server 模式，`Schema` 为 384 维 cosine HNSW + space 全文索引，`embeddingFunction:null`。向量、原文、来源和 ID 存入 seekdb；`Collection.hybridSearch()` 在数据库内完成全文/向量候选与 RRF（window=20、constant=60、top=5），前端不自行融合。全文问题去除常见英文疑问词，语义向量保留完整查询。一次导入完成后只刷新一次索引，刷新成功才开放检索。SHA ID + upsert 支持去重追加，标题登记在 seekdb，浏览器仅记所选集合；交互锁及数据库串行队列保证切库与 SDK 会话状态一致。

**实测与优化。** Apple M5 / 24 GiB、Chrome 151、Metal-3；seekdb 1.4.0 在 UTM Ubuntu 24.04.5 x86_64 仿真机（2 核/6 GiB），SSH 本机转发；后台 ARM VM 有两个编译任务。数据库延迟不能代表原生 Linux。四配置各跑四轮，第一轮与加载单列，以下为后三轮中位数；查询端到端含 Worker、传输、数据库和 JSON，至结果可展示，排除 DOM 绘制。

| 配置 | 24篇向量化 ms | 篇/s | 查询向量 ms | 检索 ms | 端到端 ms |
|---|---:|---:|---:|---:|---:|
| FP32 GPU batch1 | 175.58 | 136.69 | 9.45 | 32.64 | 62.94 |
| FP16 GPU batch1 | 166.96 | 143.75 | 9.99 | 27.35 | 57.83 |
| FP16 GPU batch8 | 75.70 | 317.02 | 11.28 | 27.32 | 60.37 |
| INT8 WASM batch8 | 443.92 | 54.06 | 14.70 | 27.11 | 60.62 |

单独 FP16 转换下降 4.9%，同精度批处理下降 54.7%；组合吞吐 2.32×。首加载分别 490 / 343 / 336 / 287 ms，其中本地模型资源读取 64 / 42 / 48 / 32 ms；不当作公网下载速度。另以相同浏览器向量、24篇、新空集合三轮对比：逐篇 24 次刷新端到端中位数 **15,573 ms**，一次统一刷新 **1,034 ms**，下降 **93.4%**，不包含推理。

**复现与证据。** 按 README 启动官方 seekdb，再 `pnpm install --frozen-lockfile --ignore-scripts`、`python3 download_models.py`、`pnpm run build`、`pnpm start`。原始数据及分段时间在 `evidence/benchmark/raw.json`、`evidence/refresh/raw.json`；`evidence/state/acceptance.json` 验证连续/重复导入、刷新可见、两库隔离、重载恢复、手机布局和真实无 GPU 降级。请求记录没有外部推理或运行时 URL。完整源码、固定依赖、模型校验、启动脚本和评测语料均随作品提供。
