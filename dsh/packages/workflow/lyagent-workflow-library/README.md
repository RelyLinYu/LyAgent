---
kind: package-reference
description: "Save immutable LyAgent workflow plans, pin team roles and knowledge, and run exact editions through native workflows."
---

# LyAgent saved workflow library

English | [中文](README.zh.md)

## Summary

Save exact workflow versions, compose bounded dependency plans, and run them under the calling conversation's native permissions. Plans pin team roles, models and knowledge versions; publication never starts a model request. Runtime evidence records the selected edition and outcome.

## Table of Contents

- [Saved editions](#saved-editions)
- [Dependency plans](#dependency-plans)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Saved editions

An opt-in host plugin stores named, immutable JavaScript workflow editions. `/saved-workflow publish <JSON>` accepts `id`, `expectedVersion`, `description` and `script`. Version zero creates an identity; later publications must name its current version. Conflicts reject without replacement. History is retained, scripts carry SHA-256 digests, and configured `maxDefinitionBytes` bounds each complete history while `maxEntries` bounds catalog identities. Publication does not execute or grant permissions.

`/saved-workflow list` returns metadata; `read <id> <version>` returns an exact retained edition. `run <id> <version>` invokes the existing foreground native `workflow` tool in the calling idle conversation. Its existing script parser, subprocess restrictions, child policy, approvals and model admission remain authoritative. The human command's durable input and result retain the selected version, digest and native result; native workflow records retain child progress. Execution errors are command errors, not successful partial results. Cancellation and disposal remain owned by the native tool; library unload waits for admitted commands before closing storage.

Every successful run also writes one evidence record to `<workspace>/workflows/<id>-v<version>-<runInstant>-<nonce>.json`, from the `saved_workflow` tool and the `run` command alike. The run instant and nonce make each record unique and the write refuses an existing path, so re-running one version never overwrites earlier evidence. A record that cannot be written is reported — the command result carries `record: { error }`, the tool logs a warning — and never changes the run's own result.

## Dependency plans

`publish-plan` retains the parsed `sourcePlan` with the compiled edition. Old editions without a plan remain readable by the storage layer, but editions without `knowledgeMode` cannot be read, run or embedded through the managed command path. A human script publication is trusted input; its `human` marker does not upgrade legacy compiler behavior.

Publication checks knowledge access before compilation and again inside the serialized write queue immediately before storage starts. Loss of access while waiting rejects without appending a version. If access changes while storage is writing, publication returns only `{ id, version, sha256, publication: { state: "committed", body: "withheld", reason: "knowledge-access-changed" } }`; it does not return the body or claim rollback. Re-read the current version after restoring access rather than repeating the old `expectedVersion`.

Human `/saved-workflow publish-team <JSON>` stores `id`, `expectedVersion` and a `definition`. A profile definition has `kind: "profile"`, `description`, `instructions`, `provider`, `model` and `enabled`. A team has `kind: "team"`, `description` and `members: [{ role, profile: { id, version } }]`. Team role names must be unique and every profile version must already exist. `/saved-workflow teams` lists metadata; `read-team <id> <version>` reads a retained edition. These definitions use a separate storage domain, retain immutable versions and reject stale saves or identity kind changes.

A plan node with `kind: "role"` supplies `team: { id, version }`, `role`, `prompt` and the usual node identity and dependencies. Publication resolves the team's pinned profile, rejects missing or disabled roles, and embeds its instructions, provider, model and exact reference identities. Later team or profile publications do not alter the saved plan. These definitions select child routes; they do not replace native Team task boards, grant tools or provide role-capacity admission.

Human `/saved-workflow publish-plan <JSON>` accepts `id`, `expectedVersion`, `description` and up to 32 `nodes`. Each node has a unique `id`, explicit `dependsOn` and a `kind`: `agent` requires `prompt`, `provider`, `model`; `saved` requires an exact `workflow: { id, version }`; `repeat` also requires `count` from one through eight; `branch` requires a dependency `source`, property `path`, scalar `equals`, and exact `then`/`otherwise` references; `check` requires `expect: { mustContain, minLength }` and asserts its dependency results. Dependencies execute in parallel layers; failed layers stop dependents. Branch sources must be direct dependencies. Duplicate nodes, absent edges and cycles reject before publication. Saved editions are embedded with their digests at publication, including nested compiled plans; execution never resolves a newer version. Repeated nodes pass `{ dependencies, iteration }` as `args`; other saved nodes receive their dependency result map. Agent prompts include serialized dependency results. All children share native run caps; repeated saved scripts can still fail those caps.

A `check` node may name one optional `rework` target plus `attempts` from one through three. The target must be a direct dependency of that `check` and must be a `role` or `agent` node; `attempts` without `rework` rejects. Only a failed assertion re-runs the target: the generator's next prompt carries the gate's concrete failure reason, its result replaces the recorded value and the gate re-asserts. At the attempt limit the layer fails and dependents never start. A target that throws, is cancelled or returns no successful value fails the gate immediately instead of re-running it.

`retry` counts total node attempts, from one through three. Null child results, cancellation and failed checks stop the containing compiled plan without outer retries; ordinary errors may retry the entire node. A `repeat` node requires `retry: 1` and rejects larger values at publication. A surrounding `saved` node with retries can still replay its complete saved unit, including already completed repeat iterations, after an ordinary error. Use `retry: 1` around units with non-repeatable side effects; this library provides no durable per-iteration resume.

The offline [candidate procedure](../../../../scripts/WORKFLOW-CANDIDATE.md) recompiles explicit reviewed replacements against predecessor versions and digests. It never recovers a lost original plan or writes the source home. Candidate data includes scripts, plans, collections and Agent grants; a summary of hashes alone is not importable.



## Model Experience

### Saved workflow call and result

#### What the model sees

The `saved_workflow` tool accepts exact `id` and positive `version` fields. Its description is `Execute an exact human-saved workflow version under the current task permissions and budget. Never infer a version or substitute the latest. Publication is human-only.` Success returns the selected `id`, `version`, `sha256` and native result text. Native failure returns `Saved workflow execution failed (<code>). Check workflow permissions and run status before restarting.` A composition without the native `workflow` tool — the shipped `ptc` preset among them — instead returns `Saved workflows need the native workflow tool, which is not available to this conversation. Use a preset that exposes workflow, or have the model author the orchestration directly.` The caller's step admission is forwarded to native execution, together with deferred context and successful turn conclusion. Publication remains human-only; parent-turn budget admission applies to children.

#### Token effect

The tool schema joins enabled conversations; successful and failed results remain in tool history. Script execution uses native result limits and child request accounting. Publication and lookup make no model request.

#### KV Cache effect

Publication and lookup make no model request. Execution uses the selected native workflow script; child context and caching belong to the native execution path.

## Known Limitations and Deferred Work

- This library has no visual graph editor, role-capacity admission or resumable workflow journal. Nested editions are embedded at publication and share the owning native run and child limits.
- Scripts are trusted human inputs executed under existing native policy, not an OS security guarantee. Publication validates records and digests; the native engine validates JavaScript only at execution.
- Execution requires the native `workflow` tool. Presets without it, including `ptc`, reject saved workflows before a child starts; PTC programs cannot nest saved workflows.
- Command-driven execution outside a model turn cannot acquire parent-turn model allocations. Deployments requiring run accounting must invoke `saved_workflow` from an owning model turn.

### Dev Note

None.
