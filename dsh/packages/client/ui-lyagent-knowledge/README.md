---
description: "Human controls for versioned knowledge imports and conversation grants."
kind: "package-reference"
---
# LyAgent knowledge panel

English | [中文](README.zh.md)

## Summary

Optional native right-sidebar controls for human knowledge management. Mount `lyagent-knowledge.overlay.yml` with the Web profile. The matching host knowledge plugin is required; this panel does not start model turns.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Use this package

Import accepts uploaded text files through the native session-owned receipt path. Publishing a collection does not authorize it. Selecting a version and using it in the conversation replaces that collection's pin while preserving other grants. An incomplete grant list refuses replacement. Archive preserves historical versions; revoke removes the current conversation's grants.

Operations are never retried automatically. A failed mutation can already have committed; refresh and review the current host state before trying again. Plugin disposal retires pending mirror updates and prevents dependent commands after an awaited read settles; it does not roll back a command already dispatched.


## Model Experience

Indirectly, through explicit conversation grants; the host knowledge plugin owns model-visible retrieval.

#### KV Cache effect

Panel commands add no model tokens; knowledge tool results belong to the host plugin.


## Known Limitations and Deferred Work

- The panel imports UTF-8 text only; it does not parse PDF or Office documents. Catalogs refresh on explicit reads and after actions.
- A failed command may already have committed; refresh authoritative state before another explicit mutation.


### Dev Note

None.
