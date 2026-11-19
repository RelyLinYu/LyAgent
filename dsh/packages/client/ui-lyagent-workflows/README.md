---
description: "Human controls for saved profiles, teams and workflow editions."
kind: "package-reference"
---
# LyAgent workflow manager

English | [中文](README.zh.md)

## Summary

An optional native right-sidebar panel manages human-saved profiles, teams and exact-version workflows through the existing command transport. It makes no model request while browsing or saving. Run is an explicit action on the current conversation and remains subject to native permissions and any mounted budget policy. Failed operations retain drafts; ambiguous mutations are never retried automatically.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Use this package

Mount the matching host workflow library and this client plugin through the LyAgent orchestration overlay. Browse exact editions and review retained drafts before an explicit save or run.


## Model Experience

None, as this browser-side panel registers no model-facing tools or prompts.

#### KV Cache effect

None directly; the saved workflow library and native execution path own executed model requests.


## Known Limitations and Deferred Work

- The panel is a bounded form editor, not a visual graph canvas or crash-resume interface. Human runs outside a model turn cannot obtain parent-turn model allocations under the optional budget policy. Saving a route does not configure model credentials or grant workspace access.


### Dev Note

None.
