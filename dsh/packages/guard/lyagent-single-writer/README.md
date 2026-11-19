---
description: "Native tool execution policy reserving mutations for parent Agents."
kind: "package-reference"
---
# LyAgent parent-only effects

English | [中文](README.zh.md)

## Summary

Opt-in native tool guard. `childReadOnlyTools` is an explicit deployment-owned list of audited read-only tool names. Any call from a delegated Session (`origin: subagent` or positive durable delegation depth) outside that list is rejected before the tool body with `LYAGENT_PARENT_WRITE_REQUIRED`. Calls without an owning Agent reject with `LYAGENT_AGENT_REQUIRED`. Ordinary root Sessions remain subject to existing native approval and sandbox policies.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Use this package

The guard runs after pre-execute listeners and approvals. A listener returning allow cannot erase its denial. Registration is lifecycle-owned and removed on plugin disposal. The deployment must audit the exact implementation behind each permitted name: names alone cannot establish that a custom tool is read-only. Shell, PTC, MCP, filesystem writes, plugin/configuration mutation and unknown tools should not be allowed to children.

The orchestration overlay additionally permits native `structured_output`. This scoped tool validates the child result against its requested schema and records the accepted value; it does not commit workspace files. Parents must separately review proposals and apply mutations through native tools and permissions.


## Model Experience

### Denied child operation

#### What the model sees

`Delegated agents may only use the configured read-only tools. Return the proposed change to the parent agent.`

#### Token effect

Conditional failed tool-result text; no additional model request is started by the policy.

#### KV Cache effect

Append-only tool-result history. Existing request prefixes remain unchanged.


## Known Limitations and Deferred Work

- This is a Harness tool execution policy, not OS confinement of trusted plugin code or protection from a malicious host administrator.
- Tool schema visibility is unchanged; a child can request a forbidden tool, but its execution is denied. A dedicated child preset can additionally reduce visible tools.
- Parent patch validation, acceptance checks and per-parent request allocations remain separate orchestration work.


### Dev Note

None.
