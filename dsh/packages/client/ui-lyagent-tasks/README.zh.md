---
description: "用于显式任务执行和验收诊断的人工操作面板。"
kind: "package-reference"
---
# LyAgent task controls

[English](README.md) | 中文

## 概述

可选的原生右侧栏允许注册目标、列出当前会话任务、查看公开验收要求、显式执行或取消任务。注册与读取不发起模型请求。执行使用 host 任务服务的可信标准和配置预算；面板不提供凭据或自动批准。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

将此包与启用 `taskRuns: true` 的任务专用 `@deepseek-ai/dsh-lyagent-artifact-acceptance` 部署共同挂载。服务不存在时，面板显示不可用并保留草稿。变更从不自动重试。不确定失败后，刷新会读取权威状态。执行期间，取消有独立控制路径。关闭面板不会取消正在运行的 host 任务。

需关注和已取消的任务行显示 host 持久化的原因，最多 2,000 字符。面板将诊断原样作为任务数据保留，长内容会换行；仅查看失败不会启动执行。

<a id="model-experience"></a>
## 模型体验

通过显式任务执行操作间接影响模型；host 任务服务拥有全部记录到日志的模型输入。

#### KV Cache 影响

面板读取不增加请求 token；执行历史由 host 任务服务负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

- 附加要求在注册时接受一个相对产物路径与必需字面文本。只有文本而无路径时，在发送命令前拒绝且保留草稿。这些不可变检查加强部署检查，不能替换隐藏测试、改变评测命令或授予权限。可选的 `/task define` 最多接受二十条有界产物规则。可信评测代码仍由 host 拥有。列表只在请求和操作后刷新，没有实时任务流。此包没有自动重试、调度器或故障触发的替补工作者协调器。

<a id="dev-note"></a>
### 开发备注

无。
