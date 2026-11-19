---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-16-workflow-child-diagnostics

[English](2026-11-16-workflow-child-diagnostics.md) | 中文

## 概述

为持久化的 tool-workflow/agent-end 事件添加可选 error 与 stopReason 诊断字段，保持 Session 版本不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-16-workflow-child-diagnostics
baseline: false
changes:
  - root: "event:tool-workflow/agent-end"
    previous: "2026-09-11-initial"
    after: "657b53ff2c972068a59d91e85ec05d6332571609971f59fa794f5329b7f1102d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取方接受缺少两个诊断字段的历史事件，并保留已记录的 outcome。旧读取方保留不透明的插件事件数据；其工作流投影读取 outcome，安全忽略可选诊断字段。两个字段均不授予权限，也不改变回放执行。V4 编解码器把普通事件体交给 V3 信封验证器，后者不拒绝这些新增属性。

<a id="verification"></a>
## 验证

corepack pnpm exec vitest run packages/client/ui-theme/tests/menu-surfaces.client.spec.ts packages/client/ui-theme/tests/app-region-styles.client.spec.ts packages/client/modules/tests/node-half.client.spec.ts packages/client/ui-schedule/tests/task-manager-page.client.spec.tsx packages/workflow/tool-workflow/tests/tool-workflow.spec.ts packages/client/ui-workflow-run/tests/workflow-run.client.spec.tsx：6 个文件、281 项测试通过。工作流所属测试覆盖失败诊断和缺少诊断的历史事件；客户端投影测试覆盖两种表示。读取方检查位置：packages/session/session-format-v3-to-v4/src/codec.ts 和 packages/session/session-format-v2-to-v3/src/payload.ts。

<a id="dev-note"></a>
## 开发备注

无。
