---
description: "用于版本化知识导入与会话授权的人工操作面板。"
kind: "package-reference"
---
# LyAgent knowledge panel

[English](README.md) | 中文

## 概述

可选的原生右侧栏提供人工知识管理。Web profile 可挂载 `lyagent-knowledge.overlay.yml`。必须同时挂载对应的 host 知识插件；此面板不启动模型轮次。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

导入通过原生会话所属上传收据接受文本文件。发布集合不会授权访问。选择版本并在会话中使用，会替换该集合的固定版本，同时保留其他授权。授权列表不完整时拒绝替换。归档保留历史版本；撤销会移除当前会话的授权。

操作从不自动重试。失败的变更可能已提交；再次操作前应刷新并检查 host 权威状态。插件 dispose（资源释放）会停用未完成的镜像更新，并在等待读取结束后阻止后续依赖命令；它不会回滚已发送的命令。

<a id="model-experience"></a>
## 模型体验

通过显式会话授权间接影响模型；host 知识插件拥有模型可见的检索。

#### KV Cache 影响

面板命令不增加模型 token；知识工具结果由 host 插件负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

- 面板只导入 UTF-8 文本，不解析 PDF 或 Office 文件。目录在显式读取和操作后刷新。
- 失败的命令可能已经提交；再次显式变更前应刷新权威状态。

<a id="dev-note"></a>
### 开发备注

无。
