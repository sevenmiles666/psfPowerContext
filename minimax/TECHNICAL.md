# 一页技术说明

目标任务是为已有任务看板的 `select_tasks` 增加 Unicode 大小写和首尾空白
归一化，同时保持无筛选、未知状态、输入顺序及不修改原始记录等既有行为。

四类模块按以下顺序工作：manifest 指定来源 → seekdb 持久化并检索资料 →
PowerContext 读取任务状态 → MiniMax 接收上下文并修改代码 → 同一套测试验证 →
PowerContext 保存验证结果供后续进程使用。

seekdb 以 `(project_id,path)` 保存规格、实现和测试全文及 SHA-256。
检索使用带参数的 `LOCATE` 文本条件和工程隔离；返回值直接构造模型上下文。
本样例采用结构化条件与词项检索，没有声称使用向量检索。
重新导入在单一事务中替换工程来源，确保规格更新不继续使用旧记录。

PowerContext 使用官方 builtin runtime、scope 和 memory API。工程与任务共同
确定幂等 scope，记忆保存 completed、pending、verification。每个 CLI 进程
重新打开持久层并恢复最近记录；开发请求包含恢复结果，后续进程能据此继续工作。

MiniMax 的调用入口是 `develop`，只允许改 manifest 指定的实现文件。
真实请求和最终模型输出随证据保存，不要求或保存模型私有思维链。测试源文件
前后哈希必须一致；基线测试必须先出现真实功能失败，修改后再验证功能及回归。

准备阶段已在 Linux x86_64 seekdb 1.4.0.0 上完成真实资料存储和查询，在 macOS
Python 3.12 上完成 PowerContext 跨进程恢复与规格更新验收。基线 3 个目标测试
失败、4 个回归测试通过。MiniMax 资源尚未到位，因此模型修改与绿色测试待完成。
