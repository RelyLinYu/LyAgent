---
kind: upgrade-guide
description: "LyAgent 计划发布区分已提交的受保护回执，并拒绝 repeat 节点重试。"
---

# LyAgent 工作流发布与重试

[English](guide.md) | 中文

## 变更

`publish-plan` 现在在发布队列内部检查知识访问权限。存储开始前撤权会拒绝且不追加版本。写入期间撤权会返回成功且不含正文的回执，其中包括 `publication.state: "committed"`、`publication.body: "withheld"`、`publication.reason: "knowledge-access-changed"`，以及 `id`、`version` 和 `sha256`。调用方不能将此响应理解为未提交的失败，也不能期待它包含编译正文。

编译版本保留可选 `sourcePlan`。已有记录仍是有效存储输入；此字段不改变 Session 格式。早于 `knowledgeMode` 的版本仍会被受管理的读取、运行和嵌入操作拒绝。将旧脚本重新发布为人工输入不会更新它的重试行为。

`repeat` 节点拒绝大于一的 `retry`。外层可重试的 `saved` 节点在普通错误后仍可能重放整个单元，包括错误前已完成的迭代。空结果、取消和检查失败会停止新编译计划且不触发外层重试。

## 迁移

1. 更新命令调用方，处理不含正文的已提交回执。恢复知识访问权限后读取返回的确切版本；不要盲目重试旧 `expectedVersion`。
2. 将 repeat 节点改为 `retry: 1`。外层 saved 单元已完成的效果不能重复时，也使用 `retry: 1`。
3. 重新编译经过审阅的计划，不要给旧脚本重新标记。遵循[离线候选操作说明](../../../../../scripts/WORKFLOW-CANDIDATE.md)，审阅替代语义，并授权实际运行时 Agent id。
4. 核验候选哈希后通过隔离 Loader 排练。生成候选与无密钥测试通过不代表正式实例已部署，也不验证真实业务输出。
