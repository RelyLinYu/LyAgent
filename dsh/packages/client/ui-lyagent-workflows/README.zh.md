---
description: "用于保存的角色、团队与工作流版本的人工操作面板。"
kind: "package-reference"
---
# LyAgent workflow manager

[English](README.md) | 中文

## 概述

可选的原生右侧栏通过现有命令传输管理人工保存的角色、团队和精确版本工作流。浏览或保存不发起模型请求。执行是当前会话的显式操作，仍受原生权限及已挂载预算策略约束。失败操作保留草稿；不确定的变更从不自动重试。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

通过 LyAgent 编排 overlay 共同挂载对应 host 工作流库与此客户端插件。浏览精确版本，并在显式保存或执行前检查保留的草稿。

<a id="model-experience"></a>
## 模型体验

无，因为此浏览器面板不注册模型工具或提示。

#### KV Cache 影响

没有直接影响；保存工作流库与原生执行路径负责执行时的模型请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

- 面板提供有界表单编辑，不是可视图画布或崩溃恢复界面。在可选预算策略下，模型轮次外的人工执行无法取得父轮次模型配额。保存路由不会配置模型凭据或授予工作区访问。

<a id="dev-note"></a>
### 开发备注

无。
