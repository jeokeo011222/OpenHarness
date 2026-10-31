/**
 * Self-contained HTML for the login and administration pages. The pages speak
 * for the Host directly, so they carry no client bundle and no locale lookup.
 * Admin page now has three tabs (Users, Roles, Permissions), a per-page account
 * list, a role table, a grant board, and modal dialogs for create/edit/delete
 * plus per-user permission management. All interactions use inline vanilla JS.
 * @module @deepseek-ai/dsh-account-directory/src/pages
 */

import type { AccountSummary, GrantRecord, AccountResourceDictionary } from './types.ts'
import { ACCOUNT_ROLES } from './spec.ts'
import { escapeHtml } from './http.ts'

/** Theme preference accepted by the login and admin page renderers. */
export type ThemePreference = 'light' | 'dark' | 'system'

/** Resolve preference to a data-ds-dark-theme attribute value: 'true' | 'false' | null for system. */
function themeAttr(preference: ThemePreference | undefined): string | null {
  if (preference === 'dark') return 'true'
  if (preference === 'light') return 'false'
  return null
}

/** Per-page slice for the user-list tab. */
const PAGE_SIZE = 15
/** Resource roles shown in grant forms and dialogs. */
const RESOURCE_ROLES = ['owner', 'author', 'reviewer', 'publisher', 'viewer'] as const

/** Light-mode tokens mirroring ui-theme's non-data-ds-dark-theme values. */
const LIGHT_TOKENS = `
    --bg-base: rgb(255, 255, 255);
    --bg-layer-1: rgb(255, 255, 255);
    --bg-layer-2: rgb(249, 250, 251);
    --bg-input: rgb(249, 250, 251);
    --border: rgba(0, 0, 0, 0.10);
    --border-strong: rgba(0, 0, 0, 0.16);
    --text-primary: rgb(15, 17, 21);
    --text-secondary: rgb(97, 102, 107);
    --text-tertiary: rgb(129, 133, 140);
    --accent: rgb(65, 118, 230);
    --accent-hover: rgb(59, 130, 246);
    --danger: rgb(236, 19, 19);
    --danger-bg: rgba(236, 19, 19, 0.06);
    --danger-border: rgba(236, 19, 19, 0.30);
    --danger-badge-bg: rgba(236, 19, 19, 0.10);
    --row-hover: rgba(38, 49, 72, 0.06);
    --overlay: rgba(0, 0, 0, 0.45);
    --dialog-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
    --tab-hover: rgb(241, 243, 245);`

/** Dark-mode tokens mirroring ui-theme's data-ds-dark-theme values. */
const DARK_TOKENS = `
    --bg-base: rgb(21, 21, 23);
    --bg-layer-1: rgb(35, 35, 36);
    --bg-layer-2: rgb(44, 44, 46);
    --bg-input: rgba(255, 255, 255, 0.04);
    --border: rgba(255, 255, 255, 0.12);
    --border-strong: rgba(255, 255, 255, 0.20);
    --text-primary: rgb(249, 250, 251);
    --text-secondary: rgb(207, 211, 214);
    --text-tertiary: rgb(151, 157, 166);
    --accent: rgb(65, 118, 230);
    --accent-hover: rgb(122, 170, 255);
    --danger: rgb(242, 90, 90);
    --danger-bg: rgba(242, 90, 90, 0.14);
    --danger-border: rgba(242, 90, 90, 0.35);
    --danger-badge-bg: rgba(242, 90, 90, 0.18);
    --row-hover: rgba(255, 255, 255, 0.05);
    --overlay: rgba(0, 0, 0, 0.65);
    --dialog-shadow: 0 12px 32px rgba(0, 0, 0, 0.50);
    --tab-hover: rgb(55, 55, 58);`

const ADMIN_STYLE = `
  :root {
    color-scheme: light dark;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
${LIGHT_TOKENS}
  }
  @media (prefers-color-scheme: dark) {
    :root {${DARK_TOKENS}}
  }
  html[data-ds-dark-theme="true"] {
    color-scheme: dark;
    ${DARK_TOKENS}
  }
  html[data-ds-dark-theme="false"] {
    color-scheme: light;
    ${LIGHT_TOKENS}
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg-base); color: var(--text-primary); }
  main { max-width: 960px; margin: 0 auto; padding: 24px 32px 64px; display: flex; flex-direction: column; gap: 18px; }
  h1 { font-size: 22px; margin: 0; font-weight: 600; }
  h2 { font-size: 16px; margin: 0; font-weight: 600; }
  .sub { color: var(--text-secondary); margin: 4px 0 0; font-size: 14px; }
  .notice { padding: 10px 12px; border-radius: 8px; background: var(--danger-bg); color: var(--danger); font-size: 13px; border: 1px solid var(--danger-border); }
  .tabs { display: flex; gap: 4px; padding: 3px; align-self: flex-start; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-layer-2); }
  .tab { font: inherit; font-size: 13px; line-height: 20px; padding: 5px 14px; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); cursor: pointer; transition: background 150ms, color 150ms; }
  .tab:hover { color: var(--text-primary); background: var(--tab-hover); }
  .tab[aria-selected="true"] { background: var(--accent); color: #fff; font-weight: 500; box-shadow: 0 1px 2px rgba(0,0,0,0.12); }
  .card { background: var(--bg-layer-1); border: 1px solid var(--border); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .toolbar { display: flex; align-items: center; gap: 10px; }
  .toolbar .muted { color: var(--text-secondary); font-size: 13px; }
  .toolbar > .spacer { flex: 1; }
  .table-wrap { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--bg-layer-1); }
  .table-wrap table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { color: var(--text-secondary); font-weight: 500; font-size: 13px; }
  tbody tr:hover td { background: var(--row-hover); }
  tbody tr:last-child td { border-bottom: 0; }
  form.inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin: 0; }
  form.inline label { font-size: 12px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 4px; border: 0; padding: 0; }
  form.inline fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  .roles { display: flex; flex-wrap: wrap; gap: 8px; }
  /* Grant pickers: one kind dropdown with its typed fallback, and a checkbox
     list for the ids. A single submission may cover a batch of ids, so the id
     control is inherently multi-value. */
  .pick { display: inline-flex; flex-direction: column; gap: 4px; min-width: 0; }
  .pick > [hidden] { display: none !important; }
  form.inline .field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary); }
  .field-label { display: flex; align-items: center; gap: 6px; }
  .field-label .muted { font-size: 11px; }
  .idlist { display: flex; flex-direction: column; gap: 1px; max-height: 140px; overflow-y: auto; padding: 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-input); min-width: 220px; }
  .idlist .idrow { display: flex; flex-direction: row; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 4px; font-size: 13px; color: var(--text-primary); cursor: pointer; }
  .idlist .idrow:hover { background: var(--row-hover); }
  .idlist input[type=checkbox] { accent-color: var(--accent); margin: 0; }
  .idlist .mono { margin-left: auto; }
  .idempty { font-size: 12px; color: var(--text-secondary); margin: 0; }
  /* A dialog is narrow, so its grant form stacks instead of wrapping: a tall
     checkbox list beside a short dropdown reads as two unrelated columns. */
  .dialog form.inline { flex-direction: column; align-items: stretch; gap: 10px; }
  .dialog form.inline .field { width: 100%; }
  .dialog form.inline .idlist { min-width: 0; }
  .dialog form.inline .roles { gap: 10px; }
  label { font-size: 13px; color: var(--text-secondary); }
  input[type=text], input[type=password], select {
    background: var(--bg-input); color: var(--text-primary);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 9px; font-size: 13px; min-width: 120px; font-family: inherit;
    transition: border-color 150ms, box-shadow 150ms;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(65,118,230,0.20); }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; font-family: inherit; transition: background 150ms, transform 100ms; }
  button:hover { background: var(--accent-hover); }
  button:active { transform: translateY(1px); }
  button.secondary { background: var(--bg-layer-2); color: var(--text-primary); border: 1px solid var(--border); }
  button.secondary:hover { background: var(--border); }
  button.danger { background: transparent; color: var(--danger); border: 1px solid transparent; padding: 5px 10px; }
  button.danger:hover { background: var(--danger-bg); border-color: var(--danger-border); }
  button:disabled { opacity: 0.45; cursor: default; transform: none; }
  .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: var(--text-secondary); }
  .muted { color: var(--text-secondary); }
  .pagination { display: flex; align-items: center; gap: 8px; justify-content: center; font-size: 12px; color: var(--text-secondary); padding: 8px 12px; background: var(--bg-layer-2); border-top: 1px solid var(--border); }
  .pagination span { min-width: 100px; text-align: center; }
  .pagination button { padding: 4px 10px; font-size: 12px; border-radius: 5px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
  .overlay { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--overlay); backdrop-filter: blur(4px); }
  .dialog { width: 100%; max-width: 440px; max-height: calc(100vh - 48px); overflow-y: auto; padding: 22px; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--bg-layer-1); box-shadow: var(--dialog-shadow); }
  .dialog h2 { font-size: 16px; margin: 0 0 12px; font-weight: 600; }
  .dialog .actions { justify-content: flex-end; margin-top: 4px; }
  .dialog label { font-size: 13px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .dialog label.flat { flex-direction: row; align-items: center; gap: 6px; }
  .dialog input[type=checkbox] { accent-color: var(--accent); }
  .role-badge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 12px; background: var(--bg-layer-2); color: var(--text-secondary); border: 1px solid var(--border); }
  .role-badge.admin { background: var(--danger-badge-bg); border-color: var(--danger-border); color: var(--danger); }
  .empty { color: var(--text-secondary); font-size: 13px; padding: 12px 0; text-align: center; }
  .pane[hidden] { display: none; }
  fieldset { border: 0; padding: 0; margin: 0; }
  header { display: flex; flex-direction: column; gap: 4px; }
  header .header-actions { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  header .header-actions .divider { width: 1px; height: 16px; background: var(--border); }
`

function layout(title: string, body: string, preference: ThemePreference | undefined): string {
  const attr = themeAttr(preference)
  const htmlOpen = attr === null ? '<html lang="zh-CN">' : `<html lang="zh-CN" data-ds-dark-theme="${attr}">`
  return '<!doctype html>' + htmlOpen + '<head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${escapeHtml(title)} — DeepSeek Harness</title><style>${ADMIN_STYLE}</style></head>`
    + `<body><main>${body}</main></body></html>`
}

const LOGIN_STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #f5f6f8;
    --card: rgba(255, 255, 255, 0.88);
    --line: rgba(0, 0, 0, 0.08);
    --line-strong: rgba(0, 0, 0, 0.14);
    --ink: #0f1115;
    --ink-muted: #61666b;
    --ink-faint: #81858c;
    --accent: #4176e6;
    --accent-bright: #3b82f6;
    --violet: #7c3aed;
    --field: #ffffff;
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #151517;
      --card: rgba(30, 30, 34, 0.72);
      --line: rgba(255, 255, 255, 0.08);
      --line-strong: rgba(255, 255, 255, 0.14);
      --ink: #f2f3f5;
      --ink-muted: #a0a6b1;
      --ink-faint: #6f7480;
      --accent: #4176e6;
      --accent-bright: #7aaaff;
      --violet: #7c3aed;
      --field: rgba(255, 255, 255, 0.04);
    }
  }
  html[data-ds-dark-theme="true"] {
    color-scheme: dark;
    --bg: #151517;
    --card: rgba(30, 30, 34, 0.72);
    --line: rgba(255, 255, 255, 0.08);
    --line-strong: rgba(255, 255, 255, 0.14);
    --ink: #f2f3f5;
    --ink-muted: #a0a6b1;
    --ink-faint: #6f7480;
    --accent: #4176e6;
    --accent-bright: #7aaaff;
    --violet: #7c3aed;
    --field: rgba(255, 255, 255, 0.04);
  }
  html[data-ds-dark-theme="false"] {
    color-scheme: light;
    --bg: #f5f6f8;
    --card: rgba(255, 255, 255, 0.88);
    --line: rgba(0, 0, 0, 0.08);
    --line-strong: rgba(0, 0, 0, 0.14);
    --ink: #0f1115;
    --ink-muted: #61666b;
    --ink-faint: #81858c;
    --accent: #4176e6;
    --accent-bright: #3b82f6;
    --violet: #7c3aed;
    --field: #ffffff;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    padding: 24px 16px;
    position: relative;
    overflow-x: hidden;
  }
  html[data-ds-dark-theme="false"] body {
    background: linear-gradient(135deg, #eef2ff 0%, #f5f6f8 40%, #faf5ff 100%);
  }
  html[data-ds-dark-theme="true"] .glow-a,
  html:not([data-ds-dark-theme="false"]) .glow-a,
  @media (prefers-color-scheme: dark) { .glow-a { display: block; } }
  .glow { position: fixed; border-radius: 50%; filter: blur(90px); pointer-events: none; z-index: 0; }
  .glow-a { width: 560px; height: 560px; left: -120px; top: -160px; background: radial-gradient(circle, rgba(65, 118, 230, 0.30), transparent 70%); }
  .glow-b { width: 620px; height: 620px; right: -160px; bottom: -200px; background: radial-gradient(circle, rgba(124, 58, 237, 0.24), transparent 70%); }
  .glow-c { width: 420px; height: 420px; left: 50%; top: 30%; transform: translate(-50%, -50%); background: radial-gradient(circle, rgba(122, 170, 255, 0.10), transparent 70%); }
  html[data-ds-dark-theme="false"] .glow { opacity: 0.35; }
  main { position: relative; z-index: 1; width: min(400px, 100%); }
  .brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 22px; }
  .brand img { width: 30px; height: 30px; object-fit: contain; display: block; filter: drop-shadow(0 2px 10px rgba(65, 118, 230, 0.45)); }
  html[data-ds-dark-theme="false"] .brand img { filter: drop-shadow(0 2px 6px rgba(65, 118, 230, 0.20)); }
  .brand span { font-size: 15px; font-weight: 500; letter-spacing: 0.01em; color: var(--ink-muted); }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 20px;
    padding: 32px 30px 30px;
    backdrop-filter: blur(24px) saturate(1.4);
    -webkit-backdrop-filter: blur(24px) saturate(1.4);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.6);
  }
  html[data-ds-dark-theme="true"] .card,
  @media (prefers-color-scheme: dark) {
    .card { box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06); }
  }
  h1 { font-size: 21px; font-weight: 500; text-align: center; margin: 0 0 6px; letter-spacing: 0.01em; }
  .sub { font-size: 13.5px; color: var(--ink-faint); text-align: center; margin: 0 0 24px; line-height: 1.6; }
  .tabs { display: flex; gap: 4px; background: rgba(0, 0, 0, 0.04); border-radius: 11px; padding: 4px; margin-bottom: 22px; }
  html[data-ds-dark-theme="true"] .tabs,
  @media (prefers-color-scheme: dark) { .tabs { background: rgba(255, 255, 255, 0.05); } }
  .tab {
    flex: 1; height: 34px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-faint);
    font-size: 13.5px; font-weight: 500; cursor: pointer; transition: color 0.15s, background 0.15s;
  }
  .tab[aria-selected="true"] { background: rgba(0, 0, 0, 0.04); color: var(--ink); }
  html[data-ds-dark-theme="true"] .tab[aria-selected="true"],
  @media (prefers-color-scheme: dark) { .tab[aria-selected="true"] { background: rgba(255, 255, 255, 0.09); } }
  .tab:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 1px; }
  .pane[hidden] { display: none; }
  .notice {
    display: flex; align-items: flex-start; gap: 8px; margin: 0 0 18px; padding: 10px 12px;
    border-radius: 10px; background: rgba(245, 158, 11, 0.10); border: 1px solid rgba(245, 158, 11, 0.32);
    color: #d97706; font-size: 13.5px; line-height: 1.55;
  }
  html[data-ds-dark-theme="true"] .notice,
  @media (prefers-color-scheme: dark) { .notice { color: #fbbf24; } }
  .notice svg { flex: none; width: 15px; height: 15px; margin-top: 2.5px; }
  .field { margin-bottom: 16px; }
  label { display: block; font-size: 13px; font-weight: 500; color: var(--ink-muted); margin-bottom: 6px; }
  .control { position: relative; }
  .control > svg {
    position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
    width: 16px; height: 16px; color: var(--ink-faint); pointer-events: none; transition: color 0.15s;
  }
  .control:focus-within > svg { color: var(--accent-bright); }
  input[type="text"], input[type="password"] {
    width: 100%; height: 46px; background: var(--field); color: var(--ink);
    border: 1px solid var(--line-strong); border-radius: 12px;
    padding: 0 44px 0 40px; font-size: 14.5px; font-family: inherit;
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  input[type="text"]::placeholder, input[type="password"]::placeholder { color: var(--ink-faint); }
  input[type="text"]:hover, input[type="password"]:hover { border-color: rgba(0, 0, 0, 0.22); }
  html[data-ds-dark-theme="true"] input[type="text"]:hover,
  html[data-ds-dark-theme="true"] input[type="password"]:hover,
  @media (prefers-color-scheme: dark) {
    input[type="text"]:hover, input[type="password"]:hover { border-color: rgba(255, 255, 255, 0.22); }
  }
  input[type="text"]:focus, input[type="password"]:focus {
    outline: none; border-color: var(--accent); background: rgba(65, 118, 230, 0.04);
    box-shadow: 0 0 0 3px rgba(65, 118, 230, 0.22);
  }
  input:-webkit-autofill {
    -webkit-text-fill-color: var(--ink);
    -webkit-box-shadow: 0 0 0 1000px #fff inset;
    transition: background-color 99999s ease-in-out 0s;
  }
  html[data-ds-dark-theme="true"] input:-webkit-autofill,
  @media (prefers-color-scheme: dark) { -webkit-box-shadow: 0 0 0 1000px #232327 inset; }
  .reveal {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;
    background: transparent; border: 0; border-radius: 8px; color: var(--ink-faint); cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }
  .reveal:hover { color: var(--ink-muted); background: rgba(0, 0, 0, 0.04); }
  html[data-ds-dark-theme="true"] .reveal:hover,
  @media (prefers-color-scheme: dark) { .reveal:hover { background: rgba(255, 255, 255, 0.06); } }
  .reveal:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 1px; }
  .submit {
    width: 100%; height: 46px; margin-top: 4px; border: 0; border-radius: 12px;
    background: linear-gradient(135deg, var(--accent), var(--violet));
    color: #fff; font-size: 15px; font-weight: 500; letter-spacing: 0.06em; font-family: inherit;
    cursor: pointer; transition: filter 0.15s, transform 0.15s, box-shadow 0.15s;
  }
  .submit:hover { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 8px 24px rgba(65, 118, 230, 0.28); }
  html[data-ds-dark-theme="true"] .submit:hover,
  @media (prefers-color-scheme: dark) { .submit:hover { filter: brightness(1.12); box-shadow: 0 8px 24px rgba(65, 118, 230, 0.35); } }
  .submit:active { transform: translateY(0); filter: brightness(0.98); }
  .submit:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 2px; }
  @media (max-width: 480px) {
    body { padding: 16px 12px; }
    .card { padding: 26px 20px 24px; border-radius: 16px; }
  }
  .dev-hint { margin: 14px 0 0; font-size: 12.5px; color: var(--ink-faint); text-align: center; }
  .dev-hint code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--ink-muted);
    background: rgba(0, 0, 0, 0.04); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px;
  }
  html[data-ds-dark-theme="true"] .dev-hint code,
  @media (prefers-color-scheme: dark) { background: rgba(255, 255, 255, 0.06); }
  .dev-hint a { color: var(--accent); text-decoration: none; }
  .dev-hint a:hover { text-decoration: underline; }
  @media (prefers-reduced-motion: reduce) {
    .tab, .control > svg, input[type="text"], input[type="password"], .reveal, .submit { transition: none; }
  }
`

const LOGIN_SCRIPT = `
  document.addEventListener('click', function (event) {
    var reveal = event.target.closest('.reveal');
    if (reveal !== null) {
      var input = reveal.parentElement.querySelector('input');
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      reveal.setAttribute('aria-pressed', String(show));
      reveal.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      reveal.querySelector('.eye-open').style.display = show ? 'none' : '';
      reveal.querySelector('.eye-closed').style.display = show ? '' : 'none';
      return;
    }
    var tab = event.target.closest('.tab');
    if (tab !== null) {
      for (var other of tab.parentElement.querySelectorAll('.tab')) other.setAttribute('aria-selected', String(other === tab));
      document.getElementById('pane-login').hidden = tab.dataset.pane !== 'login';
      document.getElementById('pane-register').hidden = tab.dataset.pane !== 'register';
    }
  });
`

/** Inline stroke glyphs used by the login page's fields, toggles, and notice. */
const ICON_EYE_OPEN = '<svg class="eye-open" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
const ICON_EYE_CLOSED = '<svg class="eye-closed" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:none"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.5 17.5 0 0 1-2.2 3.1"/><path d="M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.5 0 2.9-.4 4.1-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'
const ICON_USER = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>'
const ICON_LOCK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'
const ICON_BADGE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h5"/></svg>'
const ICON_WARN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4"/><path d="M12 17.5v.1"/></svg>'

function loginField(id: string, label: string, icon: string, input: string): string {
  return `<div class="field"><label for="${id}">${label}</label><div class="control">${icon}${input}</div></div>`
}

/**
 * Render the login page.
 * @param message - Failure or status text shown above the forms.
 * @param canRegister - Whether self-registration is currently accepted.
 * @param devHint - Development-only credentials prefilled into the login form and displayed under its button.
 * @param preference - App appearance preference; 'system' follows OS, 'light'/'dark' forces that scheme.
 * @returns the complete HTML document.
 */
export function loginPage(
  message: string | undefined,
  canRegister: boolean,
  devHint?: { username: string; password: string },
  preference?: ThemePreference,
): string {
  const notice = message === undefined ? '' : `<p class="notice" role="alert">${ICON_WARN}${escapeHtml(message)}</p>`
  const usernameValue = devHint === undefined ? '' : ` value="${escapeHtml(devHint.username)}"`
  const passwordValue = devHint === undefined ? '' : ` value="${escapeHtml(devHint.password)}"`
  const devHintNote = devHint === undefined
    ? ''
    : `<p class="dev-hint">开发测试账号：<code>${escapeHtml(devHint.username)}</code> / <code>${escapeHtml(devHint.password)}</code>（已自动填充） · <a href="/admin">管理控制台</a></p>`
  const tabs = canRegister
    ? `<div class="tabs" role="tablist">
        <button type="button" class="tab" data-pane="login" aria-selected="true">登录</button>
        <button type="button" class="tab" data-pane="register" aria-selected="false">注册</button>
      </div>`
    : ''
  const registerPane = canRegister
    ? `<div class="pane" id="pane-register" hidden>
        <form method="post" action="/auth/register">
          ${loginField('register-username', '用户名', ICON_USER, '<input id="register-username" type="text" name="username" required autocomplete="username" placeholder="用于登录的用户名">')}
          ${loginField('register-display-name', '显示名', ICON_BADGE, '<input id="register-display-name" type="text" name="displayName" placeholder="可留空，默认同用户名">')}
          ${loginField('register-password', '密码', ICON_LOCK, `<input id="register-password" type="password" name="password" required autocomplete="new-password" placeholder="设置密码">
            <button type="button" class="reveal" aria-label="显示密码" aria-pressed="false">${ICON_EYE_OPEN}${ICON_EYE_CLOSED}</button>`)}
          <button type="submit" class="submit">创建账号</button>
        </form>
      </div>`
    : ''
  const attr = themeAttr(preference)
  const htmlOpen = attr === null ? '<html lang="zh-CN">' : `<html lang="zh-CN" data-ds-dark-theme="${attr}">`
  return `<!doctype html>${htmlOpen}<head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>登录 — Ontology OpenHarness</title><style>${LOGIN_STYLE}</style></head>`
    + '<body><div class="glow glow-a" aria-hidden="true"></div><div class="glow glow-b" aria-hidden="true"></div>'
    + '<div class="glow glow-c" aria-hidden="true"></div>'
    + '<main><header class="brand"><img src="/logo.png" alt="" onerror="this.remove()"><span>Ontology OpenHarness</span></header>'
    + '<section class="card">'
    + `<h1>欢迎回来</h1><p class="sub">使用企业账号登录，继续你的工作</p>${notice}${tabs}`
    + `<div class="pane" id="pane-login">
        <form method="post" action="/auth/login">
          ${loginField('login-username', '用户名', ICON_USER, `<input id="login-username" type="text" name="username" required autocomplete="username" placeholder="用户名"${usernameValue}>`)}
          ${loginField('login-password', '密码', ICON_LOCK, `<input id="login-password" type="password" name="password" required autocomplete="current-password" placeholder="密码"${passwordValue}>
            <button type="button" class="reveal" aria-label="显示密码" aria-pressed="false">${ICON_EYE_OPEN}${ICON_EYE_CLOSED}</button>`)}
          <button type="submit" class="submit">登 录</button>
        </form>
        ${devHintNote}
      </div>`
    + registerPane
    + (canRegister ? '<noscript><style>.tabs{display:none}.pane[hidden]{display:block}#pane-register{margin-top:22px;border-top:1px solid var(--line);padding-top:20px}</style></noscript>' : '')
    + '</section></main>'
    + `<script>${LOGIN_SCRIPT}</script></body></html>`
}

/**
 * Three-tab admin panel. All mutations still POST to the existing server routes
 * but the page now uses vanilla JS to swap tabs, paginate accounts, and open
 * permission-management dialogs without a full-page reload.
 * @param me - Signed-in administrator.
 * @param users - Every account.
 * @param grants - Every stored grant.
 * @param message - Failure or status text.
 * @param preference - App appearance preference; 'system' follows OS, 'light'/'dark' forces that scheme.
 * @param dictionary - Resource kinds and ids the grant forms suggest; the page works without it.
 * @returns the complete HTML document.
 */
export function adminPage(
  me: AccountSummary,
  users: readonly AccountSummary[],
  grants: readonly GrantRecord[],
  message: string | undefined,
  preference?: ThemePreference,
  dictionary?: AccountResourceDictionary,
): string {
  const notice = message === undefined ? '' : `<p class="notice">${escapeHtml(message)}</p>`
  // Grant forms pick from the same dictionary the workbench uses, as real
  // dropdowns rather than free text: an operator should not have to remember
  // that a kind is spelled "ontology-domain". "自定义…" keeps the door open for
  // a resource no provider registered yet, which is what the old text field was
  // good for.
  const kinds = dictionary?.kinds ?? []
  const resources = dictionary?.resources ?? {}
  const customOption = '<option value="__custom__">自定义…</option>'
  const kindOptions = kinds
    .map(entry => `<option value="${escapeHtml(entry.kind)}">${escapeHtml(entry.label)}（${entry.count}）</option>`)
    .join('')

  /**
   * Render the kind dropdown and the id picker.
   *
   * The kind keeps its typed fallback: two controls share the name and only the
   * enabled one submits. The ids are checkboxes on purpose — granting the same
   * roles on several resources is one decision, not one submission per id — with
   * a text field beside them for ids the dictionary cannot enumerate.
   * @param kindValue - Kind the id list should start from.
   * @param idValues - Ids to keep checked, e.g. editing a legacy grant.
   * @returns The two labelled fields.
   */
  const grantFields = (kindValue: string, idValues: readonly string[] = []): string => {
    const entries = resources[kindValue] ?? []
    const known = new Set(entries.map(entry => entry.id))
    // An id that is granted but no longer listed stays visible, so a stale grant
    // remains checkable instead of silently disappearing from the form.
    const rows = [
      ...entries.map(entry => ({ id: entry.id, label: entry.label ?? entry.id })),
      ...idValues.filter(id => id !== '' && !known.has(id)).map(id => ({ id, label: id })),
    ]
    const list = rows.length === 0
      ? ''
      : `<div class="idlist" data-pick-list="id">${rows.map(row => `
              <label class="idrow"><input type="checkbox" name="resourceId" value="${escapeHtml(row.id)}"${idValues.includes(row.id) ? ' checked' : ''}><span>${escapeHtml(row.label)}</span>${row.label === row.id ? '' : `<span class="mono">${escapeHtml(row.id)}</span>`}</label>`).join('')}
            </div>`
    const empty = rows.length === 0
      ? '<p class="idempty" data-pick-empty="id">该资源类型还没有可选的 ID，直接在下面输入。</p>'
      : ''
    return `<div class="field">
          <span class="field-label">资源类型</span>
          <span class="pick">
            <select name="resourceKind" data-pick="kind" required>${kindOptions}${customOption}</select>
            <input type="text" name="resourceKind" data-pick-text="kind" placeholder="输入资源类型" disabled hidden>
          </span>
        </div>
        <div class="field">
          <span class="field-label">资源 ID <span class="muted">可多选</span></span>
          <span class="pick">
            ${list}${empty}
            <input type="text" name="resourceIdText" data-pick-text="id" placeholder="或输入 ID，多个用逗号分隔">
          </span>
        </div>`
  }
  const defaultKind = kinds[0]?.kind ?? ''

  // --- User-list tab (HTML table with pagination done in JS) ---
  const userRows = users.map((user) => {
    const isAdmin = user.roles.includes('admin')
    const grantCount = grants.filter(g => g.userId === user.id).length
    return `<tr data-user-id="${escapeHtml(user.id)}">
      <td>${escapeHtml(user.username)}${isAdmin ? '<span class="role-badge admin" style="margin-left:6px">admin</span>' : ''}</td>
      <td>${escapeHtml(user.displayName || '')}</td>
      <td>${isAdmin ? '是' : '<span class="muted">否</span>'}</td>
      <td>
        <div class="actions">
          <button type="button" class="secondary" data-action="permissions" data-user-id="${escapeHtml(user.id)}">权限${grantCount > 0 ? ` (${grantCount})` : ''}</button>
          <button type="button" class="secondary" data-action="edit" data-user-id="${escapeHtml(user.id)}">编辑</button>
          <button type="button" class="danger" data-action="delete" data-user-id="${escapeHtml(user.id)}">删除</button>
        </div>
      </td>
    </tr>`
  }).join('')

  // --- Roles tab: global "admin" + every resource role from ACCOUNT_ROLES ---
  const roleRows: string[] = []
  const adminHolders = users.filter(u => u.roles.includes('admin')).length
  roleRows.push(`<tr>
      <td><span class="role-badge admin">admin</span></td>
      <td>全局</td>
      <td>${adminHolders} 账号拥有</td>
    </tr>`)
  for (const role of ACCOUNT_ROLES) {
    const holderCount = new Set(grants.filter(g => g.roles.includes(role)).map(g => g.userId)).size
    const grantInstances = grants.filter(g => g.roles.includes(role)).length
    const holderCountText = holderCount > 0
      ? `${holderCount} 账号持有（${grantInstances} 条授权）`
      : '<span class="muted">暂无</span>'
    roleRows.push(`<tr>
      <td><span class="role-badge">${escapeHtml(role)}</span></td>
      <td>资源</td>
      <td>${holderCountText}</td>
    </tr>`)
  }

  // --- Permissions tab (grant form + grant table) ---
  const grantRows = grants.length === 0
    ? '<tr><td colspan="4" class="empty">暂无授权记录</td></tr>'
    : grants.map((grant) => {
      const owner = users.find(user => user.id === grant.userId)
      return `<tr>
        <td>${escapeHtml(owner?.username ?? grant.userId)}</td>
        <td>${escapeHtml(grant.resourceKind)}</td>
        <td class="mono">${escapeHtml(grant.resourceId)}</td>
        <td>${grant.roles.map(r => `<span class="role-badge">${escapeHtml(r)}</span>`).join(' ')}</td>
        <td>
          <form method="post" action="/admin/grant/delete">
            <input type="hidden" name="userId" value="${escapeHtml(grant.userId)}">
            <input type="hidden" name="resourceKind" value="${escapeHtml(grant.resourceKind)}">
            <input type="hidden" name="resourceId" value="${escapeHtml(grant.resourceId)}">
            <button type="submit" class="danger">撤销</button>
          </form>
        </td>
      </tr>`
    }).join('')
  const userOptions = users
    .map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.username)}</option>`)
    .join('')
  const roleCheckboxes = RESOURCE_ROLES
    .map(r => `<label class="flat"><input type="checkbox" name="roles" value="${r}"> ${escapeHtml(r)}</label>`)
    .join('')

  // --- Dialog templates (hidden in DOM, cloned when opened) ---
  const dialogCreate = `
    <div class="dialog" data-dialog="create">
      <h2>新建账号</h2>
      <form method="post" action="/admin/user/create">
        <label>用户名 <input type="text" name="username" required></label>
        <label>显示名 <input type="text" name="displayName"></label>
        <label>密码 <input type="password" name="password" required></label>
        <label class="flat"><input type="checkbox" name="admin" value="1"> 管理员</label>
        <div class="actions">
          <button type="button" class="secondary" data-close>取消</button>
          <button type="submit">创建</button>
        </div>
      </form>
    </div>`

  // --- Inline JS for tabs, pagination, dialogs (wrapped in try/catch so one failure doesn't break all) ---
  const script = `
  (function(){
    try {
    var PAGE=${PAGE_SIZE};
    var DIALOG_CREATE=${JSON.stringify(dialogCreate)};
    function $(sel,root){ return (root||document).querySelector(sel); }
    function $$(sel,root){ return Array.from((root||document).querySelectorAll(sel)); }
    function swapTab(name){
      $$('.tab').forEach(function(t){ t.setAttribute('aria-selected', String(t.dataset.pane===name)); });
      $$('.pane').forEach(function(p){ p.hidden = p.id !== ('pane-'+name); });
      closeDialog();
    }
    function showDialog(html){
      closeDialog();
      var overlay = document.createElement('div');
      overlay.className='overlay';
      overlay.setAttribute('role','presentation');
      overlay.innerHTML = html;
      overlay.addEventListener('click', function(e){ if(e.target===overlay) closeDialog(); });
      document.body.appendChild(overlay);
      overlay.querySelectorAll('[data-close]').forEach(function(b){ b.addEventListener('click', closeDialog); });
      overlay.querySelectorAll('[data-confirm-delete]').forEach(function(b){ b.addEventListener('click', function(){
        if(confirm('删除该账号并撤销其全部授权？')){
          b.closest('form').submit();
        }
      }); });
      wireGrantForm(overlay);
    }
    function closeDialog(){ var existing = $('.overlay'); if(existing) existing.remove(); }
    // --- Grant forms: one kind dropdown, any number of resource ids ---
    var CUSTOM = '__custom__';
    function wireGrantForm(root){
      $$('[data-grant-form]', root).forEach(function(form){
        var kindSelect = form.querySelector('select[name="resourceKind"]');
        var kindText = form.querySelector('input[data-pick-text="kind"]');
        if(!kindSelect || !kindText) return;
        var idList = form.querySelector('[data-pick-list="id"]');
        var idEmpty = form.querySelector('[data-pick-empty="id"]');
        // Exactly one kind control is enabled, so the form submits one value.
        function use(select, text, custom){
          select.disabled = custom;
          select.hidden = custom;
          text.disabled = !custom;
          text.hidden = !custom;
          text.required = custom;
          if(custom){ text.value = ''; try { text.focus(); } catch (e) {} }
        }
        function fromSelect(select, text){ use(select, text, select.value === CUSTOM); }
        // Rebuild the checkbox list for one kind. Rows are built as elements
        // rather than innerHTML strings: an id comes from a provider and must
        // never be able to inject markup.
        function fillIds(kind){
          if(!idList) return;
          var entries = RESOURCE_INDEX[kind] || [];
          while(idList.firstChild) idList.removeChild(idList.firstChild);
          entries.forEach(function(entry){
            var row = document.createElement('label');
            row.className = 'idrow';
            var box = document.createElement('input');
            box.type = 'checkbox';
            box.name = 'resourceId';
            box.value = entry.id;
            var name = document.createElement('span');
            name.textContent = entry.label || entry.id;
            row.appendChild(box);
            row.appendChild(name);
            if(entry.label && entry.label !== entry.id){
              var code = document.createElement('span');
              code.className = 'mono';
              code.textContent = entry.id;
              row.appendChild(code);
            }
            idList.appendChild(row);
          });
          idList.hidden = entries.length === 0;
          if(idEmpty) idEmpty.hidden = entries.length !== 0;
        }
        kindSelect.addEventListener('change', function(){
          fromSelect(kindSelect, kindText);
          // A typed kind cannot be enumerated, so the list empties instead of
          // leaving the previous kind's ids checkable under a different kind.
          fillIds(kindSelect.value === CUSTOM ? '' : kindSelect.value);
        });
        fromSelect(kindSelect, kindText);
        fillIds(kindSelect.value === CUSTOM ? '' : kindSelect.value);
      });
    }
    function findUser(id){ return users.find(function(u){ return u.id === id; }) || users.find(function(u){ return u.username === id; }); }
    // --- Tab wiring ---
    $$('.tab').forEach(function(t){ t.addEventListener('click', function(){ swapTab(t.dataset.pane); }); });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeDialog(); });
    // --- Pagination wiring ---
    $$('[data-pagination]').forEach(function(p){
      var rows = p.querySelectorAll('tbody tr');
      var total = rows.length;
      var totalPages = Math.max(1, Math.ceil(total/PAGE));
      var page = 1;
      var infoEl = p.querySelector('[data-page-info]');
      var prevBtn = p.querySelector('[data-prev]');
      var nextBtn = p.querySelector('[data-next]');
      function render(){
        rows.forEach(function(r,i){ r.hidden = i < (page-1)*PAGE || i >= page*PAGE; });
        if(infoEl) infoEl.textContent = '第 '+page+' / '+totalPages+' 页';
        if(prevBtn) prevBtn.disabled = page<=1;
        if(nextBtn) nextBtn.disabled = page>=totalPages;
      }
      if(prevBtn) prevBtn.addEventListener('click', function(){ if(page>1){ page--; render(); } });
      if(nextBtn) nextBtn.addEventListener('click', function(){ if(page<totalPages){ page++; render(); } });
      render();
    });
    // --- Dialog wiring from user row buttons ---
    $$('[data-action]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = btn.dataset.userId;
        var user = findUser(id);
        if(!user) return;
        if(btn.dataset.action==='permissions'){
          var grants = allGrants.filter(function(g){ return g.userId === id; });
          var grantRowsHtml = grants.length===0
            ? '<tr><td colspan="4" class="empty">该用户暂无资源授权</td></tr>'
            : grants.map(function(g){
                return '<tr>' +
                  '<td>' + g.resourceKind + '</td>' +
                  '<td class="mono">' + g.resourceId + '</td>' +
                  '<td>' + g.roles.map(function(r){return '<span class="role-badge">'+r+'</span>'}).join(' ') + '</td>' +
                  '<td><form method="post" action="/admin/grant/delete">' +
                    '<input type="hidden" name="userId" value="'+user.id+'">' +
                    '<input type="hidden" name="resourceKind" value="'+g.resourceKind+'">' +
                    '<input type="hidden" name="resourceId" value="'+g.resourceId+'">' +
                    '<button type="submit" class="danger">撤销</button></form></td></tr>';
              }).join('');
          showDialog(
            '<div class="dialog">' +
              '<h2>权限 — ' + user.username + '</h2>' +
              '<p class="sub">' + (user.roles.includes('admin') ? '全局管理员' : '普通用户') + '</p>' +
              '<table><thead><tr><th>资源类型</th><th>资源 ID</th><th>角色</th><th></th></tr></thead><tbody>' + grantRowsHtml + '</tbody></table>' +
              '<h2 style="margin-top:16px">新增授权</h2>' +
              '<form class="inline" method="post" action="/admin/grant/set" data-grant-form>' +
                '<input type="hidden" name="userId" value="'+user.id+'">' +
                GRANT_FIELDS +
                '<fieldset><span class="muted">角色</span><div class="roles">' +
                  RESOURCE_ROLES.map(function(r){return '<label class="flat"><input type="checkbox" name="roles" value="'+r+'"> '+r+'</label>';}).join('') +
                '</div></fieldset>' +
                '<button type="submit">授予</button>' +
              '</form>' +
              '<div class="actions" style="margin-top:8px"><button type="button" class="secondary" data-close>关闭</button></div>' +
            '</div>'
          );
        } else if(btn.dataset.action==='edit'){
          showDialog(
            '<div class="dialog">' +
              '<h2>编辑 — ' + user.username + '</h2>' +
              '<form method="post" action="/admin/user/update">' +
                '<input type="hidden" name="userId" value="'+user.id+'">' +
                '<label>用户名 <input type="text" value="'+user.username+'" disabled></label>' +
                '<label>显示名 <input type="text" name="displayName" value="'+(user.displayName||'')+'"></label>' +
                '<label>密码 <input type="password" name="password" placeholder="留空则不修改"></label>' +
                '<label class="flat"><input type="checkbox" name="admin" value="1"' + (user.roles.includes('admin')?' checked':'') + '> 管理员</label>' +
                '<div class="actions"><button type="button" class="secondary" data-close>取消</button><button type="submit">保存</button></div>' +
              '</form></div>'
          );
        } else if(btn.dataset.action==='delete'){
          showDialog(
            '<div class="dialog">' +
              '<h2>删除 — ' + user.username + '</h2>' +
              '<p class="sub">该账号的全部授权将一并撤销。</p>' +
              '<form method="post" action="/admin/user/delete">' +
                '<input type="hidden" name="userId" value="'+user.id+'">' +
                '<div class="actions"><button type="button" class="secondary" data-close>取消</button><button type="submit" class="danger">确认删除</button></div>' +
              '</form></div>'
          );
        }
      });
    });
    // --- Create-account dialog ---
    // Wired here rather than in a second inline script: showDialog lives in this
    // closure, so a handler defined outside it would throw on click and leave
    // the button looking dead.
    var createButton = $('[data-open-create]');
    if(createButton) createButton.addEventListener('click', function(){ showDialog(DIALOG_CREATE); });

    wireGrantForm(document);
    } catch (err) { console.error('[admin] init error:', err); }
  })();
  `

  return layout('账号管理', `
    <header>
      <h1>账号管理</h1>
      <p class="sub">当前管理员：${escapeHtml(me.username)}</p>
      ${notice}
      <div class="header-actions">
        <form method="post" action="/auth/logout"><button type="submit" class="secondary">退出登录</button></form>
      </div>
    </header>

    <nav class="tabs" role="tablist">
      <button type="button" class="tab" data-pane="users" aria-selected="true">账号</button>
      <button type="button" class="tab" data-pane="roles" aria-selected="false">角色</button>
      <button type="button" class="tab" data-pane="permissions" aria-selected="false">权限</button>
    </nav>

    <!-- Users tab -->
    <section class="pane" id="pane-users">
      <div class="card">
        <div class="toolbar">
          <h2>账号</h2>
          <span class="muted">共 ${users.length} 个</span>
          <span class="spacer"></span>
          <button type="button" data-open-create>新建账号</button>
        </div>
        <div class="table-wrap" data-pagination>
          <table>
            <thead><tr>
              <th>账号</th><th>显示名</th><th>管理员</th><th></th>
            </tr></thead>
            <tbody>${userRows}</tbody>
          </table>
          <div class="pagination">
            <button type="button" class="secondary" data-prev disabled>上一页</button>
            <span data-page-info></span>
            <button type="button" class="secondary" data-next>下一页</button>
          </div>
        </div>
      </div>
    </section>

    <!-- Roles tab -->
    <section class="pane" id="pane-roles" hidden>
      <div class="card">
        <div class="toolbar">
          <h2>角色</h2>
          <span class="muted">共 ${ACCOUNT_ROLES.length} 种</span>
        </div>
        <table>
          <thead><tr><th>角色</th><th>范围</th><th>持有人</th></tr></thead>
          <tbody>${roleRows}</tbody>
        </table>
      </div>
    </section>

    <!-- Permissions tab -->
    <section class="pane" id="pane-permissions" hidden>
      <div class="card">
        <div class="toolbar">
          <h2>权限</h2>
          <span class="muted">共 ${grants.length} 条授权</span>
        </div>
        <form class="inline" method="post" action="/admin/grant/set" data-grant-form>
          <label>账号 <select name="userId" required>${userOptions}</select></label>
          ${grantFields(defaultKind, [])}
          <fieldset><span class="muted">角色</span><div class="roles">${roleCheckboxes}</div></fieldset>
          <button type="submit">授予</button>
        </form>
        <table>
          <thead><tr><th>账号</th><th>资源类型</th><th>资源 ID</th><th>角色</th><th></th></tr></thead>
          <tbody>${grantRows}</tbody>
        </table>
      </div>
    </section>

    <!-- Dialog source data, consumed by the inline JS above -->
    <script>
      var users = ${JSON.stringify(users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, roles: u.roles })))};
      var allGrants = ${JSON.stringify(grants)};
      var RESOURCE_ROLES = ${JSON.stringify([...RESOURCE_ROLES])};
      var RESOURCE_INDEX = ${JSON.stringify(resources)};
      var GRANT_FIELDS = ${JSON.stringify(grantFields(defaultKind, []))};
    </script>
    <script>${script}</script>
  `, preference)
}
