---
kind: package-reference
description: "保存不可变的 LyAgent 工作流计划，固定团队角色和知识，并通过原生工作流运行确切版本。"
---

# LyAgent 已存工作流库

[English](README.md) | 中文

## 概述

保存确切的工作流版本，组合有界依赖计划，并在调用会话的原生权限下运行。计划固定团队角色、模型和知识版本；发布不会发起模型请求。运行证据记录选定版本与结果。

## 目录

- [已存版本](#saved-editions)
- [依赖计划](#dependency-plans)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## Saved editions

按需启用的 host 插件保存具名且不可变的 JavaScript 工作流版本。`/saved-workflow publish <JSON>` 接受 `id`、`expectedVersion`、`description` 和 `script`。版本零创建身份；后续发布必须指定当前版本。冲突会拒绝且不替换。历史会保留，脚本携带 SHA-256 摘要，配置的 `maxDefinitionBytes` 限制每条完整历史，`maxEntries` 限制目录身份数。发布不执行代码，也不授予权限。

`/saved-workflow list` 返回元数据；`read <id> <version>` 返回确切的保留版本。`run <id> <version>` 在调用方空闲会话中调用现有前台原生 `workflow` 工具。其现有脚本解析器、子进程限制、子代理策略、审批和模型准入仍然有效。人工命令的持久化输入与结果保留选定版本、摘要和原生结果；原生工作流记录保留子代理进展。执行错误是命令错误，不是成功的部分结果。取消和销毁仍由原生工具负责；库卸载时等待已准入命令后才关闭存储。

每次成功运行也会从 `saved_workflow` 工具和 `run` 命令写入一条证据记录：`<workspace>/workflows/<id>-v<version>-<runInstant>-<nonce>.json`。运行时间和随机量使记录唯一，写入拒绝已有路径，因此重跑不会覆盖旧证据。记录无法写入时会报告：命令结果携带 `record: { error }`，工具记录警告；记录失败不改变运行自身的结果。

## Dependency plans

`publish-plan` 将解析后的 `sourcePlan` 与编译版本一起保存。没有计划的旧版本仍可由存储层读取，但缺少 `knowledgeMode` 的版本不能通过受管理命令读取、运行或嵌入。人工脚本发布是受信输入；`human` 标记不会升级旧编译器行为。

发布在编译前检查知识访问权限，并在串行写队列中、存储开始前再次检查。排队时失权会拒绝且不追加版本。存储写入期间权限发生变化时，发布仅返回 `{ id, version, sha256, publication: { state: "committed", body: "withheld", reason: "knowledge-access-changed" } }`，不返回正文，也不声称回滚。恢复访问权限后重新读取当前版本，不要重复旧 `expectedVersion`。

人工 `/saved-workflow publish-team <JSON>` 保存 `id`、`expectedVersion` 和 `definition`。角色配置具有 `kind: "profile"`、`description`、`instructions`、`provider`、`model` 和 `enabled`。团队具有 `kind: "team"`、`description` 和 `members: [{ role, profile: { id, version } }]`。团队角色名必须唯一，每个配置版本必须已存在。`/saved-workflow teams` 列出元数据；`read-team <id> <version>` 读取保留版本。这些定义使用独立存储域，保留不可变版本，拒绝过期保存或身份类型变更。

`kind: "role"` 的计划节点提供 `team: { id, version }`、`role`、`prompt` 及常规节点身份和依赖。发布解析团队固定的配置，拒绝缺失或禁用的角色，并嵌入其指令、provider、model 和确切引用身份。后续团队或配置发布不改变已存计划。这些定义选择子代理路由，不替代原生团队任务板，不授予工具，也不提供角色容量准入。

人工 `/saved-workflow publish-plan <JSON>` 接受 `id`、`expectedVersion`、`description` 和最多 32 个 `nodes`。每个节点具有唯一 `id`、显式 `dependsOn` 和 `kind`：`agent` 需要 `prompt`、`provider`、`model`；`saved` 需要确切 `workflow: { id, version }`；`repeat` 还需要一至八的 `count`；`branch` 需要依赖 `source`、属性 `path`、标量 `equals` 及确切 `then`/`otherwise` 引用；`check` 需要 `expect: { mustContain, minLength }` 并断言依赖结果。依赖按并行层执行；失败层阻止后继。分支来源必须是直接依赖。重复节点、缺失边和环在发布前拒绝。已存版本及摘要在发布时嵌入，包括嵌套编译计划；执行不解析更新版本。重复节点传入 `{ dependencies, iteration }` 作为 `args`；其他已存节点接收依赖结果映射。Agent 提示包含序列化依赖结果。所有子代理共享原生运行上限；重复已存脚本仍可能超限。

`check` 节点可以指定一个可选 `rework` 目标，以及一至三的 `attempts`。目标必须是该 `check` 的直接依赖，且是 `role` 或 `agent`；没有 `rework` 却提供 `attempts` 会拒绝。仅断言失败会重跑目标：生成器的下一条提示携带检查的具体失败原因，其结果替换记录值并重新断言。达到次数上限后该层失败且后继不启动。目标抛异常、被取消或没有成功值时立即失败，不进行返工。

`retry` 表示节点总尝试次数，范围一至三。空子结果、取消和检查失败会停止所在编译计划且不触发外层重试；普通错误可以重试整个节点。`repeat` 节点需要 `retry: 1`，更大值在发布时拒绝。外层 `saved` 节点有重试时，普通错误仍可导致整个已存单元重放，包括已经完成的重复迭代。有不可重复副作用的单元外层应使用 `retry: 1`；本库没有持久化的逐迭代恢复。

离线[候选操作说明](../../../../scripts/WORKFLOW-CANDIDATE.md)按前驱版本和摘要重新编译显式且经审阅的替代计划。它不恢复丢失的原计划，也不写源 home。候选数据包含脚本、计划、集合和 Agent 授权；仅有哈希的摘要不能导入。



## Model Experience

### Saved workflow call and result

#### What the model sees

`saved_workflow` 工具接受确切 `id` 和正整数 `version`。其描述是 `Execute an exact human-saved workflow version under the current task permissions and budget. Never infer a version or substitute the latest. Publication is human-only.` 成功返回选定的 `id`、`version`、`sha256` 和原生结果文本。原生失败返回 `Saved workflow execution failed (<code>). Check workflow permissions and run status before restarting.` 不含原生 `workflow` 工具的组合（包括提供的 `ptc` 预设）返回 `Saved workflows need the native workflow tool, which is not available to this conversation. Use a preset that exposes workflow, or have the model author the orchestration directly.` 调用方的步骤准入、延迟上下文和成功轮次结束处理一并转交原生执行。发布仅限人工；父轮次预算准入适用于子代理。

#### Token effect

工具 schema 加入启用的会话；成功和失败结果保留在工具历史中。脚本执行使用原生结果上限和子请求计量。发布与查找不发起模型请求。

#### KV Cache effect

发布与查找不发起模型请求。执行使用选定原生工作流脚本；子上下文与缓存属于原生执行路径。

## Known Limitations and Deferred Work

- 本库没有可视化图编辑器、角色容量准入或可恢复的工作流日志。嵌套版本在发布时嵌入，共享所属原生运行与子代理上限。
- 脚本是按现有原生策略执行的受信人工输入，不是操作系统安全保证。发布验证记录与摘要；原生引擎仅在执行时验证 JavaScript。
- 执行需要原生 `workflow` 工具。不含它的预设（包括 `ptc`）在子代理启动前拒绝已存工作流；PTC 程序不能嵌套已存工作流。
- 模型轮次外的命令执行无法获取父轮次模型分配。需要运行计量的部署必须从所属模型轮次调用 `saved_workflow`。

<a id="dev-note"></a>
### 开发备注

无。
