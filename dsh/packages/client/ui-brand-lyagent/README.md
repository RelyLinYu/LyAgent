---
description: "LyAgent identity and settings entry for competition deployments."
kind: "package-reference"
---
# LyAgent Native Brand

English | [中文](README.zh.md)

## Summary

Show the LyAgent name, marks and competition settings entry in the native Web client. Upstream DeepSeek Harness licensing and notices remain in the distribution. This plugin starts no model requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Use this package

The LyAgent overlay disables the official artwork plugin and mounts this plugin through the native client loader. It fills the existing sidebar and hero mark slots without changing conversation, permissions, model or tool behavior. The sidebar name tooltip identifies the upstream basis through native English and Simplified Chinese dictionaries; other locales use the native fallback chain.


## Model Experience

None, as the identity and settings contributions register no model input.

#### KV Cache effect

The plugin changes no model request tokens.


## Known Limitations and Deferred Work

- This plugin is not a complete brand migration: onboarding, provider names and upstream notices remain truthful and unchanged. Competition eligibility has not been established. No orchestration functionality is included.


### Dev Note

None.
