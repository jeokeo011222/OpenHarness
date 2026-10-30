---
description: "Local enterprise accounts: registration, account and grant administration, signed browser sessions, and the identity seam that admits them."
kind: "package-reference"
---

# @deepseek-ai/dsh-account-directory

English | [中文](README.zh.md)

## Summary

`dsh-account-directory` keeps local enterprise accounts in a storage domain. An administrator registers accounts, assigns global roles and per-resource grants, and the Host serves login and administration pages. Signed session cookies bind each browser to one account and one authority; the `user` principal kind and the Connection identity seam let business packages authorize that caller. The first account on an empty directory becomes the administrator, and an administrator passes every Remote access check. Grants and the administrator role are the only inputs access policy sees, so a resource kind without a registered rule stays owner-only.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The plugin mounts itself with the bundle and needs no per-deployment step beyond its config:

| Config field | Default | Effect |
|---|---|---|
| `sessionDays` | `30` | Browser session and cookie lifetime in days. |
| `allowRegistration` | `true` | Whether accounts beyond the first may register themselves at `/login`. |
| `minPasswordLength` | `8` | Shortest accepted password; shorter submissions are refused before hashing. |

Use the Host pages to operate the directory: `/login` registers the first account or signs an existing one in, and `/admin` lists accounts and grants so an administrator can create, update, or delete accounts, reset passwords, and grant or revoke resource roles. `GET /auth/state` reports the signed-in account and its grants as JSON.

### Signing in

A successful `POST /auth/login` or `POST /auth/register` answers `303` to `/` with an HttpOnly, `SameSite=Strict` session cookie scoped to the request's authority. The cookie name includes a hash of that authority, so sibling local authorities never share an account cookie, and the cookie is `Secure` when the Host serves HTTPS. `POST /auth/logout` clears it and returns to `/login`.

### Administering accounts and grants

`/admin` refuses non-administrators with `403` and sends signed-out visitors to `/login`. The page's forms call `POST /admin/user/create`, `/admin/user/update`, `/admin/user/delete`, `/admin/grant/set`, and `/admin/grant/delete`; each answers `303` back to `/admin` on success and re-renders the page with the failure message otherwise. `GET /admin/state` serves the same directory state as JSON for the client workbench — `{ account, accounts, grants }` — and answers `401` when signed out, `403` when the caller is not an administrator, and `405` to methods other than GET and HEAD. A grant names a resource kind, a resource id, and at least one role from `ACCOUNT_ROLES`. Deleting an account also removes every grant it holds and disposes its cached Peer.

### Contributing a resource kind

A business package that declares a resource through `ctx.typert.resources` contributes the grant semantics for that kind once:

```ts
ctx.inject(['accountDirectory'], (scope) => {
  scope.effect(() => {
    const rule = scope.accountDirectory.acl.register({ kind: 'ontology-domain', bind: ontologyDomainBindings })
    const baseline = scope.accountDirectory.acl.registerBaseline(() => ONTOLOGY_BASELINE)
    return () => { baseline(); rule() }
  })
})
```

`bind` decides which Remote actions a stored role set entitles on that resource, and a baseline grants every signed-in account bindings that need no per-resource record. Both registrations invalidate cached access decisions when they change.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The directory owns the `account` storage domain, one Remote-access policy for the `user` kind, and the `connectionIdentity` service; the observable behavior is covered in [Use this package](#use-this-package). The policy answers `unrestricted()` true for an account holding the `admin` role, so an administrator passes every action check and the page opens with the owner access snapshot; other accounts act only where their grants and the ACL registry allow.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service: account and grant mutations, session lookup, policy, ACL registry, HTTP routes |
| [`src/session.ts`](src/session.ts) | Signed session tokens, cookie names and attributes, session secret persistence |
| [`src/password.ts`](src/password.ts) | scrypt verifier derivation and constant-time verification |
| [`src/pages.ts`](src/pages.ts) | Login and administration HTML |
| [`src/http.ts`](src/http.ts) | Form parsing, JSON and HTML responses, redirects, origin checks |
| [`src/spec.ts`](src/spec.ts) | Storage domain spec and record schemas for accounts and grants |
| [`src/types.ts`](src/types.ts) | Account vocabulary, ACL registry interfaces, the `user` principal kind |

### Design decisions

- **Host HTML, not a Remote namespace.** The `account` Remote namespace belongs to DeepSeek account sign-in, so account and grant administration travels over Host-served forms and JSON routes instead of expanding the client Remote surface.
- **Serialized mutations.** Every account and grant change runs through one promise chain, so two concurrent registrations cannot both observe an empty directory or mint the same username.
- **Guardrails at the mutation.** Username shape, password length, duplicate usernames, unknown roles, and the last-administrator rule fail inside the operation itself, so a Host route and an in-process caller meet the same refusal.
- **One secret per home.** The signing secret lives in the credentials store under `account-directory/session`, minted on first load; a stored record this build cannot read fails the plugin load instead of silently invalidating every session.
- **Authority-bound cookies.** A token signs the request authority alongside the account and expiry, so a cookie minted for one local authority is rejected by another.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [identity group map](../README.md) — the sibling packages and group scope.
- [dsh-api-remote-access](../../api/remote-access/README.md) — the policy registry, bindings, and invalidation this package feeds.
- [dsh-storage-domain](../../storage/storage-domain/README.md) — the domain form that serves the account tables.
- [dsh-client-connection](../../client/connection/README.md) — the Connection identity seam and Peer admission.
- [dsh-ontology-injector](../../context/ontology-injector/README.md) — the first consumer of the ACL registry, mapping roles to ontology-domain actions.

-----

<a id="model-experience"></a>
## Model Experience

None, as the directory registers no prompt, tool, or request-context contribution and only decides who may call Remote actions.

#### KV Cache effect

None; authentication and authorization happen before a model request is assembled.

## Known Limitations and Deferred Work

- **Resource authorization covers declared kinds only** — grants and the administrator role feed the policy for any resource kind a package registers, but the shipped bundle contributes a rule only for `ontology-domain`; every other Remote surface remains owner-only for non-administrators, so a signed-in non-administrator account meets refusals in the client UI outside the ontology workbench.
- **Cookie authority is per `Host` header** — a deployment served under two different authorities needs a separate sign-in per authority.
- **No password reset by the account itself** — only an administrator can replace a password; there is no recovery flow.
- **No account audit trail** — mutations record `updatedAt` on the row but no history of who changed what.
- **SQLite comes from the bundle route** — the package declares the `account` domain and leaves the backend to the deployment's `storage-domain` route; a deployment without the route stores JSON.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and explicitly non-authoritative; shipped behavior lives in the sections above.

#### Open: external identity providers

The `connectionIdentity` seam admits exactly one session format today. An external provider (OIDC or LDAP) would need to produce the same `user` principal, decide how an external identity maps to a local account record, and reconcile deletions on the provider side with local grants.

#### Open: SPA sign-in surfaces

The `/auth/state` and `/login` pages are Host-rendered; the client administration workbench instead reads the `/admin/state` JSON route. Moving sign-in itself into the Web client would still require a surface distinct from the DeepSeek `account` namespace.

</details>
