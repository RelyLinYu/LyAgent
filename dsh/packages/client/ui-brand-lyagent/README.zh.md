---
description: "LyAgent 比赛部署的品牌标识与设置入口。"
kind: "package-reference"
---
# LyAgent Native Brand

[English](README.md) | 中文

## 概述

展示原生 Web 客户端中的 LyAgent 名称、标记和比赛设置入口。发行包保留上游 DeepSeek Harness 许可和声明。此插件不发起模型请求。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

LyAgent overlay 禁用官方图形插件，并通过原生客户端 loader 挂载此插件。它填充现有侧栏和欢迎区标记 slot，不改变会话、权限、模型或工具行为。侧栏名称提示通过原生英语与简体中文词典说明上游来源；其他语言使用原生回退链。

<a id="model-experience"></a>
## 模型体验

无，因为品牌与设置入口不注册模型输入。

#### KV Cache 影响

此插件不改变模型请求 token。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

- 此插件不提供完整品牌迁移：引导页、提供方名称和上游声明保留真实信息。尚未确认比赛资格。此包不包含编排功能。

<a id="dev-note"></a>
### 开发备注

无。
