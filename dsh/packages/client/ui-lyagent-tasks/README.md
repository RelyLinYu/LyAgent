---
description: "Human controls for explicit task execution and acceptance diagnostics."
kind: "package-reference"
---
# LyAgent task controls

English | [中文](README.zh.md)

## Summary

Optional native right-sidebar controls register an objective, list the current conversation's tasks, inspect public acceptance requirements, explicitly run a task, or cancel one. Registration and reads start no model requests. Runs use the host task service's trusted criteria and configured budget; the panel supplies neither credentials nor automatic approval.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Use this package

Mount this package beside a task-specific `@deepseek-ai/dsh-lyagent-artifact-acceptance` deployment with `taskRuns: true`. Without that service the panel reports unavailable and preserves drafts. Mutations are never automatically retried. Refresh reads authoritative state after ambiguous failures. Cancellation has a separate control path while execution is pending. Closing the panel does not cancel a running host task.

Attention-required and cancelled rows show the host's persisted reason, clipped to 2,000 characters. The panel preserves that diagnostic verbatim as task data, wraps long content and never starts execution merely to inspect a failure.


## Model Experience

Indirectly, through the explicit task run action; the host task service owns every logged model input.

#### KV Cache effect

Panel reads add no request tokens; the host task service owns execution history.


## Known Limitations and Deferred Work

- Additional requirements accepts one relative artifact path and required literal text at registration. Literal text without a path is rejected without sending a command; the draft remains available. These immutable checks strengthen deployment checks; they cannot replace hidden tests, alter evaluator commands or grant permissions. The optional `/task define` command accepts up to twenty bounded artifact rules. Trusted evaluator code remains host-owned. Lists refresh on request and after actions, not through a live task feed. There is no automatic retry, scheduler or failure-driven replacement-worker coordinator.


### Dev Note

None.
