---
description: "将变更操作保留给父 Agent 的原生工具执行策略。"
kind: "package-reference"
---
# LyAgent parent-only effects

[English](README.md) | 中文

## 概述

可选原生工具 guard 使用 `childReadOnlyTools` 显式配置经过部署方审计的只读工具名。来自委派 Session（`origin: subagent` 或持久化委派深度大于零）的调用若不在列表内，会在工具体前以 `LYAGENT_PARENT_WRITE_REQUIRED` 拒绝。没有所属 Agent 的调用以 `LYAGENT_AGENT_REQUIRED` 拒绝。普通根 Session 仍受原生批准与沙箱策略约束。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

guard 在 pre-execute 监听和批准后运行。监听返回 allow 不能抹除其拒绝。注册归生命周期所有，并在插件 dispose（资源释放）时移除。部署方必须审计每个允许名称背后的实际实现：名称本身不能证明自定义工具只读。Shell、PTC、MCP、文件写入、插件或配置变更及未知工具不应对子任务开放。

编排 overlay 还允许原生 `structured_output`。此作用域工具依据请求 schema 校验子结果并记录接受值，不提交工作区文件。父任务必须单独审查建议，并通过原生工具与权限实施变更。

<a id="model-experience"></a>
## 模型体验

### 被拒绝的子任务操作

#### 模型看到的内容

`Delegated agents may only use the configured read-only tools. Return the proposed change to the parent agent.`

#### Token 影响

按条件产生失败工具结果文本；此策略不启动额外模型请求。

#### KV Cache 影响

工具结果历史只追加。现有请求前缀不变。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

- 此机制是 Harness 工具执行策略，不是对可信插件代码的 OS 约束，也不能防御恶意 host 管理员。
- 工具 schema 可见性不变；子任务可以请求禁止工具，但执行会被拒绝。专用子 preset 可进一步减少可见工具。
- 父任务补丁校验、验收检查与每个父任务请求配额由独立编排能力负责。

<a id="dev-note"></a>
### 开发备注

无。
