---
description: "Sidebar account launcher for the local account-directory session: settings entry, administrator user-management workbench entry, and sign-out."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-account

English | [中文](README.zh.md)

## Summary

The account launcher is the sidebar's local-session surface. One probe of the Host's `/auth/state` decides its label and entries: a signed-in account shows its display name and offers Settings, the administrator console, and sign-out; a signed-out browser shows a compact More row offering Settings only. The administrator console entry appears only when the probe reports the `admin` global role, and opens the `/admin` user-management workbench in a new tab.

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

Mount this plugin when the Web client should show the local account session and administrators should reach the user-management workbench. The client face contributes the `settings.launcher` component, and while the probe reports an admin session it also contributes the `admin` main panel (the workbench page) and the sidebar panel-list shield icon. Authentication itself lives in the Host's local account routes; this package only reads and acts on them.

The launcher probes `/auth/state` once per mount. The signed-in menu offers Settings (with the shell's configured shortcut), the admin console for `admin` sessions, and sign-out; the signed-out menu offers Settings only. Sign-out posts `auth/logout` and always lands on `/login`, including when the request fails.

The [admin workbench](#the-admin-workbench) renders at `/admin` for sessions the Host authorizes as admin. It lists accounts and grants, and every mutation posts a urlencoded form to the Host's admin routes.

### The admin workbench

The workbench reads `/admin/state` and renders two cards. The accounts card lists every local account with a display-name field, an administrator checkbox, an optional new-password field, and save and delete actions; a create-account form sits above the table. The grants card lists the workspace and session grants with a revoke action per row, and a set-grant form selects one account, one resource, and the role set that replaces the resource's previous grant.

| Route | Action |
|---|---|
| `admin/user/create` | Create an account from username, display name, password, and the administrator flag |
| `admin/user/update` | Save one account's display name, administrator flag, and optional password reset |
| `admin/user/delete` | Delete one account |
| `admin/grant/set` | Replace one resource's grant roles for one account |
| `admin/grant/delete` | Revoke one grant row |

Grant forms offer the account roles the Host defines: `owner`, `author`, `reviewer`, `publisher`, and `viewer`. Incomplete submissions stay on the page: the create form refuses empty usernames or passwords, and the grant form refuses missing accounts, resources, or roles. A refused POST shows a localized error notice and keeps every field for retry.

### Access

The launcher and workbench render only what the session may use. The admin entry follows the `/auth/state` answer, and `/admin/state` answers the workbench read with the Host's own authorization decision; an unauthorized read renders the forbidden state. The [account-directory](../../identity/account-directory/README.md) and [remote-access](../../api/remote-access/README.md) packages own those decisions.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the plugin; the observable behavior is covered in [Use this package](#use-this-package).

The package has no Host face: `apply()` is a deliberate no-op, and the client speaks to the Host's account routes directly. `dsh.client.inject` names the locale service and the slot surfaces it contributes, so composition order does not affect the probe.

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Client face: locale dictionaries, launcher registration, and the admin panel and sidebar icon contributions |
| [`src/client/AccountMenu.tsx`](src/client/AccountMenu.tsx) | The launcher: probe, menu entries, and sign-out |
| [`src/client/AdminWorkbench.tsx`](src/client/AdminWorkbench.tsx) | The `/admin` page: state read, account rows, and grant forms |
| [`src/client/local-admin.ts`](src/client/local-admin.ts) | Typed fetch helpers and fail-closed response guards |
| [`src/client/AdminIcon.tsx`](src/client/AdminIcon.tsx), [`src/client/LogoutIcon.tsx`](src/client/LogoutIcon.tsx) | Sidebar and menu glyphs |
| [`src/client/locales.ts`](src/client/locales.ts) | The eight-locale dictionary |
| [`src/index.ts`](src/index.ts) | Host entry; intentionally empty |

### Session probe and guards

The probe runs once per mount with a `live` flag, so an answer arriving after unmount updates nothing. Every response passes a narrow type guard before it reaches state: an unexpected body leaves the launcher in its signed-out shape or the workbench in its forbidden state rather than trusting partial data. Form submissions are urlencoded posts whose responses only decide success, so no Host payload is ever rendered verbatim.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level reference is not enough.

- [Account directory](../../identity/account-directory/README.md) — local accounts, roles, password storage, and the Host auth routes.
- [Remote access policy](../../api/remote-access/README.md) — how the Host decides which sessions may use it.
- [Architecture](../../../docs/architecture.md) — plugin seams and the Host/Client split.

-----

<a id="model-experience"></a>
## Model Experience

None, as the launcher and workbench never reach a model request: their state comes from Host routes, and their actions write nothing model-visible.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Sign-out is best-effort navigation** — a failed logout still moves the browser to `/login`, so the cookie's survival is not reported by the launcher.
- **The workbench trusts the Host's authorization** — the page gates its rendering on the `/admin/state` answer but enforces nothing beyond it; every mutation is decided by the Host routes.
- **Grant resources are fixed** — the set-grant form covers `workspace` and `session` resources with the account roles above; other resource kinds need a Host-side extension first.
- **No self-service profile editing** — accounts change their own display name or password only through an administrator's row, and the workbench never shows credentials.

<a id="dev-note"></a>
### Dev Note

Behavior tests live in `tests/` and stub `fetch` and navigation; they render the launcher and workbench in jsdom and exercise the fetch helpers in Node. Run them with `pnpm exec vitest run packages/client/ui-settings-account/tests`.
