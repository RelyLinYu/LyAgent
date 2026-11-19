---
kind: upgrade-guide
description: "LyAgent plan publication distinguishes committed protected receipts and rejects repeat-node retries."
---

# LyAgent workflow publication and retries

English | [中文](guide.zh.md)

## Change

`publish-plan` now checks knowledge access inside the publication queue. Revocation before storage starts rejects without adding a version. Revocation while the write is in flight returns a successful, body-free receipt with `publication.state: "committed"`, `publication.body: "withheld"` and `publication.reason: "knowledge-access-changed"`, together with `id`, `version` and `sha256`. Callers must not interpret this response as an uncommitted failure or expect the compiled body.

Compiled editions retain optional `sourcePlan`. Existing records remain valid storage inputs; this field does not change Session format. Editions predating `knowledgeMode` remain blocked by managed read/run/embed operations. Republishing an old script as human input does not update its retry behavior.

A `repeat` node rejects `retry` greater than one. A retrying surrounding `saved` node can still replay its complete unit after ordinary errors, including iterations completed before the error. Null results, cancellation and failed checks stop newly compiled plans without outer retries.

## Migration

1. Update command consumers to handle the body-free committed receipt. Restore knowledge access, then read the returned exact version; do not blindly retry the previous `expectedVersion`.
2. Change repeat nodes to `retry: 1`. Use `retry: 1` on surrounding saved units when their completed effects must not repeat.
3. Recompile reviewed plans instead of relabeling legacy scripts. Follow the [offline candidate procedure](../../../../../scripts/WORKFLOW-CANDIDATE.md), review replacement semantics, and authorize the actual runtime Agent id.
4. Verify candidate hashes, then rehearse through the isolated Loader. A generated candidate and passing keyless tests do not deploy the production instance or validate real business output.
