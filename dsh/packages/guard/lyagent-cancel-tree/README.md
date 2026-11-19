---
description: "Root-turn cancellation propagated to resident delegated children."
kind: "package-reference"
---
# LyAgent delegated cancellation

English | [中文](README.zh.md)

## Summary

Opt-in root-turn cancellation policy using native agent pre-step, subagent lifecycle and tool guard registrations. Cancelling an observed root turn synchronously interrupts its tracked resident children, including descendants. Native adapters and tools own abort handling and settlement. This policy does not mark a child completed or undo effects already dispatched.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Use this package

An aborted root turn also denies new delegated steps and tool dispatch with `LYAGENT_PARENT_STOPPED`. A new root turn replaces the cancellation signal, so the same conversation can delegate again without permanently draining its tree. Existing native inbox parking and interruption semantics remain unchanged. Unloading the plugin removes its listeners and guard; native activations remain owned by the subagent service.


## Model Experience

### Stopped parent task

#### What the model sees

`The parent task was stopped. Do not continue delegated work until the parent starts a new task.`

#### Token effect

No additional model request is started by this policy. Rejected delegated pre-steps do not dispatch to the model.

#### KV Cache effect

Conditional appended failed tool results; admitted request prefixes are unchanged.


## Known Limitations and Deferred Work

- A root must enter a native pre-step before its turn signal can be observed. Direct host-created delegation without an observed root turn has no parent-turn signal to inherit.
- Interrupt requests are synchronous, but child quiescence depends on native cancellation-aware adapters and tools. Callers must await child idle or activation disposal before claiming all work stopped.
- This is process-local cancellation, not crash recovery or cross-host termination. Pending budget reservations remain unknown after interrupted usage.


### Dev Note

None.
