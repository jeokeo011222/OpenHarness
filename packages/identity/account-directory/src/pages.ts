/**
 * Self-contained HTML for the login and administration pages. The pages speak
 * for the Host directly, so they carry no client bundle and no locale lookup.
 * @module @deepseek-ai/dsh-account-directory/src/pages
 */

import type { AccountSummary, GrantRecord } from './types.ts'
import { ACCOUNT_ROLES } from './spec.ts'
import { escapeHtml } from './http.ts'

const STYLE = `
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { margin: 0; background: #111318; color: #e6e8ee; }
  main { max-width: 920px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 32px 0 8px; }
  .sub { color: #9aa3b2; margin: 0 0 24px; font-size: 14px; }
  .card { background: #1a1d24; border: 1px solid #2a2f3a; border-radius: 10px; padding: 18px; margin: 12px 0; }
  form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0; }
  label { font-size: 13px; color: #9aa3b2; }
  input[type=text], input[type=password] { background: #12141a; color: inherit; border: 1px solid #2a2f3a; border-radius: 6px; padding: 7px 9px; font-size: 14px; min-width: 160px; }
  button { background: #3b6ef5; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font-size: 14px; cursor: pointer; }
  button.danger { background: #b3261e; }
  .msg { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; background: #3a2417; color: #ffc8a2; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #262a33; vertical-align: top; }
  th { color: #9aa3b2; font-weight: 500; font-size: 13px; }
  .roles { display: flex; gap: 10px; flex-wrap: wrap; font-size: 13px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: #9aa3b2; }
`

function layout(title: string, body: string): string {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${escapeHtml(title)} — DeepSeek Harness</title><style>${STYLE}</style></head>`
    + `<body><main>${body}</main></body></html>`
}

const LOGIN_STYLE = `
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
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
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
  .glow { position: fixed; border-radius: 50%; filter: blur(90px); pointer-events: none; z-index: 0; }
  .glow-a { width: 560px; height: 560px; left: -120px; top: -160px; background: radial-gradient(circle, rgba(65, 118, 230, 0.30), transparent 70%); }
  .glow-b { width: 620px; height: 620px; right: -160px; bottom: -200px; background: radial-gradient(circle, rgba(124, 58, 237, 0.24), transparent 70%); }
  .glow-c { width: 420px; height: 420px; left: 50%; top: 30%; transform: translate(-50%, -50%); background: radial-gradient(circle, rgba(122, 170, 255, 0.10), transparent 70%); }
  main { position: relative; z-index: 1; width: min(400px, 100%); }
  .brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 22px; }
  .brand img { width: 30px; height: 30px; object-fit: contain; display: block; filter: drop-shadow(0 2px 10px rgba(65, 118, 230, 0.45)); }
  .brand span { font-size: 15px; font-weight: 500; letter-spacing: 0.01em; color: var(--ink-muted); }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 20px;
    padding: 32px 30px 30px;
    backdrop-filter: blur(24px) saturate(1.4);
    -webkit-backdrop-filter: blur(24px) saturate(1.4);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }
  h1 { font-size: 21px; font-weight: 500; text-align: center; margin: 0 0 6px; letter-spacing: 0.01em; }
  .sub { font-size: 13.5px; color: var(--ink-faint); text-align: center; margin: 0 0 24px; line-height: 1.6; }
  .tabs { display: flex; gap: 4px; background: rgba(255, 255, 255, 0.05); border-radius: 11px; padding: 4px; margin-bottom: 22px; }
  .tab {
    flex: 1; height: 34px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-faint);
    font-size: 13.5px; font-weight: 500; cursor: pointer; transition: color 0.15s, background 0.15s;
  }
  .tab[aria-selected="true"] { background: rgba(255, 255, 255, 0.09); color: var(--ink); }
  .tab:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 1px; }
  .pane[hidden] { display: none; }
  .notice {
    display: flex; align-items: flex-start; gap: 8px; margin: 0 0 18px; padding: 10px 12px;
    border-radius: 10px; background: rgba(245, 158, 11, 0.10); border: 1px solid rgba(245, 158, 11, 0.32);
    color: #fbbf24; font-size: 13.5px; line-height: 1.55;
  }
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
  input[type="text"]:hover, input[type="password"]:hover { border-color: rgba(255, 255, 255, 0.22); }
  input[type="text"]:focus, input[type="password"]:focus {
    outline: none; border-color: var(--accent); background: rgba(65, 118, 230, 0.06);
    box-shadow: 0 0 0 3px rgba(65, 118, 230, 0.22);
  }
  input:-webkit-autofill {
    -webkit-text-fill-color: var(--ink);
    -webkit-box-shadow: 0 0 0 1000px #232327 inset;
    transition: background-color 99999s ease-in-out 0s;
  }
  .reveal {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;
    background: transparent; border: 0; border-radius: 8px; color: var(--ink-faint); cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }
  .reveal:hover { color: var(--ink-muted); background: rgba(255, 255, 255, 0.06); }
  .reveal:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 1px; }
  .submit {
    width: 100%; height: 46px; margin-top: 4px; border: 0; border-radius: 12px;
    background: linear-gradient(135deg, var(--accent), var(--violet));
    color: #fff; font-size: 15px; font-weight: 500; letter-spacing: 0.06em; font-family: inherit;
    cursor: pointer; transition: filter 0.15s, transform 0.15s, box-shadow 0.15s;
  }
  .submit:hover { filter: brightness(1.12); transform: translateY(-1px); box-shadow: 0 8px 24px rgba(65, 118, 230, 0.35); }
  .submit:active { transform: translateY(0); filter: brightness(0.98); }
  .submit:focus-visible { outline: 2px solid var(--accent-bright); outline-offset: 2px; }
  @media (max-width: 480px) {
    body { padding: 16px 12px; }
    .card { padding: 26px 20px 24px; border-radius: 16px; }
  }
  .dev-hint { margin: 14px 0 0; font-size: 12.5px; color: var(--ink-faint); text-align: center; }
  .dev-hint code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--ink-muted);
    background: rgba(255, 255, 255, 0.06); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px;
  }
  .dev-hint a { color: var(--accent-bright); text-decoration: none; }
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
 * @returns the complete HTML document.
 */
export function loginPage(message: string | undefined, canRegister: boolean, devHint?: { username: string; password: string }): string {
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
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
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
 * Render the administration page.
 * @param me - Signed-in administrator.
 * @param users - Every account.
 * @param grants - Every stored grant.
 * @param message - Failure or status text.
 * @returns the complete HTML document.
 */
export function adminPage(
  me: AccountSummary,
  users: readonly AccountSummary[],
  grants: readonly GrantRecord[],
  message: string | undefined,
): string {
  const notice = message === undefined ? '' : `<p class="msg">${escapeHtml(message)}</p>`
  const userRows = users.map((user) => {
    const isAdmin = user.roles.includes('admin')
    return `<tr>
      <td>${escapeHtml(user.username)}<br><span class="mono">${escapeHtml(user.id)}</span></td>
      <td>
        <form method="post" action="/admin/user/update">
          <input type="hidden" name="userId" value="${escapeHtml(user.id)}">
          <input type="text" name="displayName" value="${escapeHtml(user.displayName)}" aria-label="显示名">
          <input type="password" name="password" placeholder="重置密码（可留空）" aria-label="新密码">
          <label><input type="checkbox" name="admin" value="1"${isAdmin ? ' checked' : ''}> 管理员</label>
          <button type="submit">保存</button>
        </form>
      </td>
      <td>
        <form method="post" action="/admin/user/delete" onsubmit="return confirm('删除该账号并撤销其全部授权？')">
          <input type="hidden" name="userId" value="${escapeHtml(user.id)}">
          <button type="submit" class="danger">删除</button>
        </form>
      </td>
    </tr>`
  }).join('')
  const grantRows = grants.length === 0
    ? '<tr><td colspan="4" class="mono">暂无授权</td></tr>'
    : grants.map((grant) => {
      const owner = users.find(user => user.id === grant.userId)
      return `<tr>
        <td>${escapeHtml(owner?.username ?? grant.userId)}</td>
        <td class="mono">${escapeHtml(grant.resourceKind)}<br>${escapeHtml(grant.resourceId)}</td>
        <td>${grant.roles.map(role => escapeHtml(role)).join(', ')}</td>
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
  const roleBoxes = ACCOUNT_ROLES
    .map(role => `<label><input type="checkbox" name="roles" value="${role}"> ${role}</label>`)
    .join('')
  return layout('账号管理', `
    <h1>账号管理</h1>
    <p class="sub">当前管理员：${escapeHtml(me.username)}</p>
    ${notice}
    <section class="card">
      <form method="post" action="/auth/logout"><button type="submit">退出登录</button></form>
    </section>
    <h2>新建账号</h2>
    <section class="card">
      <form method="post" action="/admin/user/create">
        <label>用户名</label><input type="text" name="username" required>
        <label>显示名</label><input type="text" name="displayName">
        <label>密码</label><input type="password" name="password" required>
        <label><input type="checkbox" name="admin" value="1"> 管理员</label>
        <button type="submit">创建</button>
      </form>
    </section>
    <h2>账号（${String(users.length)}）</h2>
    <section class="card">
      <table><thead><tr><th>账号</th><th>资料</th><th></th></tr></thead>
      <tbody>${userRows}</tbody></table>
    </section>
    <h2>资源授权</h2>
    <section class="card">
      <form method="post" action="/admin/grant/set">
        <label>账号</label><select name="userId">${userOptions}</select>
        <label>资源类型</label><input type="text" name="resourceKind" value="ontology-domain" required>
        <label>资源 ID</label><input type="text" name="resourceId" required placeholder="domain id">
        <span class="roles">${roleBoxes}</span>
        <button type="submit">授予</button>
      </form>
    </section>
    <section class="card">
      <table><thead><tr><th>账号</th><th>资源</th><th>角色</th><th></th></tr></thead>
      <tbody>${grantRows}</tbody></table>
    </section>`)
}
