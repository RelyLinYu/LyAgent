---
description: "Durable batch and root-turn model request accounting."
kind: "package-reference"
---
# LyAgent authorization batch policy

English | [中文](README.zh.md)

## Summary

Opt-in native `llm/stream` admission using the configured storage-domain backend. Configure one explicit `batchId`, immutable `maxRequests` and `maxTokens`, conservative `reservationTokens`, and `maxConcurrent` between one and three. No active authorization is shipped in the deployment overlay.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Use this package

Every provider stream reserves one request and tokens durably before dispatch. Actual authoritative aggregate input/output usage replaces its reservation only after a successful terminal stream. Missing, malformed, failed or interrupted usage keeps the reservation as unknown and blocks later calls. Pending records found after restart also block further requests. Changing limits under an existing batch id fails. The record contains accounting only, never credentials or request content.

Stored request identities must be unique and token counters and aggregate totals must remain safe integers. Invalid stored accounting prevents activation. A settlement for a missing reservation fails instead of reporting an accounting success.

This policy covers auxiliary and child model requests in the same host. Concurrency saturation rejects before dispatch; it does not queue or retry. Disable native automatic retries for bounded acceptance. A storage failure propagates and stops the operation; it is never reported as a successful budget settlement.

Optional `runLimits` supplies explicit `maxRequests`, `maxTokens`, `childMaxRequests`, and `childMaxTokens`. Each admitted request then records its root Session and original turn-start sequence plus member Session id inside the same batch record. Parent-run and member checks occur in the same durable reservation as batch admission. A child captures the run at activation publication; advancing the parent turn does not move a live child's charges to the new run. Limits already used by a run or member cannot change.

With run limits enabled, every stream requires a live native owning Session and an open root turn or captured child allocation. Missing ownership rejects before dispatch, including unowned auxiliary calls. Batch-only deployments retain their original behavior.

The host-only `ctx.lyagentBudget.seal(run)` durably closes admission for a root Session and turn-start sequence. It returns charged counts and `ready` only when that run has tracked requests, every batch request is settled, and batch, run and member actual usage stays within its limits. Pending, unknown, untracked or over-limit usage cannot complete a business task. Sealing is idempotent; late authoritative settlement remains possible but further root or child admission is denied. Batch-only accounting cannot establish per-task readiness.


## Model Experience

None, as this policy adds no prompt or tools.

#### KV Cache effect

Independent: admitted request content remains unchanged.


## Known Limitations and Deferred Work

- Run limits bound root turns, not a separate durable business-task entity. Child shares are uniform configured ceilings, not reservations guaranteeing capacity for every child.
- Live child-to-run ownership is process-local. After restart or plugin reload, a child needs a newly published activation under an open parent turn; there is no automatic rebinding or resumed task execution. Persisted request allocations remain charged.
- Reservations are conservative admission accounting, not a provider-enforced invoice cap. A provider can report more than reserved; that full usage is retained and prevents later admission.
- Unknown usage requires explicit external review; there is no automatic clearance or batch expansion.
- Production deployment remains opt-in until real-composition and cancellation lifecycle acceptance pass.


### Dev Note

None.
