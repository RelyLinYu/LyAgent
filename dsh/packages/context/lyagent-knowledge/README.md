---
description: "Versioned text collections with exact Agent grants and bounded lexical retrieval."
kind: "package-reference"
---
# LyAgent versioned knowledge

English | [中文](README.zh.md)

## Summary

This optional private plugin stores named text collections through native storage-domain. Host code publishes complete immutable editions, grants exact collection versions to selected native session identities, revokes with an empty grant list, and archives collections. Archival prevents new grants and edits but preserves previously pinned source evidence. Grant replacement may retain the same session's existing archived pin unchanged while adding other collections; it cannot introduce an archived pin or switch its version. New editions never silently update existing session grants. Tools derive the caller identity from execution, never model arguments.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Use this package

Configure positive integer `maxCollectionBytes`, `maxResultBytes`, `maxMatches` and `maxLineChars`. Collection bytes include complete retained JSON history. Output limits cover the complete JSON value including metadata. UTF-8 text SHA-256 identifies the imported text, not its original binary. Importers must acquire text under native filesystem/attachment permission; the service does not read arbitrary paths. No session is granted access automatically and no provider request is made.

Domain decoding verifies text digests, unique source identities, contiguous edition numbering and unique collection grants before exposing stored records. Corrupt durable records reject domain opening rather than disappearing or being treated as empty evidence.

`/knowledge catalog [after]` exposes a host-owned, item- and byte-bounded collection metadata page with titles, archived state and available version numbers. Pass the returned `next` identity as `after` to continue. It returns no source text and changes no grants. Model tools never expose this global catalog. Metadata too large for a single page fails explicitly rather than skipping a collection. Archiving a missing collection returns a domain refusal.

The host service `ctx.lyagentKnowledge` supports `publish(id, title, sources)`, `grant(session, pins)`, `archive(id)`, `list(session)`, `search(session, collection, version, query)` and `read(session, collection, version, source, line)`. Publication and grant writes serialize; rejected writes do not replace prior records. Source IDs are unique within an edition. Reads enforce authorization at execution, including direct service calls. Domain handles close on plugin disposal; tools unregister with their owning fiber.

Attach text files and submit `/knowledge import <collection> <title>` to publish one edition through the native Session-owned upload receipts. The importer accepts txt, md, csv, tsv, json and log files, streams verified immutable bytes under the aggregate collection limit, rejects invalid UTF-8 and NUL-containing binary content, and publishes only after every file passes. Duplicate byte-identical sources collapse by attachment digest. Source titles retain sanitized upload names; imported source identities use the attachment digest. Images, PDF, Office files and arbitrary host paths are unsupported. Import grants no Session access; use an explicit exact-version grant afterward.

With the native command registry mounted, `/knowledge publish <JSON>` accepts `{ collection, title, sources: [{ id, title, text }] }` as explicit user text and creates an immutable edition without granting access. `/knowledge grant <JSON>` replaces only the invoking conversation's grants using `[{ collection, version }]`; `/knowledge revoke` removes them, `/knowledge list` shows bounded authorized edition pins with explicit truncation, and `/knowledge archive <collection>` prevents future grants without erasing prior evidence. The command input is bounded by `maxCollectionBytes`. Commands make no model requests and their persisted user-command text is never automatically injected as model instructions. Publication and grant are deliberately separate operations. This is a portable text command interface, not a file picker or visual collection editor.


## Model Experience

### Knowledge tools

#### What the model sees

`list_knowledge` returns only the calling session's granted collection/version pins with explicit truncation; no grant returns an empty list. `search_knowledge` returns collection/version, explicit lexical matching basis, no-match/truncation indicators, total matches and bounded source/title/hash/line/text/matched-term fields. Conflicting matching lines remain separate. `read_source` returns one line with its source identity, text hash, total lines and truncation. No grant or wrong edition fails with `LYAGENT_KNOWLEDGE_REJECTED`, not an empty successful search. Tool descriptions classify source content as untrusted evidence, not instructions. Normal native tool results retain model-visible evidence in the session log.

#### Token effect

Conditional schemas when enabled and bounded JSON text per call. No extra model requests or automatic context injection.

#### KV Cache effect

Append-only tool results. Existing history is unchanged when collections change; a later explicit grant may select another immutable edition.


## Known Limitations and Deferred Work

- Native text command controls, UTF-8 attachment import and host API are available; no visual collection editor is provided. The artifact-acceptance task host captures complete authorized source manifests through `snapshot(session)` and checks them at task start and settlement; this does not establish semantic citation support.
- NFKC case-folded lexical retrieval and Han bigrams are not embeddings, semantic paraphrase validation, OCR, contradiction detection or entailment checking. No-match must not be converted to a fabricated answer.
- Archival retains old evidence and its existing grants; callers must explicitly revoke access when removal requires denying prior readers. This is not physical erasure.
- Records are bounded in memory per collection; there is no global collection quota or cross-process live refresh. Deployments remain trusted and own total storage policy.


### Dev Note

None.
