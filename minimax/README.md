# 规有所依 · SDD 上下文模块

当前为已验证的 MiniMax 参与版本，**尚未平台提测**。seekdb 导入/查询、
规格更新、PowerContext 跨进程状态复用均已实测。2026-10-29 使用已生效的
MiniMax M Plan Explore 权益，通过 MiniMax-M3.1-Flash 实际修改样例代码；
同一套测试由修改前 3 项目标失败、4 项兼容通过，变为修改后 7/7 通过。
完整请求、模型响应、源码差异和前后测试结果保存在 evidence/development-2026-10-29。
API Key 仅保存在本机受限权限文件，不写入仓库或开发记录。

## 运行

需要 Python 3.12、可用的 seekdb server（已验证 1.4.0.0）和 Git。
PowerContext 固定使用本队通过全部比赛测试的提交。

```sh
python3.12 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export SEEKDB_HOST=127.0.0.1 SEEKDB_PORT=2881 SEEKDB_USER=root
# 有密码时在本地环境中设置 SEEKDB_PASSWORD，不要提交到仓库。
python context_module.py import
python context_module.py context
python context_module.py test
```

初始测试应出现 3 个目标功能断言失败、4 个兼容性测试通过。失败来自
基线函数尚未支持大小写/空白归一化，已有日志位于 `evidence/before-tests.json`。
所有文件均随仓库交付，不依赖开发机器的源文件。

## 入口与数据流

`example/manifest.json` 定义工程、任务、检索词、目标文件和规格/代码/测试来源。
`import` 以事务导入这些文件到 seekdb 的 `sdd_context.context_documents`，
重新导入会替换该工程的完整来源快照，删除已撤回的来源。

`context` 通过带参数的 SQL 从 seekdb 查询资料，输出内容、文件路径、起始行、
行数和 SHA-256，并读取 PowerContext 中的最近任务状态。样例查询 `select_tasks`
应命中 `spec.md`、`taskboard.py`、`test_target.py`、`test_taskboard.py` 四项来源。
检索缺少必要来源时会明确失败。

`record --event event.json` 将任务记录写入 PowerContext；结束该进程后再次执行
`context`，输出中的 `state.previous` 应包含该记录。事件样例：

```json
{"completed":["indexed sources"],"pending":["MiniMax modification"],"verification":{}}
```

`--root` 可指定另一个含 manifest 的样例工程；`--data` 指定 PowerContext 本地
状态目录。数据库保存工程资料；PowerContext 的 SQLite 持久层只保存任务状态。

## MiniMax 开发与最终验收

网络需要代理时，可设置 MINIMAX_HTTP_PROXY；仅模型 HTTP 请求使用该代理。

领取赛事 MiniMax Token Plan 后，在本地设置 `MINIMAX_API_KEY` 和可用的
`MINIMAX_MODEL`。大陆接口默认 `https://api.minimaxi.com/v1`；其他官方接口可用
`MINIMAX_BASE_URL` 配置。程序通过 MiniMax Chat Completions HTTP API 请求修改。

```sh
python context_module.py import
python context_module.py develop
python context_module.py context
python context_module.py test
```

`develop` 将真实数据库上下文和已恢复状态提供给 MiniMax，只接受目标文件的
完整源码，保留调用内容、模型返回、修改前后快照、diff、同一套测试的前后日志
及测试文件哈希。模型输出不作为 shell 命令执行。之后需确认 7 个测试全部通过，
重新启动后能读取并使用验证结果，再整理材料提测。

重新演示前：`cp baseline/taskboard.py example/taskboard.py`，使用新的 `--data`
目录，从空状态开始验证。不要修改目标测试或兼容性测试。

## 已验证与缺口

`evidence/preparation.json` 保存真实 seekdb 查询、四项资料、规格重新导入前后
哈希和内容，以及不同 Python 进程之间的 PowerContext 写入/复用记录。
规格更新验收在独立临时样例中完成，不修改交付规格与测试。

MiniMax 实际修改已完成：example/taskboard.py 增加状态归一化，保留原顺序和
输入对象；目标与兼容测试的哈希在修改前后相同。修改后重新导入 seekdb，
确认数据库中的目标源码哈希与文件一致；另起进程读取 PowerContext 中的
完成状态，证据为 evidence/context-after-2026-10-29.json。正式分数仍须以
平台提测及回执为准，不以本地 7/7 通过代替评分。

代码为本队原创；PowerContext 采用官方开源项目的本队比赛实现，seekdb 是官方
1.4.0.0 server。具体结构见 `TECHNICAL.md`。
