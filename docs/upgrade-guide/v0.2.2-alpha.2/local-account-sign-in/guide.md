---
kind: upgrade-guide
description: "Browser access to the Host requires a signed-in local account, the DeepSeek platform sign-in UI is removed, and admins manage accounts at /admin."
---
# Browser access requires local account sign-in

English | [中文](guide.zh.md)

## Change

Every browser request to the Host now requires a signed-in local account. The Host frontend gate (packages/host/frontend-static) redirects unauthenticated requests to `/login`, which the new account-directory package (packages/identity/account-directory) serves and backs with a SQLite account store. Automation that calls Host endpoints without a session receives the redirect instead of data.

The DeepSeek platform sign-in UI is removed from packages/client/ui-settings-account: the sign-in dialog, desktop onboarding flow, bonus/credit notice, account avatar and section, and platform quota notice. The account menu now offers local sign-in, sign-out, and settings; the quota notice fallback copy is unchanged and still owned by ui-chat. Model-provider credentials (packages/credentials/deepseek-account) and the DeepSeek API-key model configuration flows remain in place; only the platform account login UI is gone.

Admin accounts get a user-management workbench: a left-sidebar panel and the `/admin` page, backed by `GET /admin/state`, which returns `{ account, accounts, grants }`; non-admin accounts receive 403 there. Remote-access policies gained an `unrestricted(principal)` predicate, and account-directory marks admin accounts unrestricted, so admins pass every action check.

## Migration

1. Open the Host in a browser and register at `/login`. The first account registered becomes the administrator; create further accounts from `/admin` or leave self-registration open.
2. Set account-directory config in cordis.yml: `allowRegistration: false` closes self-registration once administrators exist (default `true`). In the current deployment, `devHint` seeds the login form with username `admin` and password `dsh-admin-2026`; treat it as deployment config, not a product default, and change it before shared use.
3. Sign in automation before requests and carry the session cookie; unauthenticated requests no longer return data.
4. Confirm the migration: a signed-in admin opens `/admin` and sees the accounts and grants cards; a non-admin account receives 403 there; DeepSeek account credentials and API-key model configuration still work from settings.
