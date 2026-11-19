---
description: "将根轮次取消传播到驻留委派子任务。"
kind: "package-reference"
---
# LyAgent delegated cancellation

[English](README.md) | 中文

## 概述

可选根轮次取消策略使用原生 agent（智能体）pre-step、subagent 生命周期与工具 guard 注册。取消已观察的根轮次，会同步中断被跟踪的驻留子任务及其后代。原生适配器和工具负责处理 abort 与结算。此策略不将子任务标记为已完成，也不撤销已派发的副作用。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

已中止的根轮次还会用 `LYAGENT_PARENT_STOPPED` 拒绝新的委派步骤和工具派发。新根轮次替换取消信号，因此同一会话可以再次委派，不会永久关闭整棵树。原生 inbox 停放和中断语义保持不变。卸载插件会移除监听和 guard；原生激活仍由 subagent 服务拥有。

<a id="model-experience"></a>
## 模型体验

### 父任务已停止

#### 模型看到的内容

`The parent task was stopped. Do not continue delegated work until the parent starts a new task.`

#### Token 影响

此策略不启动额外模型请求。被拒绝的委派 pre-step 不派发到模型。

#### KV Cache 影响

按条件追加失败工具结果；已准入请求的前缀不变。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

- 根任务必须进入原生 pre-step 才能观察其轮次信号。未经已观察根轮次的 host 直接委派没有可继承的父轮次信号。
- 中断请求同步发出，但子任务静止取决于支持取消的原生适配器和工具。声称全部工作停止前，调用方必须等待子任务 idle 或激活 dispose。
- 此机制只取消进程内任务，不提供崩溃恢复或跨 host 终止。中断用量后的预算预留仍保持未知。

<a id="dev-note"></a>
### 开发备注

无。
