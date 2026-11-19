---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-16-workflow-child-diagnostics

English | [中文](2026-11-16-workflow-child-diagnostics.zh.md)

## Summary

Adds optional error and stopReason diagnostics to persisted tool-workflow/agent-end events without changing the Session version.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

New readers accept historical events without either diagnostic and retain their recorded outcome. Older readers retain opaque plugin event data; their workflow projection reads outcome and safely ignores these optional diagnostics. Neither field grants authority or changes replay execution. The V4 codec delegates ordinary event bodies to the V3 envelope validator, which does not reject these additional properties.

<a id="verification"></a>
## Verification

corepack pnpm exec vitest run packages/client/ui-theme/tests/menu-surfaces.client.spec.ts packages/client/ui-theme/tests/app-region-styles.client.spec.ts packages/client/modules/tests/node-half.client.spec.ts packages/client/ui-schedule/tests/task-manager-page.client.spec.tsx packages/workflow/tool-workflow/tests/tool-workflow.spec.ts packages/client/ui-workflow-run/tests/workflow-run.client.spec.tsx: 6 files and 281 tests passed. The workflow owner tests cover failure diagnostics and historical events without diagnostics; the client projection tests cover both representations. Reader inspection: packages/session/session-format-v3-to-v4/src/codec.ts and packages/session/session-format-v2-to-v3/src/payload.ts.

<a id="dev-note"></a>
## Dev Note

None.
