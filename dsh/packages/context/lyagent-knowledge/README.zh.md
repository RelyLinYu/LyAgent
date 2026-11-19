---
description: "按精确 Agent 身份授权的版本化文本集合与有界词法检索。"
kind: "package-reference"
---
# LyAgent versioned knowledge

[English](README.md) | 中文

## 概述

此可选私有插件通过原生 storage-domain 保存具名文本集合。host 发布完整不可变版本，将精确集合版本授予选定原生会话身份，以空授权列表撤销访问，并可归档集合。归档阻止新授权与编辑，但保留此前固定的证据。替换授权可保留同一会话已有的归档固定版本并添加其他集合；不能新增归档授权或切换归档版本。新版本不会悄然更新会话已有授权。工具从执行上下文取得调用身份，不读取模型参数中的身份。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

配置正整数 `maxCollectionBytes`、`maxResultBytes`、`maxMatches`、`maxLineChars`。集合字节数包括全部保留的 JSON 历史。输出上限覆盖含元数据的完整 JSON。UTF-8 文本 SHA-256 标识导入文本，不标识原二进制。导入方必须在原生文件或附件权限下取得文本；服务不读取任意路径。不会自动授权会话，也不调用提供方。

域解码在暴露存储记录前验证文本摘要、来源身份唯一性、版本序号连续性和集合授权唯一性。损坏的持久化记录使域打开失败，不会消失或作为空证据处理。

`/knowledge catalog [after]` 提供仅 host 所属、按条数和字节限制的集合元数据页，包含标题、归档状态和版本号。把返回的 `next` 作为 `after` 可继续读取。不返回来源正文、不改变授权。模型工具不暴露全局目录。单项元数据超过页上限时显式失败，不会跳过集合。归档不存在的集合返回域拒绝。

host 服务 `ctx.lyagentKnowledge` 支持 `publish(id, title, sources)`、`grant(session, pins)`、`archive(id)`、`list(session)`、`search(session, collection, version, query)`、`read(session, collection, version, source, line)`。发布和授权写入串行；拒绝写入不替换旧记录。同一版本内来源 ID 唯一。每次读取包括直接服务调用均执行授权。域句柄在插件 dispose 时关闭；工具随所属 fiber 注销。

附加文本文件并提交 `/knowledge import <collection> <title>`，即可通过原生 Session 所属上传收据发布版本。导入支持 txt、md、csv、tsv、json、log，在集合总上限内流式读取已验证的不可变字节，拒绝无效 UTF-8 与含 NUL 的二进制，并仅在全部文件通过后发布。字节相同来源按附件摘要去重。来源标题保留清理后的上传名；来源身份使用附件摘要。不支持图像、PDF、Office 文件或任意 host 路径。导入不授予 Session 访问；之后须显式授权精确版本。

挂载原生命令注册表后，`/knowledge publish <JSON>` 接受显式用户文本 `{ collection, title, sources: [{ id, title, text }] }` 并创建不可变版本，不授予访问。`/knowledge grant <JSON>` 用 `[{ collection, version }]` 仅替换当前会话授权；`/knowledge revoke` 移除授权，`/knowledge list` 返回有界固定版本及显式截断，`/knowledge archive <collection>` 阻止未来授权而不删除旧证据。命令输入受 `maxCollectionBytes` 限制。命令不发起模型请求，持久化用户命令文本不自动注入为模型指令。发布和授权有意分离。这是可移植文本命令接口，不是文件选择器或可视集合编辑器。

<a id="model-experience"></a>
## 模型体验

### 知识工具

#### 模型看到的内容

`list_knowledge` 仅返回当前会话获授权的集合和版本，显式标记截断；无授权则为空列表。`search_knowledge` 返回集合和版本、明确词法匹配依据、无匹配和截断标记、匹配总数，以及有界来源、标题、摘要、行、文本、匹配词字段。冲突匹配行分别保留。`read_source` 返回一行及其来源身份、文本摘要、总行数和截断信息。未授权或版本错误以 `LYAGENT_KNOWLEDGE_REJECTED` 失败，不返回成功空搜索。工具描述将来源内容定义为不可信证据而非指令。原生工具结果在会话日志中保留模型可见证据。

#### Token 影响

启用时按条件加入 schema，每次调用产生有界 JSON 文本。不增加模型请求，也不自动注入上下文。

#### KV Cache 影响

工具结果只追加。集合改变不会修改已有历史；后续显式授权可选择另一个不可变版本。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

- 提供原生文本命令、UTF-8 附件导入和 host API，没有可视集合编辑器。产物验收任务 host 通过 `snapshot(session)` 捕获完整授权来源清单，在任务开始和结算时检查；这不确立引用的语义支持。
- NFKC 大小写归一化词法检索和汉字双字组不是向量嵌入、语义改写校验、OCR、矛盾检测或蕴含判断。不得将无匹配转换为编造答案。
- 归档保留旧证据及已有授权；需要禁止旧读者时，调用方必须显式撤销访问。这不是物理擦除。
- 记录在内存中按集合有界，没有全局集合配额或跨进程实时刷新。部署方可信并负责总存储策略。

<a id="dev-note"></a>
### 开发备注

无。
