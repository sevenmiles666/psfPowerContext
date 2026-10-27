# 昨日便利店

货架每天复原，店主却记得你。玩家借伞、还伞、偷铃、道歉或撕掉收据回到昨天；守约和欠账会影响新的相遇。只有留下一个值得信任的昨天，才能打开通向明日的门。

作品包含可直接体验的中文网页、Dify Workflow DSL、PowerContext 记忆网关及真实运行证据。无需付费模型账号。规则决定行动结果，本地模型根据往事即兴生成店主台词；模型台词不改变库存、欠账或通关状态。

## 分工和版本

| 组件 | 固定版本与实际职责 |
|---|---|
| Dify | **1.9.2**，DSL **0.4.0**；编排输入 → 读取记忆 → Code 节点执行玩法 → 保存记忆 → 请求模型旁白 → 返回结果 |
| PowerContext | 团队仓库 main 的 **d0fd77f63a096c70602dea4c210d99b9dc67b146**；实际持久化每回合状态、选择与精确引用，跨 Workflow run 和网关重启复用 |
| 网关 | Python **3.12**，作品版本 **1.0.0**；依赖固定于 requirements.txt；SQLite 数据文件由 PowerContext 管理 |
| 本地模型 | **mlx-community/Qwen3-1.7B-4bit**，revision **3b1b1768f8f8cf8351c712464f906e86c2b8269e**；968,080,210 字节权重，SHA-256 **0e86d9677e519323849eac1bc272caae88567a481ff188c431f70be543d9995f** |
| 模型运行器 | MLX-LM **0.32.2**、MLX **0.32.4**、Transformers **5.21.0**；Apple Silicon 本地推理，不需要云 API Key |
| 其他服务 | PostgreSQL 15、Redis 6、Dify Sandbox 0.2.12；compose.yml 以镜像 digest 固定实际内容 |

本作品没有 Dify 插件依赖，不使用 Embedding 或 Rerank。没有把 seekdb 算入作品技术结合；使用的是 PowerContext 的实际记忆读写。代码、故事、规则与页面为本作品原创；Dify 部署字段参考官方 [1.9.2 docker-compose](https://github.com/langgenius/dify/blob/1.9.2/docker/docker-compose.yaml)。模型来源为 [MLX 社区模型](https://huggingface.co/mlx-community/Qwen3-1.7B-4bit)，基座为 Qwen3-1.7B，依其上游许可使用。

## 从空状态启动

参考完整环境为 Apple Silicon Mac（本机 24 GiB）运行网关和模型，Docker 运行 Dify。建议合计至少 12 GiB 内存、10 GiB 空闲磁盘、Python 3.12、Git、Docker Engine 和 Compose v2.39.4。Dify 服务也可放在 Linux 上；本次实际验收为 Ubuntu 24.04 x86_64 UTM（2 vCPU / 6 GiB）运行 Dify，Mac 运行网关与模型。

以下命令在本目录运行。使用报名仓库读取权限安装固定的 PowerContext 提交。不要把 GitHub 凭据写进命令、配置示例或 Git 仓库。

```bash
uv venv --python 3.12
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python init_local.py
docker compose -f compose.yml up -d
```

init_local.py 生成权限为 0600、已被 .gitignore 排除的 `.env`。其中密码和网关密钥只在本机使用。首次启动会执行 Dify 数据迁移；等待 `curl http://127.0.0.1:5001/health` 返回 `status: ok`，x86_64 仿真下可能需要数分钟。

在 Apple Silicon 上安装本地模型运行器并下载固定模型：

```bash
uv venv runtime/model-venv --python 3.12
uv pip install --python runtime/model-venv/bin/python -r requirements-model.txt
HF_HUB_DISABLE_XET=1 runtime/model-venv/bin/python download_model.py
runtime/model-venv/bin/mlx_lm.server \
  --model runtime/Qwen3-1.7B-4bit --host 127.0.0.1 --port 8080 \
  --max-tokens 160 --temp 0.7 --chat-template-args '{"enable_thinking":false}'
```

保持模型服务运行。另开终端：

```bash
.venv/bin/python serve.py
```

serve.py 在 `127.0.0.1:8010` 启动网关与网页。单进程保护首次写入，后续写入同时校验 PowerContext revision；请保持 `workers=1`。

再开终端导入 DSL、执行五轮真实验收、发布到本地 Dify 并配置网页入口：

```bash
.venv/bin/python bootstrap_dify.py \
  --url http://127.0.0.1:5001 --gateway http://host.docker.internal:8010
```

Linux Docker 与网关放在同一主机时，可先查看 `ip -4 addr show docker0`，例如桥接地址为 172.17.0.1，则使用 `STORE_BIND_HOST=172.17.0.1 .venv/bin/python serve.py`，让容器通过 host.docker.internal 访问网关；模型仍使用本地回环地址。本次 UTM 验证实际使用 `--url http://127.0.0.1:15001 --gateway http://10.0.2.2:8010`：15001 为 SSH 转发到虚拟机 5001，10.0.2.2 为 QEMU 到 Mac 的地址。两个参数必须填实际可达地址。

脚本仅初始化**自己的本地 Dify**，不调用外部工作区。登录凭据从 `.env` 读取，应用 API Key 保存到 `runtime/app-config.json`（0600），不会输出或交给浏览器。更新 DSL 可加 `--reuse`，复用本地应用。导入也可在 Dify 界面手动完成：上传 yesterday-store.yml，填写环境变量 STORE_URL 和 STORE_TOKEN，发布并把本地应用 Key 配入 app-config.json。

现在打开 **http://127.0.0.1:8010/**。同一个玩家编号跨刷新和新会话保留记忆；换编号开始全新故事。网页每次行动均调用已经发布的 Dify Workflow API，网关不会直接执行 engine.py。

## 验收玩法

| 场景 | 操作与预期 |
|---|---|
| 守约通关 | 新编号，依次观察 → 借伞 → 还伞 → 回到昨天 → 敲铃；第 2 个昨天保留 trust=1，最后 escaped=true |
| 欠账不会随循环消失 | 新编号，偷铃 → 回到昨天 → 借伞；铃铛已复原，但 debt=true，借伞被拒绝；道歉后可以重新借伞 |
| 跨会话记忆 | 还伞后关闭网页；新会话仍使用原玩家编号，再回到昨天、敲铃，可通关 |
| 玩家隔离 | 上一个玩家通关后换新编号，直接敲铃不能通关 |
| 幂等与冲突 | 相同 request_id、相同提交返回原引用；相同编号不同内容或过期 revision 返回 409 |
| 模型临时不可用 | 已保存的规则状态保留，旁白采用明确的备用台词；验收日志的 model_used=false，不伪装实际推理 |

本地回归：`uv pip install --python .venv/bin/python pytest==8.4.2` 后运行 `.venv/bin/python -m pytest -q test_game.py`。真实 Dify 运行日志见 [evidence](evidence/)，含节点执行、模型使用标记、状态与精确 MemoryCitation；日志中的网关密钥已去除。这些日志来自真实导入的 Dify、真实 PowerContext 和本地模型，非模拟响应。

恢复空状态：使用新的玩家编号即可重复验证，不需要清空其他玩家。完全重建时，先停止 serve.py；保留备份后更换 STORE_DATA 指向空目录并重启。`.env` 和 runtime 中的本地数据库、凭据不得提交。

## 已知限制

每个玩家最多 100 回合。轻量模型偶尔复述或误解剧情，因此游戏结果以正文事件及菜单为准，旁白不会修改规则状态。演示入口绑定本机回环，未提供公网账户系统；使用玩家编号接续故事适合本地体验。共享部署需要额外的玩家认证和访问控制，不应把编号当作授权凭据。MLX 参考推理环境为 Apple Silicon；其他平台可配置支持 OpenAI Chat Completions 的服务，通过 MODEL_BASE_URL、MODEL_NAME 和可选 MODEL_API_KEY 接入，但其他模型的文本质量不属于本次测量结果。
