---
description: "The identity package group: one anonymous correlation id per harness home, plus the local enterprise account directory that admits signed browser sessions."
kind: "package-group"
---

# identity/ — shared identity

English | [中文](README.zh.md)

## Summary

The identity group answers two questions about where a request came from. One package gives every harness home an anonymous id that telemetry, feedback, and DeepSeek requests attach to their records, so records from one installation are recognizable without identifying the user. The other package is the local account directory: it stores accounts and resource grants, signs browser sessions, and admits them as the `user` principal that business packages authorize. The anonymous id needs no configuration; the account directory needs an administrator, which the first registration creates. This page maps the group, and the package READMEs own the details.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`anonymous-user-id`](anonymous-user-id/README.md) | Gives every harness home one anonymous id that telemetry, feedback, and DeepSeek requests attach to their records, so records from one installation can be recognized without identifying the user |
| [`account-directory`](account-directory/README.md) | Stores local accounts and per-resource grants, serves the Host login and administration pages, and admits signed sessions as the `user` principal |

<a id="related-documentation"></a>
## Related documentation

- [Session telemetry subsystem](../../docs/subsystems/session-telemetry.md) — the telemetry feature that carries the id on exports.
- [dsh-llm-deepseek](../llm/llm-deepseek/README.md) — the DeepSeek provider that carries the id on requests.
- [dsh-command-feedback](../feedback/command-feedback/README.md) — the feedback command that names the anonymous installation in its acknowledgement.
- [dsh-api-remote-access](../api/remote-access/README.md) — the access policies the account directory binds grants into.

<a id="dev-note"></a>
## Dev Note

None.
