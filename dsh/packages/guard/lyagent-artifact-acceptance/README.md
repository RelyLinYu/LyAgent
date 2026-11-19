---
description: "Trusted artifact and evaluator checks with durable business task settlement."
kind: "package-reference"
---
# LyAgent mechanical artifact acceptance

English | [中文](README.zh.md)

## Summary

Opt-in host-owned rules gate the native `present` tool's successful result before its final delivery observer records `deliverables/presented`. Each configured required artifact must be declared, remain a regular file at one provider version while read, satisfy explicit positive byte bounds and required literal text, and match an optional exact raw-byte SHA-256. Rules are deployment configuration, not model-supplied success criteria. All configured rules run again for every delivery attempt; no earlier success is reused after a file changes.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Use this package

Configure `artifacts: [{ path, minBytes, maxBytes, includes, sha256? }]` in a separate overlay for the task. No rule or automatic approval is shipped in the general orchestration overlay. Paths resolve against the calling Session's current directory through the native filesystem provider. Native permissions and root/child tool policies remain active. Failed checks block delivery with `LYAGENT_ARTIFACT_REJECTED`; provider failures also fail the tool closed. A successful result includes checked raw-byte hashes in logged model-visible content. Without `tests`, checks execute no shell. Optional tests use native PowerShell; neither mode starts another model request.

Optional `tests` requires `{ python, root, files: [{ path, sha256 }], minTests, timeoutMs }`. Python and evaluator root are absolute, the evaluator root is outside the workspace, and flat `.py` filenames have pinned raw-byte SHA-256 values. Verified source bytes are compiled directly rather than imported from a bytecode cache. Native `pwsh` policy, approval and cancellation remain active. Its per-call deadline kills without background promotion. Delivery requires a complete foreground result, exit zero, complete JSON stdout, a positive minimum test count, and no timeout, cancellation, sandbox denial, failures, errors or skips. Artifact versions are checked again after testing. The enclosing logged delivery result retains the test summary; the internal executor call does not create a model step.

### Task execution and repairs

When several artifact mappings name one work order, repair execution selects only the mapping matching the persisted host rejection path. It never uses another artifact's worker policy. Without a persisted rejection, multiple matching mappings stop as ambiguous rather than choosing the first route.

A candidate's optional positive `maxActive` bounds its live repair activations within the same artifact mapping and task-runtime instance. Omission imposes no candidate-specific limit. Selection excludes full candidates, reserves the selected identity synchronously before asynchronous startup, and releases it after successful activation disposal on success, failure or cancellation. Failed disposal retains the reservation and read-only guard until runtime teardown because child quiescence is unverified. Full mappings stop without queuing or retry. These process-local reservations are not shared across mappings, services or restarts and do not replace durable model-budget admission.

Repair mappings may specify ordered `candidates: [{ id, enabled, capabilities, provider, model, readOnlyTools }]` and `requiredCapabilities` instead of `worker`. Only these host-authorized routes participate. Before dispatch, selection records disabled candidates, missing declared capabilities and unregistered providers, then selects the first eligible entry and records remaining eligible entries as lower preference. Capability labels are trusted declarations, not measured competence. Selection performs no provider probe; exact-model or execution failures stop the attempt without trying another candidate. The decision is logged in child input and the parent proposal. This is bounded repair-route selection, not a general capacity scheduler or a replacement for native model-tool Session authorization.

The Web task-runtime acceptance owns a complete normalized native Session output golden at `apps/web/tests/expected/lyagent-task-recorded-session.jsonl`. It replays the committed artifact-gate model streams through real task execution, file tools and independent Python evaluation, then compares every normalized event. Exact temporary paths, Web origin and the shared time-context normalizer remove run-local values; tool outcomes, hashes and event order remain. This is a keyless output oracle, not a new paid recording or a canonical Session replay generation.

Final artifact revalidation rejects files larger than the registered deployment and additional-requirement byte ceiling before reading them. Typed filesystem failures during final artifact/evaluator reads leave acceptance unverified and settle the task as requiring attention; they never complete the task or schedule a repair. Unexpected implementation failures still propagate.

Task settlement persists all detected acceptance failures in its existing attention reason: missing delivery, unverified artifact or evaluator versions, changed knowledge grants, unsettled budget, incomplete approval/tool records, unfinished work orders, child evidence and newer conversation work. These diagnostics neither authorize a retry nor establish unknown external effects as safe. Historical records retain their recorded reason.

Optional `repairTargets: [{ path, workOrder }]` pins unique configured artifact paths to native board identities. Human `/task coordinate <id>` explicitly starts execution and, only after a clean completed turn with settled tools, approvals, children, sources and budget, may reopen the mapped failed artifact's work order and dependent descendants. Repair also requires the same board service, readable state, every registered task still present, and unchanged completed independent branches from prior repairs; deletion during the turn prevents automatic correction. Each correction reserves the existing durable repair allowance before mutation and requires a new native turn and fresh independent acceptance. Unknown effects, budget failures, unmapped paths, cancellation and evaluator-only failures stop without retry. `/task run` remains single-attempt execution. The coordinator does not infer work identities from model prose or constrain file writes; trusted deployment mappings must match the intended board. No mapping or automatic repair is enabled in the general preview.

Task-owned mechanical declaration, missing-file, byte-bound and required-text failures persist the configured artifact path, host diagnostic and owning turn sequence. Explicit repair execution copies that prior path and diagnostic into the next logged user input alongside the affected work identities before a new attempt clears the current rejection. Successful independent acceptance also clears it. Late or foreign attempts cannot replace it. The record alone starts no repair or model request. Historical tasks without a rejection field retain their prior meaning.

A repair mapping may additionally specify `worker: { provider, model, readOnlyTools }`. Omission keeps parent-only execution. A configured route starts one native `spawn` activation before the repaired parent's first request; its objective, reopened work identities and prior host rejection are logged in the child. A temporary monotonic execution guard restricts descendants of that root to the trusted read-only tool list until activation disposal. Tool names are host-audited policy, not inferred safety. Completed child output, including its identity wrapper, must fit `tests.maxChildResultBytes` before it is appended as a logged unverified proposal to the parent. Noncompletion, cancellation or oversized output stops that attempt without retry; independent artifact, child-output and budget checks still determine settlement. This is fixed deployment routing, not general worker selection or filesystem isolation.

Human `/task define {"objective":"...","requirements":[{"path":"report.md","minBytes":1,"maxBytes":4096,"includes":["Required text"]}]}` registrations add immutable artifact requirements to the existing deployment rules. Paths are relative, bounded and cannot traverse parents; requirements contain no executable evaluator input. Every delivery checks both sets and records each artifact hash once. Additional sizes cannot exceed the deployment's largest artifact limit. The task's logged execution input includes these public requirements. Historical records without the optional `requirements` field add no checks. This entry does not replace trusted independent test configuration or authorize file access.

`/task criteria` reads the current deployment's required artifact paths, positive size bounds, minimum independent test count and correction limit without a model call. It excludes hidden evaluator filenames, paths, source text and required literal answers. This is a read-only summary, not an acceptance-rule editor.

New task registrations pin a SHA-256 digest of the complete trusted artifact rules, evaluator configuration and correction limit. Beginning another attempt rejects changed deployment criteria and requires a new task registration. Historical tasks without this optional digest retain their prior unpinned meaning. The digest does not expose hidden evaluator source or permit model-supplied criteria.

Explicit repairs pin completed independent board identities and revisions before reopening affected work. Settlement requires those pinned tasks to remain completed at the same revisions, even if a later delivery captured an edited board. Historical repairs without these optional pins keep their earlier meaning. These pins do not constrain workspace file writes.

`/task repair <task-id> <work-order-id>` explicitly reopens a completed failed work order and its transitive dependency descendants without starting model requests. The owning task must need attention and the root conversation must be idle. Each repair reserves one durable allowance before native compare-and-set board updates; cancellation is checked before reservation and each board append. Partial failures or cancellation retain that allowance and committed board changes, without retry. Independent branches keep their existing revisions. The same configured `maxRepairs` bounds these explicit repair reservations per task separately from delivery checks. A subsequent `/task run` logs the affected identities and asks the model to preserve unrelated completed work and artifacts, then requires fresh independent acceptance. That instruction is not filesystem write confinement. Repair does not automatically select a failed work order or dispatch replacement children.

Task-run evaluators receive `LYAGENT_CHILD_RESULTS`, a list of host-read local child outputs with Session identities and SHA-256 digests. If children exist, `tests.maxChildResultBytes` must explicitly bound the complete serialized list. Pending children, absent final outputs, incomplete logs and oversized inputs block delivery before evaluation. Settlement rereads the same child activation outputs and rejects changed measurements. Tests must explicitly assert task-specific child content; merely receiving these inputs does not establish semantic correctness. This does not automatically schedule dependency-driven repairs.

`/task list [after]` returns only the invoking conversation's task identities, states and objectives clipped to 240 characters. Pages hold at most fifty entries; pass the returned `next` identity to continue. The directory does not expose artifact/evaluator paths or trigger execution. Host `list(agent, after)` uses the same durable records and isolation.

Task composition requires an explicit `maxRepairs` integer from zero to two. One attempt admits its first delivery check and at most that many subsequent repair checks; further delivery attempts clear prior acceptance and cancel the owning native turn before checking again. This caps delivery verification, not general model steps or arbitrary edits; run accounting independently bounds requests and tokens. A host restart never resets an active attempt into automatic execution.

When `taskRuns` and the native command registry are mounted together, `/task new <objective>` registers an unstarted task and returns its identity. `/task status <id>` reads that conversation's task; `/task run <id>` explicitly executes a queued or attention-required task with mounted run budget accounting and no automatic retry, waits for native root and child work, and performs final settlement. `/task cancel <id>` records cancellation and requests native stop only for that task's active attempt. Registration and status start no model requests. Commands reject cross-conversation identities and concurrent or queued conversation work; the task-specific artifact and evaluator criteria still come from trusted deployment configuration. A cancelled command request signals native stop, but the host execution retains cleanup ownership until its turn settles.


Optional `taskRuns: true` additionally requires native agents, session persistence and storage-domain services plus independent tests. The host API `ctx.lyagentTaskRuns` registers explicit task objectives, binds an attempt during an open native turn, reads durable state, cancels it, and explicitly settles after that turn. A successful `present` only records pending acceptance. Settlement flushes and independently opens native persisted history, requires the matching delivery and turn ending, and hashes artifacts and evaluators again. Idle alone never completes a task. Interrupted attempts become `needs_attention` at plugin startup and are never replayed. Portable commands support additional human requirements and explicitly mapped bounded coordination; a trusted evaluator editor and general failure diagnosis are not provided.



Independent test failures identify unavailable or denied execution, deadline expiry, interruption, unsuccessful exit, incomplete process fields, sandbox denial, incomplete JSON output, or unmet test counts. Diagnostics do not expose raw evaluator stdout/stderr or claim that an unverified process passed.

Successful test summaries include each pinned evaluator filename and SHA-256 alongside the test count; the enclosing persisted tool result binds these evaluator inputs to the checked artifact digests.

When task runs are enabled, every subsequent delivery attempt clears its earlier pending candidate. Task completion also requires the last logged tool call in the owned turn to be that accepted `present`, a successful persisted tool result, no newer native turn, and an unchanged durable task revision. Later tool calls conservatively require a new delivery check.

The owning turn's persisted approval audit must contain one matching decision per request. Unanswered requests, duplicate open identities and unmatched decisions prevent completion. A closed rejection does not by itself invalidate a later independently accepted delivery.

Every logged tool call in the owning turn needs exactly one corresponding result; missing results, duplicate open call identities, unmatched results and native `TOOL_OUTCOME_UNKNOWN` prevent completion. An ordinary closed tool failure does not itself invalidate a later independently tested delivery. This audit covers logged calls, not undisclosed or detached external effects.

Native child lifecycle tracking requires every observed activation under the task's root to release its resources before completion. An idle but resident child still blocks settlement; an abnormal child ending during the attempt also blocks it. Removing or replacing the subagent service prevents completion. This does not independently validate a child's proposed result.

When the native Team service is mounted at attempt start, settlement requires the same underlying service instance and every current non-deleted board task to be completed. Acceptance captures each board task's identity and revision; settlement requires that exact list, so later edits, dependency changes or additions require another delivery check. Registration saves the current board task identities; each must remain present and completed at settlement. Deleting a task during the owning turn also blocks completion. State comes from the native synchronous projection, including when Team mode is disabled. This conservative check covers the whole board; it does not establish independent acceptance of each child's result or automatically schedule localized repairs.

If the knowledge service is mounted at task registration, the task stores the complete host-only manifest of that session's authorized editions and source text digests. Settlement requires the same manifest; revoked or replaced grants cannot complete the task against its earlier sources. If the service was absent, registration stores no knowledge requirement. Historical tasks lacking this optional field retain their prior meaning. This binds source inputs, not semantic citation support or proof that the model read every source.

An attempt captures the mounted budget service when it begins. Settlement requires that same service and a sealed root-turn allocation with all batch usage settled inside batch, run and member limits. Untracked, pending, unknown or over-limit usage prevents completion. Removing, replacing or newly mounting a budget service during the attempt also prevents completion. If no budget service exists throughout the attempt, this API performs no budget verification; production paid-task composition must mount run accounting explicitly.


## Model Experience

### Delivery checks

#### What the model sees

Failed checks return `Artifact acceptance failed:` with the unmet mechanical requirement. Successful calls append `Mechanical artifact checks passed for these versions only:` and the checked paths and SHA-256 values.

#### Token effect

Conditional result text per delivery attempt. Explicit coordinated repairs with a configured worker start a native child activation, charged to the owning root-turn budget; no worker is started without that mapping.

#### KV Cache effect

Append-only tool results; existing request history is unchanged.


## Known Limitations and Deferred Work

- File rules check literal text, size and digests. Optional tests establish only what trusted tests assert, not general semantic correctness or source entailment. A delivery pass is not complete task acceptance.
- Native `present` opens current files rather than immutable copies. The reported hashes bind the checked versions only; later changes need new checks and may change what the user opens.
- This gates `present`, not arbitrary assistant completion claims, shell side effects or all workspace files. Optional task runs currently require explicit host orchestration and do not bind child work-order content to independent semantic evidence. Settlement independently reopens each observed local child's persisted activation suffix and requires completed, closed turns, paired tool calls/results with no unknown outcomes, and closed approval pairs. External children without readable local history cannot pass this audit. This audit does not reconcile unlogged external effects or validate the meaning of child text. Evaluator tests are trusted executable code, not an adversarial OS-isolated judge; their directory and Python installation must remain host-controlled.
- Checks run in-process under the filesystem provider's freshness guarantees, not OS confinement against a privileged concurrent writer. Deployment code must remain trusted.


### Dev Note

None.
