/**
 * @deepseek-ai/dsh-account-directory — local enterprise accounts: signed
 * browser sessions, account and grant tables, the `user` principal kind, and a
 * Host-served login and administration surface. It owns the account domain
 * (SQLite from the bundle, JSON elsewhere), one Remote-access policy for the
 * `user` kind, and the Connection identity seam that admits signed sessions.
 * @module @deepseek-ai/dsh-account-directory
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RemoteAccessBinding, RemoteAccessPolicy } from '@deepseek-ai/dsh-api-remote-access'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ConnectionIdentity, ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { crossesOrigin, readForm, redirect, sendHtml, sendJson } from './http.ts'
import { adminPage, loginPage } from './pages.ts'
import { hashPassword, verifyPassword } from './password.ts'
import {
  LOGIN_PATH,
  decodeSessionToken,
  encodeSessionToken,
  loadSessionSecret,
  requestAuthority,
  sessionCookie,
  sessionCookieName,
  submittedCookie,
} from './session.ts'
import { accountDomainSpec, ACCOUNT_ROLES, grantKey, type GrantKey, type StoredGrant, type StoredUser } from './spec.ts'
import type { AccountAcl, AccountAclRule, AccountRole, AccountSummary, GrantRecord, GlobalRole, UserId } from './types.ts'

export type {
  AccountAcl,
  AccountAclRule,
  AccountRole,
  AccountSummary,
  GrantRecord,
  GlobalRole,
  UserId,
} from './types.ts'
export { ACCOUNT_ROLES } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Local enterprise accounts, grants, and the Connection identity they admit. */
    accountDirectory: AccountDirectory
  }
}

/** Plugin name. */
export const name = 'account-directory'

/** Services the directory needs: durable records, access policy, HTTP surface, and Peer admission. */
export const inject = ['credentials', 'storageDomain', 'remoteAccess', 'webServer', 'connection']

/** Account-directory configuration. */
export interface Config {
  /** Browser session lifetime in days. */
  readonly sessionDays?: number
  /** Whether accounts beyond the first may register themselves. */
  readonly allowRegistration?: boolean
  /** Minimum password length in characters. */
  readonly minPasswordLength?: number
  /** Development-only credentials prefilled into the login form and displayed under its button; unset outside development. */
  readonly devHint?: { readonly username: string; readonly password: string }
}

/** Account-directory configuration schema. */
export const Config: z<Config> = z.object({
  sessionDays: z.natural().min(1).default(30),
  allowRegistration: z.boolean().default(true),
  minPasswordLength: z.natural().min(6).default(8),
  devHint: z.object({ username: z.string().min(1), password: z.string().min(1) }).default(undefined as never),
})

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/u
const DAY_MS = 86_400_000

/** Name one requested account change the directory cannot apply. */
export class AccountDirectoryError extends Error {
  /**
   * @param code - stable reason a caller maps to its own message.
   * @param message - operator-facing detail.
   */
  constructor(readonly code: AccountDirectoryErrorCode, message: string) {
    super(message)
    this.name = 'AccountDirectoryError'
  }
}

/** Stable refusal reasons of the account directory. */
export type AccountDirectoryErrorCode =
  | 'invalid-username'
  | 'duplicate-username'
  | 'password-too-short'
  | 'registration-closed'
  | 'not-found'
  | 'last-admin'
  | 'invalid-role'

function accountSummary(id: UserId, record: StoredUser): AccountSummary {
  return {
    id,
    username: record.username,
    displayName: record.displayName,
    roles: record.roles,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase()
}

/** Local enterprise account directory behind `ctx.accountDirectory`. */
export class AccountDirectory extends Service {
  static inject = inject

  static Config = Config

  /** Registry business packages contribute their grant rules to. */
  readonly acl: AccountAcl

  private readonly settings: Required<Omit<Config, 'devHint'>> & { readonly devHint?: Config['devHint'] | undefined }
  private readonly users = new Map<UserId, StoredUser>()
  private readonly usernames = new Map<string, UserId>()
  private readonly grants = new Map<GrantKey, StoredGrant>()
  private readonly grantsByUser = new Map<UserId, Set<GrantKey>>()
  private readonly rules = new Map<string, AccountAclRule>()
  private readonly baselines = new Set<(userId: UserId) => readonly RemoteAccessBinding[]>()
  private readonly peers = new Map<UserId, PeerScope>()
  private readonly identity: ConnectionIdentity
  private secret?: Buffer
  private usersTable?: KvTable<UserId, StoredUser>
  private grantsTable?: KvTable<GrantKey, StoredGrant>
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * Wire the ACL registry and the Connection identity seam.
   * @param ctx - plugin context; every registration is disposed with it.
   * @param config - session lifetime and registration policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'accountDirectory')
    const resolved = config as Required<Omit<Config, 'devHint'>> & { readonly devHint?: Config['devHint'] | undefined }
    this.settings = {
      sessionDays: resolved.sessionDays,
      allowRegistration: resolved.allowRegistration,
      minPasswordLength: resolved.minPasswordLength,
      devHint: resolved.devHint,
    }
    this.acl = {
      register: rule => this.registerRule(rule),
      registerBaseline: bindings => this.registerBaseline(bindings),
    }
    this.identity = {
      loginPath: LOGIN_PATH,
      peerFor: request => this.peerFor(request),
    }
    ctx.effect(() => async () => {
      const peers = Array.from(this.peers.values())
      this.peers.clear()
      await Promise.all(peers.map(peer => peer.dispose()))
    }, 'account-directory: account Peers')
  }

  /** Open the account domain, load its records, and publish the policy and HTTP surface. */
  protected async [Service.init](): Promise<void> {
    this.secret = await loadSessionSecret(this.ctx.credentials)
    const domain = await this.ctx.storageDomain.open(accountDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'account-directory: domain')
    this.usersTable = domain.table('users')
    this.grantsTable = domain.table('grants')
    for (const [id, record] of this.usersTable.entries()) {
      this.users.set(id, record)
      this.usernames.set(record.username, id)
    }
    for (const [key, record] of this.grantsTable.entries()) this.trackGrant(key, record)
    this.ctx.effect(() => this.ctx.remoteAccess.registerPolicy('user', this.policy()), 'account-directory: user policy')
    this.ctx.provide('connectionIdentity', this.identity)
    this.ctx.effect(() => this.registerRoutes(), 'account-directory: routes')
  }

  /**
   * Accounts in username order, without password verifiers.
   * @returns every stored account summary.
   */
  listAccounts(): readonly AccountSummary[] {
    return Array.from(this.users.entries(), ([id, record]) => accountSummary(id, record))
      .sort((left, right) => left.username.localeCompare(right.username))
  }

  /**
   * Find one account.
   * @param userId - account identity.
   * @returns the account summary, or `undefined` when it does not exist.
   */
  account(userId: UserId): AccountSummary | undefined {
    const record = this.users.get(userId)
    return record === undefined ? undefined : accountSummary(userId, record)
  }

  /**
   * Every stored grant, in account and resource order.
   * @returns all grant records.
   */
  listGrants(): readonly GrantRecord[] {
    return Array.from(this.grants.values())
      .sort((left, right) => left.userId.localeCompare(right.userId)
        || left.resourceKind.localeCompare(right.resourceKind)
        || left.resourceId.localeCompare(right.resourceId))
  }

  /**
   * The account a request's session cookie names.
   * @param request - request carrying the account cookie.
   * @returns the account, or `undefined` when the cookie is absent, foreign, or expired.
   */
  sessionAccount(request: ConnectionTrustRequest): AccountSummary | undefined {
    const session = this.sessionOf(request)
    return session === undefined ? undefined : this.account(session.userId)
  }

  /**
   * Register one account; the first account becomes the administrator.
   * @param input - username, optional display name, and password.
   * @returns the created account.
   * @throws AccountDirectoryError when registration is closed or the input is invalid.
   */
  async register(input: { username: string; displayName?: string; password: string }): Promise<AccountSummary> {
    return this.enqueue(async () => {
      if (this.users.size > 0 && !this.settings.allowRegistration) {
        throw new AccountDirectoryError('registration-closed', 'self-registration is closed')
      }
      const username = normalizeUsername(input.username)
      this.assertUsername(username)
      if (this.usernames.has(username)) throw this.duplicateUsername(username)
      this.assertPassword(input.password)
      const record = await this.buildRecord({
        username,
        displayName: input.displayName ?? username,
        password: input.password,
        roles: this.users.size === 0 ? ['admin'] : [],
      })
      return this.insertAccount(record)
    })
  }

  /**
   * Verify one username and password.
   * @param username - submitted username.
   * @param password - submitted password.
   * @returns the matching account, or `undefined` when either is wrong.
   */
  async authenticate(username: string, password: string): Promise<AccountSummary | undefined> {
    const id = this.usernames.get(normalizeUsername(username))
    const record = id === undefined ? undefined : this.users.get(id)
    if (id === undefined || record === undefined) return undefined
    return await verifyPassword(password, record.password) ? accountSummary(id, record) : undefined
  }

  /**
   * Create one account from the administrative surface.
   * @param input - username, optional display name, password, and administrator flag.
   * @returns the created account.
   * @throws AccountDirectoryError when the username is taken or the password is short.
   */
  async createAccount(input: {
    username: string
    displayName?: string
    password: string
    admin: boolean
  }): Promise<AccountSummary> {
    return this.enqueue(async () => {
      const username = normalizeUsername(input.username)
      this.assertUsername(username)
      if (this.usernames.has(username)) throw this.duplicateUsername(username)
      this.assertPassword(input.password)
      return this.insertAccount(await this.buildRecord({
        username,
        displayName: input.displayName ?? username,
        password: input.password,
        roles: input.admin ? ['admin'] : [],
      }))
    })
  }

  /**
   * Change one account's display name, administrator flag, or password.
   * @param userId - account identity.
   * @param patch - fields to replace; `password` mints a new verifier.
   * @returns the updated account.
   * @throws AccountDirectoryError when the account is missing or the last administrator would be demoted.
   */
  async updateAccount(
    userId: UserId,
    patch: { displayName?: string; admin?: boolean; password?: string },
  ): Promise<AccountSummary> {
    return this.enqueue(async () => {
      const record = this.users.get(userId)
      if (record === undefined) throw this.notFound(userId)
      if (patch.password !== undefined) this.assertPassword(patch.password)
      const roles: GlobalRole[] = patch.admin === undefined
        ? [...record.roles]
        : patch.admin ? ['admin'] : []
      if (record.roles.includes('admin') && !roles.includes('admin') && this.adminCount() === 1) {
        throw new AccountDirectoryError('last-admin', 'the last administrator cannot lose that role')
      }
      const next: StoredUser = {
        ...record,
        displayName: patch.displayName?.trim() || record.displayName,
        roles,
        password: patch.password === undefined ? record.password : await hashPassword(patch.password),
        updatedAt: new Date().toISOString(),
      }
      await this.requireUsersTable().put(userId, next)
      this.users.set(userId, next)
      return accountSummary(userId, next)
    })
  }

  /**
   * Delete one account and every grant it holds.
   * @param userId - account identity.
   * @throws AccountDirectoryError when the account is missing or is the last administrator.
   */
  async deleteAccount(userId: UserId): Promise<void> {
    return this.enqueue(async () => {
      const record = this.users.get(userId)
      if (record === undefined) throw this.notFound(userId)
      if (record.roles.includes('admin') && this.adminCount() === 1) {
        throw new AccountDirectoryError('last-admin', 'the last administrator cannot be deleted')
      }
      for (const key of Array.from(this.grantsByUser.get(userId) ?? [])) await this.revokeGrantKey(key)
      await this.requireUsersTable().delete(userId)
      this.users.delete(userId)
      this.usernames.delete(record.username)
      this.grantsByUser.delete(userId)
      const peer = this.peers.get(userId)
      this.peers.delete(userId)
      if (peer !== undefined) await peer.dispose()
      this.invalidate(userId)
    })
  }

  /**
   * Grant one account roles on one resource, replacing its previous roles there.
   * @param input - account, resource kind and id, and the role set.
   * @returns the stored grant.
   * @throws AccountDirectoryError when the account or a role is unknown.
   */
  async setGrant(input: {
    userId: UserId
    resourceKind: string
    resourceId: string
    roles: readonly string[]
  }): Promise<GrantRecord> {
    return this.enqueue(async () => {
      if (!this.users.has(input.userId)) throw this.notFound(input.userId)
      const roles = this.normalizeRoles(input.roles)
      if (input.resourceKind.trim() === '' || input.resourceId.trim() === '') {
        throw new AccountDirectoryError('not-found', 'a grant needs a resource kind and id')
      }
      const key = grantKey(input.userId, input.resourceKind, input.resourceId)
      const record: StoredGrant = {
        userId: input.userId,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        roles,
        updatedAt: new Date().toISOString(),
      }
      await this.requireGrantsTable().put(key, record)
      this.trackGrant(key, record)
      this.invalidate(input.userId)
      return record
    })
  }

  /**
   * Revoke one account's grant on one resource.
   * @param input - account and resource identity.
   */
  async revokeGrant(input: { userId: UserId; resourceKind: string; resourceId: string }): Promise<void> {
    return this.enqueue(() => this.revokeGrantKey(grantKey(input.userId, input.resourceKind, input.resourceId)))
  }

  /**
   * Build the `Set-Cookie` value admitting one account session.
   * @param userId - account to admit.
   * @param authority - cookie audience of the request.
   * @param secure - whether the Host serves HTTPS.
   * @returns the cookie value.
   */
  sessionCookieFor(userId: UserId, authority: string, secure: boolean): string {
    const expiresAt = Date.now() + this.settings.sessionDays * DAY_MS
    const secret = this.requireSecret()
    const token = encodeSessionToken(userId, authority, expiresAt, secret)
    return sessionCookie(authority, token, expiresAt, this.settings.sessionDays * 86_400, secure)
  }

  /**
   * Build the `Set-Cookie` value clearing one account session.
   * @param authority - cookie audience of the request.
   * @param secure - whether the Host serves HTTPS.
   * @returns the cookie value.
   */
  clearedSessionCookie(authority: string, secure: boolean): string {
    return sessionCookie(authority, '', Date.now(), 0, secure)
  }

  /**
   * Cookie audience of one request.
   * @param request - request headers.
   * @param secure - whether the Host serves HTTPS.
   * @returns the audience, or `undefined` when the request names no host.
   */
  authority(request: ConnectionTrustRequest, secure: boolean): string | undefined {
    return requestAuthority(request.headers, secure)
  }

  /** Whether the Host serves HTTPS, which decides `Secure` cookies. */
  get secure(): boolean {
    return this.ctx.webServer.protocol === 'https:'
  }

  private policy(): RemoteAccessPolicy<{ readonly kind: 'user'; readonly userId: UserId }> {
    return {
      unrestricted: principal => this.users.get(principal.userId)?.roles.includes('admin') === true,
      bindings: principal => this.bindingsFor(principal.userId),
      explain: request => this.users.has(request.principal.userId)
        ? `${request.action} is not granted to this account`
        : undefined,
    }
  }

  private bindingsFor(userId: UserId): readonly RemoteAccessBinding[] {
    const account = this.users.get(userId)
    if (account === undefined) return []
    const bindings: RemoteAccessBinding[] = []
    for (const baseline of this.baselines) bindings.push(...baseline(userId))
    const keys = this.grantsByUser.get(userId) ?? []
    const grants = Array.from(keys, key => this.grants.get(key))
      .filter((grant): grant is StoredGrant => grant !== undefined)
    for (const grant of grants) {
      const rule = this.rules.get(grant.resourceKind)
      if (rule !== undefined) bindings.push(...rule.bind(grant.resourceId, grant.roles))
    }
    return bindings
  }

  private registerRule(rule: AccountAclRule): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.rules.has(rule.kind)) {
        throw new Error(`account-directory: ACL rule for kind ${JSON.stringify(rule.kind)} is already registered`)
      }
      this.rules.set(rule.kind, rule)
      this.invalidateAll()
      return () => {
        this.rules.delete(rule.kind)
        this.invalidateAll()
      }
    }, `account-directory: ACL rule ${rule.kind}`)
    return () => { void dispose() }
  }

  private registerBaseline(bindings: (userId: UserId) => readonly RemoteAccessBinding[]): () => void {
    const dispose = this.ctx.effect(() => {
      this.baselines.add(bindings)
      this.invalidateAll()
      return () => {
        this.baselines.delete(bindings)
        this.invalidateAll()
      }
    }, 'account-directory: ACL baseline')
    return () => { void dispose() }
  }

  private invalidate(userId: UserId): void {
    this.ctx.remoteAccess.invalidate({ kind: 'user', userId })
  }

  private invalidateAll(): void {
    this.ctx.remoteAccess.invalidate()
  }

  private peerFor(request: ConnectionTrustRequest): PeerScope | undefined {
    const session = this.sessionOf(request)
    if (session === undefined) return undefined
    const cached = this.peers.get(session.userId)
    if (cached !== undefined) return cached
    const peer = this.ctx.connection.createPeer({ principal: { kind: 'user', userId: session.userId } })
    this.peers.set(session.userId, peer)
    return peer
  }

  private sessionOf(request: ConnectionTrustRequest): { userId: UserId } | undefined {
    if (this.secret === undefined) return undefined
    const secure = this.secure
    const authority = requestAuthority(request.headers, secure)
    if (authority === undefined) return undefined
    const token = submittedCookie(request, sessionCookieName(authority))
    if (token === undefined) return undefined
    const session = decodeSessionToken(token, authority, this.secret, Date.now())
    return session === undefined || !this.users.has(session.userId) ? undefined : session
  }

  private trackGrant(key: GrantKey, record: StoredGrant): void {
    this.grants.set(key, record)
    const keys = this.grantsByUser.get(record.userId)
    if (keys === undefined) this.grantsByUser.set(record.userId, new Set([key]))
    else keys.add(key)
  }

  private async revokeGrantKey(key: GrantKey): Promise<void> {
    const record = this.grants.get(key)
    this.grants.delete(key)
    await this.requireGrantsTable().delete(key)
    if (record === undefined) return
    const keys = this.grantsByUser.get(record.userId)
    keys?.delete(key)
    if (keys !== undefined && keys.size === 0) this.grantsByUser.delete(record.userId)
    this.invalidate(record.userId)
  }

  private async insertAccount(record: StoredUser): Promise<AccountSummary> {
    const id = brandString<UserId>(randomUUID())
    await this.requireUsersTable().put(id, record)
    this.users.set(id, record)
    this.usernames.set(record.username, id)
    return accountSummary(id, record)
  }

  private async buildRecord(input: {
    username: string
    displayName: string
    password: string
    roles: readonly GlobalRole[]
  }): Promise<StoredUser> {
    const now = new Date().toISOString()
    return {
      username: input.username,
      displayName: input.displayName.trim() || input.username,
      roles: [...input.roles],
      password: await hashPassword(input.password),
      createdAt: now,
      updatedAt: now,
    }
  }

  private assertUsername(username: string): void {
    if (!USERNAME_PATTERN.test(username)) {
      throw new AccountDirectoryError('invalid-username', 'username must be 2-64 lowercase letters, digits, dot, dash, or underscore')
    }
  }

  private assertPassword(password: string): void {
    if (password.length < this.settings.minPasswordLength) {
      throw new AccountDirectoryError('password-too-short', `password must be at least ${String(this.settings.minPasswordLength)} characters`)
    }
  }

  private normalizeRoles(roles: readonly string[]): AccountRole[] {
    const normalized: AccountRole[] = []
    for (const role of roles) {
      if (!ACCOUNT_ROLES.includes(role as AccountRole)) {
        throw new AccountDirectoryError('invalid-role', `unknown role ${JSON.stringify(role)}`)
      }
      if (normalized.includes(role as AccountRole)) continue
      normalized.push(role as AccountRole)
    }
    if (normalized.length === 0) throw new AccountDirectoryError('invalid-role', 'a grant needs at least one role')
    return normalized
  }

  private duplicateUsername(username: string): AccountDirectoryError {
    return new AccountDirectoryError('duplicate-username', `username ${JSON.stringify(username)} is taken`)
  }

  private notFound(userId: UserId): AccountDirectoryError {
    return new AccountDirectoryError('not-found', `account ${JSON.stringify(userId)} does not exist`)
  }

  private adminCount(): number {
    let count = 0
    for (const record of this.users.values()) if (record.roles.includes('admin')) count += 1
    return count
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job)
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  private requireSecret(): Buffer {
    if (this.secret === undefined) throw new Error('account-directory: session secret is not loaded')
    return this.secret
  }

  private requireUsersTable(): KvTable<UserId, StoredUser> {
    if (this.usersTable === undefined) throw new Error('account-directory: account domain is not open')
    return this.usersTable
  }

  private requireGrantsTable(): KvTable<GrantKey, StoredGrant> {
    if (this.grantsTable === undefined) throw new Error('account-directory: account domain is not open')
    return this.grantsTable
  }

  private registerRoutes(): () => void {
    const routes = [
      this.ctx.webServer.register({ kind: 'exact', path: LOGIN_PATH, handler: (req, res) => { this.serveLogin(req, res) } }),
      this.ctx.webServer.register({ kind: 'exact', path: '/admin', handler: (req, res) => { this.serveAdmin(req, res) } }),
      this.ctx.webServer.register({ kind: 'exact', path: '/admin/state', handler: (req, res) => { this.handleAdminState(req, res) } }),
      this.ctx.webServer.register({ kind: 'exact', path: '/auth/login', handler: (req, res) => { this.handleLogin(req, res) } }),
      this.ctx.webServer.register({ kind: 'exact', path: '/auth/register', handler: (req, res) => { this.handleRegister(req, res) } }),
      this.ctx.webServer.register({ kind: 'exact', path: '/auth/logout', handler: (req, res) => { this.handleLogout(req, res) } }),
      this.ctx.webServer.register({ kind: 'exact', path: '/auth/state', handler: (req, res) => { this.handleState(req, res) } }),
      this.ctx.webServer.register({ kind: 'exact', path: '/admin/user/create', handler: (req, res) => { this.handleUserCreate(req, res) } }),
      this.ctx.webServer.register({ kind: 'exact', path: '/admin/user/update', handler: (req, res) => { this.handleUserUpdate(req, res) } }),
      this.ctx.webServer.register({ kind: 'exact', path: '/admin/user/delete', handler: (req, res) => { this.handleUserDelete(req, res) } }),
      this.ctx.webServer.register({ kind: 'exact', path: '/admin/grant/set', handler: (req, res) => { this.handleGrantSet(req, res) } }),
      this.ctx.webServer.register({ kind: 'exact', path: '/admin/grant/delete', handler: (req, res) => { this.handleGrantDelete(req, res) } }),
    ]
    return () => { for (const dispose of routes) dispose() }
  }

  private serveLogin(req: IncomingMessage, res: ServerResponse): void {
    if (!this.isReadSafe(req)) { res.writeHead(405); res.end(); return }
    const url = new URL(req.url ?? '/', 'http://localhost')
    sendHtml(res, 200, loginPage(url.searchParams.get('message') ?? undefined, this.canRegister(), this.settings.devHint))
  }

  private serveAdmin(req: IncomingMessage, res: ServerResponse): void {
    if (!this.isReadSafe(req)) { res.writeHead(405); res.end(); return }
    const account = this.sessionAccount(req)
    if (account === undefined) { redirect(res, LOGIN_PATH); return }
    if (!account.roles.includes('admin')) { sendHtml(res, 403, loginPage('该账号不是管理员', false)); return }
    const url = new URL(req.url ?? '/', 'http://localhost')
    sendHtml(res, 200, adminPage(account, this.listAccounts(), this.listGrants(), url.searchParams.get('message') ?? undefined))
  }

  private handleLogin(req: IncomingMessage, res: ServerResponse): void {
    void this.submitPublic(req, res, async () => {
      const form = await readForm(req)
      const account = await this.authenticate(form.get('username') ?? '', form.get('password') ?? '')
      if (account === undefined) return loginPage('用户名或密码错误', this.canRegister(), this.settings.devHint)
      const authority = this.authority(req, this.secure)
      if (authority === undefined) return loginPage('无法解析请求地址', false)
      redirect(res, '/', [this.sessionCookieFor(account.id, authority, this.secure)])
      return undefined
    })
  }

  private handleRegister(req: IncomingMessage, res: ServerResponse): void {
    void this.submitPublic(req, res, async () => {
      const form = await readForm(req)
      const displayName = form.get('displayName')
      const account = await this.register({
        username: form.get('username') ?? '',
        password: form.get('password') ?? '',
        ...(displayName === null || displayName.trim() === '' ? {} : { displayName }),
      })
      const authority = this.authority(req, this.secure)
      if (authority === undefined) return loginPage('无法解析请求地址', false)
      redirect(res, '/', [this.sessionCookieFor(account.id, authority, this.secure)])
      return undefined
    })
  }

  private handleLogout(req: IncomingMessage, res: ServerResponse): void {
    void this.submitPublic(req, res, () => {
      const authority = this.authority(req, this.secure)
      redirect(res, LOGIN_PATH, authority === undefined ? [] : [this.clearedSessionCookie(authority, this.secure)])
      return Promise.resolve(undefined)
    })
  }

  private handleState(req: IncomingMessage, res: ServerResponse): void {
    if (!this.isReadSafe(req)) { res.writeHead(405); res.end(); return }
    const account = this.sessionAccount(req)
    if (account === undefined) { sendJson(res, 200, { signedIn: false }); return }
    sendJson(res, 200, {
      signedIn: true,
      account,
      grants: this.listGrants().filter(grant => grant.userId === account.id),
    })
  }

  /** JSON state for the client workbench: the caller's account plus every account and grant. */
  private handleAdminState(req: IncomingMessage, res: ServerResponse): void {
    if (!this.isReadSafe(req)) { res.writeHead(405); res.end(); return }
    const account = this.sessionAccount(req)
    if (account === undefined) { sendJson(res, 401, { error: 'sign-in required' }); return }
    if (!account.roles.includes('admin')) { sendJson(res, 403, { error: '该接口仅管理员可用' }); return }
    sendJson(res, 200, { account, accounts: this.listAccounts(), grants: this.listGrants() })
  }

  private handleUserCreate(req: IncomingMessage, res: ServerResponse): void {
    void this.submitAdmin(req, res, async () => {
      const form = await readForm(req)
      const displayName = form.get('displayName')
      await this.createAccount({
        username: form.get('username') ?? '',
        password: form.get('password') ?? '',
        admin: form.get('admin') === '1',
        ...(displayName === null || displayName.trim() === '' ? {} : { displayName }),
      })
      redirect(res, '/admin')
    })
  }

  private handleUserUpdate(req: IncomingMessage, res: ServerResponse): void {
    void this.submitAdmin(req, res, async () => {
      const form = await readForm(req)
      const password = form.get('password')
      const displayName = form.get('displayName')
      await this.updateAccount(brandString<UserId>(form.get('userId') ?? ''), {
        admin: form.get('admin') === '1',
        ...(displayName === null ? {} : { displayName }),
        ...(password === null || password === '' ? {} : { password }),
      })
      redirect(res, '/admin')
    })
  }

  private handleUserDelete(req: IncomingMessage, res: ServerResponse): void {
    void this.submitAdmin(req, res, async () => {
      const form = await readForm(req)
      await this.deleteAccount(brandString<UserId>(form.get('userId') ?? ''))
      redirect(res, '/admin')
    })
  }

  private handleGrantSet(req: IncomingMessage, res: ServerResponse): void {
    void this.submitAdmin(req, res, async () => {
      const form = await readForm(req)
      await this.setGrant({
        userId: brandString<UserId>(form.get('userId') ?? ''),
        resourceKind: form.get('resourceKind') ?? '',
        resourceId: form.get('resourceId') ?? '',
        roles: form.getAll('roles'),
      })
      redirect(res, '/admin')
    })
  }

  private handleGrantDelete(req: IncomingMessage, res: ServerResponse): void {
    void this.submitAdmin(req, res, async () => {
      const form = await readForm(req)
      await this.revokeGrant({
        userId: brandString<UserId>(form.get('userId') ?? ''),
        resourceKind: form.get('resourceKind') ?? '',
        resourceId: form.get('resourceId') ?? '',
      })
      redirect(res, '/admin')
    })
  }

  private async submitPublic(
    req: IncomingMessage,
    res: ServerResponse,
    action: () => Promise<string | undefined>,
  ): Promise<void> {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    if (crossesOrigin(req, this.secure)) { sendHtml(res, 403, loginPage('跨站请求被拒绝', false)); return }
    try {
      const page = await action()
      if (page !== undefined) sendHtml(res, 400, page)
    } catch (error) {
      sendHtml(res, 400, loginPage(error instanceof Error ? error.message : '操作失败', this.canRegister()))
    }
  }

  private async submitAdmin(
    req: IncomingMessage,
    res: ServerResponse,
    action: (account: AccountSummary) => Promise<void>,
  ): Promise<void> {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    if (crossesOrigin(req, this.secure)) { sendHtml(res, 403, loginPage('跨站请求被拒绝', false)); return }
    const account = this.sessionAccount(req)
    if (account === undefined) { redirect(res, LOGIN_PATH); return }
    if (!account.roles.includes('admin')) { sendHtml(res, 403, loginPage('该账号不是管理员', false)); return }
    try {
      await action(account)
    } catch (error) {
      const message = error instanceof Error ? error.message : '账号操作失败'
      sendHtml(res, 400, adminPage(account, this.listAccounts(), this.listGrants(), message))
    }
  }

  private isReadSafe(req: IncomingMessage): boolean {
    return req.method === 'GET' || req.method === 'HEAD'
  }

  private canRegister(): boolean {
    return this.users.size === 0 || this.settings.allowRegistration
  }
}

export default AccountDirectory
