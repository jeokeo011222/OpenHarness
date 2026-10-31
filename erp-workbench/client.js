/**
 * Web half of dsh-erp-workbench: the page that connects an ERP endpoint, edits
 * the action-to-API mapping, and tries one call.
 *
 * The ERP connector shipped as a library with no way in from the product: an
 * operator had to edit JSON and call a router from a script. This page is that
 * way in. It talks to the host half over `/plugins/erp-workbench/api`, which
 * owns the store and the adapter instances.
 */
window.__ModuleLoader__.load({
  id: 'dsh-erp-workbench',
  factory(require) {
    const React = require('react')
    const e = React.createElement

    const NS = 'erpWorkbench'
    /** Host route this plugin's workbench API answers on. */
    const API_BASE = '/plugins/erp-workbench/api'
    const PANEL_ID = 'erp-workbench'

    /** Families the page can configure, with the fields each one needs. */
    const FAMILIES = [
      { id: 'yonyou', label: '用友 U8', versions: ['v13', 'v15'] },
      { id: 'kingdee', label: '金蝶云星空', versions: [] },
    ]

    const zh = {
      'tab.title': 'ERP 接口',
      'tab.subtitle': '连接 ERP、编辑动作映射、试跑一次调用',
      'guide.title': 'ERP 接口',
      'guide.description': '配置用友 U8 或金蝶云星空的连接，并把本体动作映射到 ERP 接口。',
      'page.back': '返回对话',
      'action.refresh': '刷新',
      'action.save': '保存',
      'action.delete': '删除',
      'action.test': '连通性测试',
      'action.close': '关闭',
      'action.invoke': '调用',
      'action.newConnection': '新建连接',
      'action.loadExample': '载入示例映射',
      'action.validate': '校验并保存',
      'conn.title': '连接',
      'conn.empty': '还没有 ERP 连接。填写下面的表单保存一个，页面才能发起调用。',
      'conn.label': '显示名',
      'conn.family': 'ERP 类型',
      'conn.version': 'U8 版本',
      'conn.baseUrl': '接口地址',
      'conn.baseUrlHint': '用友：形如 https://u8.example.com；金蝶：形如 https://k3.example.com。',
      'conn.pathPrefix': '路径前缀（可选）',
      'conn.token': 'API Token',
      'conn.keepSecret': '已保存，留空不修改',
      'conn.appId': '应用 AppId',
      'conn.appSecret': '应用密钥',
      'conn.acctId': '账套 ID',
      'conn.testOk': '端点可达 · HTTP {status} · {ms} ms',
      'conn.testHint': '只探测端点是否可达，不触发任何 ERP 业务接口。',
      'conn.saved': '已保存连接：{id}',
      'map.title': '动作映射',
      'map.empty': '还没有映射：把映射编辑器导出的 JSON 粘贴到下面，或先载入示例。',
      'map.count': '{count} 个动作 · 版本 {version}',
      'map.hint': '映射决定动作调用哪个 ERP 接口，以及参数怎么改名和取值。保存前会按连接器的 schema 校验。',
      'map.invalid': '映射校验失败',
      'map.saved': '映射已保存',
      'invoke.title': '试跑调用',
      'invoke.needConnection': '先保存一个连接。',
      'invoke.needMapping': '先保存映射，才有可调用的动作。',
      'invoke.action': '动作',
      'invoke.params': '参数（JSON）',
      'invoke.paramsHint': '这里填动作侧的参数名，映射会把它改成 ERP 的字段名。',
      'invoke.request': '实际请求',
      'invoke.response': 'ERP 返回',
      'invoke.ok': '调用完成 · {ms} ms · {adapter}',
      'invoke.failed': '调用失败',
      'invoke.badParams': '参数不是合法的 JSON 对象。',
      'invoke.emptyParams': '这个动作没有参数，直接调用即可。',
      'state.loading': '加载中…',
      'state.loadError': '加载失败：{message}',
      'state.connectorMissing': 'ERP 连接器还没构建，页面无法发起调用。',
      'state.connectorMissingHint': '在仓库根目录执行：npm --prefix erp-connector run build，然后重启服务。',
      'state.store': '配置存放：{path}',
      'err.network': '无法连接 ERP 服务，请确认 Host 仍在运行。',
      'err.unauthorized': '登录状态已失效，请重新登录后再试。',
      'err.badResponse': 'ERP 服务返回了无法解析的内容。',
      'field.json': 'JSON 内容',
    }

    const en = {
      'tab.title': 'ERP interface',
      'tab.subtitle': 'Connect an ERP, edit the action mapping, try one call',
      'guide.title': 'ERP interface',
      'guide.description': 'Configure a Yonyou U8 or Kingdee Cloud Galaxy endpoint and map ontology actions to ERP APIs.',
      'page.back': 'Back to conversation',
      'action.refresh': 'Refresh',
      'action.save': 'Save',
      'action.delete': 'Delete',
      'action.test': 'Reachability test',
      'action.close': 'Close',
      'action.invoke': 'Call',
      'action.newConnection': 'New connection',
      'action.loadExample': 'Load example mapping',
      'action.validate': 'Validate and save',
      'conn.title': 'Connections',
      'conn.empty': 'No ERP connection yet. Save one below before calling anything.',
      'conn.label': 'Display name',
      'conn.family': 'ERP family',
      'conn.version': 'U8 version',
      'conn.baseUrl': 'Base URL',
      'conn.baseUrlHint': 'Yonyou: https://u8.example.com; Kingdee: https://k3.example.com.',
      'conn.pathPrefix': 'Path prefix (optional)',
      'conn.token': 'API token',
      'conn.keepSecret': 'Saved; leave blank to keep it',
      'conn.appId': 'App id',
      'conn.appSecret': 'App secret',
      'conn.acctId': 'Account database id',
      'conn.testOk': 'Endpoint reachable · HTTP {status} · {ms} ms',
      'conn.testHint': 'Only checks that the endpoint answers; no business API is called.',
      'conn.saved': 'Saved connection: {id}',
      'map.title': 'Action mapping',
      'map.empty': 'No mapping yet: paste the JSON the mapping editor exported below, or load the example first.',
      'map.count': '{count} actions · version {version}',
      'map.hint': 'The mapping decides which ERP API an action calls and how its parameters are renamed and transformed. It is validated with the connector schema before saving.',
      'map.invalid': 'The mapping was refused',
      'map.saved': 'Mapping saved',
      'invoke.title': 'Try a call',
      'invoke.needConnection': 'Save a connection first.',
      'invoke.needMapping': 'Save a mapping first; there is no action to call yet.',
      'invoke.action': 'Action',
      'invoke.params': 'Parameters (JSON)',
      'invoke.paramsHint': 'Use the action-side names; the mapping rewrites them into ERP field names.',
      'invoke.request': 'Actual request',
      'invoke.response': 'ERP response',
      'invoke.ok': 'Call finished · {ms} ms · {adapter}',
      'invoke.failed': 'The call failed',
      'invoke.badParams': 'The parameters are not a JSON object.',
      'invoke.emptyParams': 'This action takes no parameters; just call it.',
      'state.loading': 'Loading…',
      'state.loadError': 'Loading failed: {message}',
      'state.connectorMissing': 'The ERP connector is not built, so the page cannot call anything.',
      'state.connectorMissingHint': 'From the repository root run: npm --prefix erp-connector run build, then restart the server.',
      'state.store': 'Configuration: {path}',
      'err.network': 'Cannot reach the ERP service. Check that the Host is still running.',
      'err.unauthorized': 'The session expired. Sign in again.',
      'err.badResponse': 'The ERP service answered with something unreadable.',
      'field.json': 'JSON',
    }

    /**
     * Compose one workbench request.
     * @param path - Route below the API prefix.
     * @param init - Optional method and JSON body.
     * @param signal - Abort signal.
     * @returns `{ ok, value }` or `{ ok: false, error }`.
     */
    async function request(path, init = {}, signal) {
      const response = await fetch(API_BASE + path, {
        method: init.method ?? 'GET',
        headers: { 'content-type': 'application/json' },
        signal,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        return { ok: false, error: { code: 'bad_response', message: 'bad_response' } }
      }
      if (payload !== null && typeof payload === 'object' && payload.ok === true) {
        return { ok: true, value: payload.value }
      }
      const error = payload !== null && typeof payload === 'object' ? payload.error : undefined
      return { ok: false, error: error ?? { code: String(response.status), message: '' } }
    }

    /**
     * Word a failure for the reader.
     * @param t - Translator.
     * @param error - Failure from `request`.
     * @returns Readable message.
     */
    function errorText(t, error) {
      if (error === undefined || error === null) return t('err.badResponse')
      if (error.code === 'unauthorized') return t('err.unauthorized')
      if (error.code === 'bad_response') return t('err.badResponse')
      return typeof error.message === 'string' && error.message !== '' ? error.message : String(error.code ?? '')
    }

    /**
     * Parse a JSON textarea into an object.
     * @param text - Textarea contents.
     * @returns The parsed object, or undefined when it is not one.
     */
    function parseObject(text) {
      if (typeof text !== 'string' || text.trim() === '') return {}
      try {
        const value = JSON.parse(text)
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Label one action for the picker.
     * @param action - Action descriptor.
     * @returns `domain / action → api`.
     */
    function actionLabel(action) {
      return String(action.domain) + ' / ' + String(action.action) + ' → ' + String(action.api)
    }

    const styles = `
.erp-page { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); }
.erp-bar { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.erp-bar h3 { margin: 0; font-size: 13px; font-weight: 600; }
.erp-bar-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.erp-bar-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.erp-body { flex: 1 1 auto; overflow: auto; padding: 12px 14px 40px; display: flex; flex-direction: column; gap: 12px; max-width: 1040px; }
.erp-card { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-base); }
.erp-card-head { display: flex; align-items: center; gap: 8px; }
.erp-card-title { margin: 0; font-size: 12px; font-weight: 600; }
.erp-muted { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.erp-count { padding: 0 7px; font-size: 10px; line-height: 16px; border-radius: 999px; color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.erp-badge { padding: 1px 7px; font-size: 10px; border-radius: 999px; color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.erp-badge[data-bad='true'] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.erp-list { display: flex; flex-wrap: wrap; gap: 6px; }
.erp-pick { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 5px 9px; font: inherit; text-align: left; color: var(--dsw-alias-label-secondary); background: transparent; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; cursor: pointer; }
.erp-pick:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-state-business-primary); }
.erp-pick[data-active='true'] { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent); }
.erp-pick-name { font-size: 11px; }
.erp-pick-meta { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.erp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
.erp-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.erp-field > span { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.erp-input, .erp-select, .erp-area { min-width: 0; font: inherit; font-size: 11px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; }
.erp-input, .erp-select { height: 26px; padding: 0 7px; }
.erp-area { padding: 6px 7px; font-family: var(--dsw-font-family-mono, monospace); line-height: 1.5; resize: vertical; }
.erp-input:focus-visible, .erp-select:focus-visible, .erp-area:focus-visible { border-color: var(--dsw-alias-state-business-primary); outline: 1px solid var(--dsw-alias-state-business-primary); }
.erp-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.erp-button { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; font: inherit; font-size: 11px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; cursor: pointer; }
.erp-button:hover { border-color: var(--dsw-alias-state-business-primary); }
.erp-button:disabled { opacity: 0.5; cursor: default; }
.erp-button-primary { color: var(--dsw-alias-label-inverse, var(--dsw-alias-bg-base)); background: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }
.erp-button-danger { color: var(--dsw-alias-state-error-primary); }
.erp-note { margin: 0; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.erp-note-ok { color: var(--dsw-alias-state-success-primary); }
.erp-note-error { color: var(--dsw-alias-state-error-primary); }
.erp-warn { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); }
.erp-warn strong { font-size: 12px; }
.erp-warn code { font-family: var(--dsw-font-family-mono, monospace); font-size: 11px; }
.erp-result { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
.erp-pre { margin: 0; max-height: 240px; overflow: auto; padding: 8px; font-family: var(--dsw-font-family-mono, monospace); font-size: 10.5px; line-height: 1.5; background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.erp-empty { margin: 0; padding: 14px 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); text-align: center; }
`

    /**
     * Install the page stylesheet once per document.
     * @returns Nothing.
     */
    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-erp-workbench-styles') !== null) return
      const element = document.createElement('style')
      element.id = 'dsh-erp-workbench-styles'
      element.textContent = styles
      document.head.append(element)
    }

    /**
     * Blank connection form for one family.
     * @param family - Family id.
     * @returns Form values.
     */
    function blankConnection(family = 'yonyou') {
      return {
        id: '',
        label: '',
        family,
        version: family === 'yonyou' ? 'v13' : '',
        baseUrl: '',
        pathPrefix: '',
        token: '',
        appId: '',
        appSecret: '',
        acctId: '',
        hasToken: false,
        hasAppSecret: false,
      }
    }

    /**
     * Turn a stored connection into form values.
     * @param connection - Connection from the workbench state.
     * @returns Form values.
     */
    function formOf(connection) {
      return {
        ...blankConnection(connection.family),
        id: connection.id ?? '',
        label: connection.label ?? '',
        version: connection.version ?? (connection.family === 'yonyou' ? 'v13' : ''),
        baseUrl: connection.baseUrl ?? '',
        pathPrefix: connection.pathPrefix ?? '',
        appId: connection.appId ?? '',
        acctId: connection.acctId ?? '',
        hasToken: connection.hasToken === true,
        hasAppSecret: connection.hasAppSecret === true,
      }
    }

    /**
     * Compose the payload the host expects from the form.
     * @param form - Form values.
     * @returns Connection payload; blank secrets are omitted on purpose.
     */
    function connectionPayload(form) {
      const trim = value => String(value ?? '').trim()
      const payload = {
        id: form.id === '' ? 'erp_' + Date.now().toString(36) : form.id,
        label: trim(form.label),
        family: form.family,
        baseUrl: trim(form.baseUrl),
      }
      if (form.family === 'yonyou') {
        payload.version = form.version === 'v15' ? 'v15' : 'v13'
        if (trim(form.pathPrefix) !== '') payload.pathPrefix = trim(form.pathPrefix)
        if (form.token !== '') payload.token = form.token
      } else {
        if (trim(form.appId) !== '') payload.appId = trim(form.appId)
        if (trim(form.acctId) !== '') payload.acctId = trim(form.acctId)
        if (form.appSecret !== '') payload.appSecret = form.appSecret
      }
      return payload
    }

    /**
     * One connection row: its label, family, and endpoint.
     * @param props - Connection and click handler.
     * @returns Row element.
     */
    function ConnectionPick({ connection, active, onPick }) {
      return e('button', {
        type: 'button',
        className: 'erp-pick',
        'data-active': active ? 'true' : 'false',
        onClick: onPick,
      },
        e('span', { className: 'erp-pick-name' }, connection.label || connection.id),
        e('span', { className: 'erp-pick-meta' }, connection.family === 'kingdee' ? 'Kingdee' : 'U8', ' · ', connection.baseUrl))
    }

    /**
     * The workbench page.
     * @param props - Slot props carrying the client context and translator.
     * @returns Page element.
     */
    function ErpPage(props) {
      const { t } = props
      const [phase, setPhase] = React.useState({ kind: 'loading' })
      const [form, setForm] = React.useState(blankConnection)
      const [mappingText, setMappingText] = React.useState('')
      const [note, setNote] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [callAction, setCallAction] = React.useState('')
      const [callParams, setCallParams] = React.useState('{}')
      const [result, setResult] = React.useState(null)
      const [nonce, setNonce] = React.useState(0)

      React.useEffect(() => {
        const controller = new AbortController()
        let live = true
        setNote(null)
        request('/state', {}, controller.signal).then(outcome => {
          if (!live) return
          if (outcome.ok) {
            setPhase({ kind: 'ready', state: outcome.value })
            return
          }
          setPhase({ kind: 'failed', message: errorText(t, outcome.error) })
        }).catch(cause => {
          if (!live || cause?.name === 'AbortError') return
          setPhase({ kind: 'failed', message: t('err.network') })
        })
        return () => { live = false; controller.abort() }
      }, [t, nonce])

      const state = phase.kind === 'ready' ? phase.state : null
      const actions = state?.mapping?.actions ?? []
      const connections = state?.connections ?? []

      // The action picker follows the mapping, so a freshly saved mapping is
      // immediately callable without a manual selection.
      React.useEffect(() => {
        if (actions.length === 0) { setCallAction(''); return }
        const known = actions.some(action => `${action.domain}::${action.action}` === callAction)
        if (!known) setCallAction(`${actions[0].domain}::${actions[0].action}`)
      }, [actions, callAction])

      /**
       * Run one host action with shared busy/error bookkeeping.
       * @param work - Work returning `{ ok, value }`.
       * @param onOk - Called with the value on success.
       * @returns Whether it succeeded.
       */
      const run = async (work, onOk) => {
        setBusy(true)
        setError(null)
        setNote(null)
        try {
          const outcome = await work()
          if (!outcome.ok) {
            setError(errorText(t, outcome.error))
            return false
          }
          onOk?.(outcome.value)
          return true
        } catch {
          setError(t('err.network'))
          return false
        } finally {
          setBusy(false)
        }
      }

      const saveConnection = async () => {
        await run(
          () => request('/connections', { method: 'POST', body: { connection: connectionPayload(form) } }),
          value => {
            const saved = value.connection
            setForm(formOf(saved))
            setNote(t('conn.saved', { id: saved.label || saved.id }))
            setNonce(value => value + 1)
          },
        )
      }

      const dropConnection = async () => {
        if (form.id === '') return
        await run(
          () => request('/connections?id=' + encodeURIComponent(form.id), { method: 'DELETE' }),
          () => {
            setForm(blankConnection())
            setResult(null)
            setNonce(value => value + 1)
          },
        )
      }

      const testConnection = async () => {
        if (form.id === '') {
          setError(t('invoke.needConnection'))
          return
        }
        await run(
          () => request('/connections/test', { method: 'POST', body: { connectionId: form.id } }),
          value => { setNote(t('conn.testOk', { status: value.status, ms: value.elapsedMs })) },
        )
      }

      const saveMapping = async () => {
        await run(
          () => request('/mappings', { method: 'POST', body: { text: mappingText } }),
          value => {
            setNote(t('map.saved'))
            setResult(null)
            setNonce(value => value + 1)
            setMappingText(current => (current === '' ? JSON.stringify(value.mapping, null, 2) : current))
          },
        )
      }

      const loadExample = async () => {
        await run(
          () => request('/mappings/example', { method: 'POST' }),
          value => {
            setNote(t('map.saved'))
            setNonce(value => value + 1)
            setMappingText(JSON.stringify(value.mapping, null, 2))
          },
        )
      }

      const invokeCall = async () => {
        const params = parseObject(callParams)
        if (params === undefined) {
          setError(t('invoke.badParams'))
          return
        }
        const [domain, action] = callAction.split('::')
        if (domain === undefined || action === undefined) {
          setError(t('invoke.needMapping'))
          return
        }
        await run(
          () => request('/invoke', {
            method: 'POST',
            body: { connectionId: form.id === '' ? connections[0]?.id : form.id, domain, action, params },
          }),
          value => { setResult(value) },
        )
      }

      const connector = state?.connector
      const warning = connector !== undefined && connector.ready !== true
        ? e('div', { className: 'erp-warn' },
          e('strong', null, t('state.connectorMissing')),
          e('span', { className: 'erp-note' }, t('state.connectorMissingHint')),
          connector.error === undefined ? null : e('code', null, connector.error))
        : null

      const connectionCard = e('section', { className: 'erp-card' },
        e('div', { className: 'erp-card-head' },
          e('h4', { className: 'erp-card-title' }, t('conn.title')),
          e('span', { className: 'erp-count' }, String(connections.length)),
          e('button', {
            type: 'button',
            className: 'erp-button',
            style: { marginLeft: 'auto' },
            disabled: busy,
            onClick: () => { setForm(blankConnection()); setResult(null) },
          }, t('action.newConnection'))),
        connections.length === 0
          ? e('p', { className: 'erp-empty' }, t('conn.empty'))
          : e('div', { className: 'erp-list' }, connections.map(connection => e(ConnectionPick, {
            key: connection.id,
            connection,
            active: connection.id === form.id,
            onPick: () => { setForm(formOf(connection)); setResult(null) },
          }))),
        e('div', { className: 'erp-grid' },
          e('label', { className: 'erp-field' },
            e('span', null, t('conn.label')),
            e('input', {
              className: 'erp-input',
              value: form.label,
              placeholder: 'U8 生产库',
              onChange: event => setForm({ ...form, label: event.target.value }),
            })),
          e('label', { className: 'erp-field' },
            e('span', null, t('conn.family')),
            e('select', {
              className: 'erp-select',
              value: form.family,
              onChange: event => setForm({ ...blankConnection(event.target.value), id: form.id, label: form.label, baseUrl: form.baseUrl }),
            }, FAMILIES.map(family => e('option', { key: family.id, value: family.id }, family.label)))),
          form.family === 'yonyou'
            ? e('label', { className: 'erp-field' },
              e('span', null, t('conn.version')),
              e('select', {
                className: 'erp-select',
                value: form.version,
                onChange: event => setForm({ ...form, version: event.target.value }),
              }, ['v13', 'v15'].map(version => e('option', { key: version, value: version }, version))))
            : null,
          e('label', { className: 'erp-field', style: { gridColumn: 'span 2' } },
            e('span', null, t('conn.baseUrl')),
            e('input', {
              className: 'erp-input',
              value: form.baseUrl,
              placeholder: 'https://u8.example.com',
              spellCheck: false,
              onChange: event => setForm({ ...form, baseUrl: event.target.value }),
            }))),
        e('p', { className: 'erp-note' }, t('conn.baseUrlHint')),
        form.family === 'yonyou'
          ? e('div', { className: 'erp-grid' },
            e('label', { className: 'erp-field' },
              e('span', null, t('conn.token')),
              e('input', {
                className: 'erp-input',
                type: 'password',
                value: form.token,
                placeholder: form.hasToken ? t('conn.keepSecret') : '',
                autoComplete: 'new-password',
                onChange: event => setForm({ ...form, token: event.target.value }),
              })),
            e('label', { className: 'erp-field' },
              e('span', null, t('conn.pathPrefix')),
              e('input', {
                className: 'erp-input',
                value: form.pathPrefix,
                placeholder: '/apilink/u8api',
                onChange: event => setForm({ ...form, pathPrefix: event.target.value }),
              })))
          : e('div', { className: 'erp-grid' },
            e('label', { className: 'erp-field' },
              e('span', null, t('conn.appId')),
              e('input', {
                className: 'erp-input',
                value: form.appId,
                onChange: event => setForm({ ...form, appId: event.target.value }),
              })),
            e('label', { className: 'erp-field' },
              e('span', null, t('conn.acctId')),
              e('input', {
                className: 'erp-input',
                value: form.acctId,
                onChange: event => setForm({ ...form, acctId: event.target.value }),
              })),
            e('label', { className: 'erp-field' },
              e('span', null, t('conn.appSecret')),
              e('input', {
                className: 'erp-input',
                type: 'password',
                value: form.appSecret,
                placeholder: form.hasAppSecret ? t('conn.keepSecret') : '',
                autoComplete: 'new-password',
                onChange: event => setForm({ ...form, appSecret: event.target.value }),
              }))),
        e('div', { className: 'erp-actions' },
          e('button', { type: 'button', className: 'erp-button erp-button-primary', disabled: busy, onClick: () => { void saveConnection() } }, t('action.save')),
          e('button', { type: 'button', className: 'erp-button', disabled: busy || form.id === '', onClick: () => { void testConnection() } }, t('action.test')),
          e('button', { type: 'button', className: 'erp-button erp-button-danger', disabled: busy || form.id === '', onClick: () => { void dropConnection() } }, t('action.delete'))),
        e('p', { className: 'erp-note' }, t('conn.testHint')))

      const mapping = state?.mapping
      const mappingCard = e('section', { className: 'erp-card' },
        e('div', { className: 'erp-card-head' },
          e('h4', { className: 'erp-card-title' }, t('map.title')),
          mapping?.configured === true
            ? e('span', { className: 'erp-count' }, t('map.count', { count: mapping.count, version: mapping.version }))
            : null),
        mapping?.configured === true && mapping.count > 0
          ? e('div', { className: 'erp-list' }, mapping.actions.map(action => e('span', {
            key: action.domain + '::' + action.action,
            className: 'erp-pick',
          },
          e('span', { className: 'erp-pick-name' }, action.action),
          e('span', { className: 'erp-pick-meta' }, action.domain + ' · ' + action.api))))
          : e('p', { className: 'erp-empty' }, t('map.empty')),
        e('label', { className: 'erp-field' },
          e('span', null, t('field.json')),
          e('textarea', {
            className: 'erp-area',
            rows: 8,
            value: mappingText,
            placeholder: '{ "version": 1, "mappings": [] }',
            onChange: event => setMappingText(event.target.value),
          })),
        e('p', { className: 'erp-note' }, t('map.hint')),
        e('div', { className: 'erp-actions' },
          e('button', { type: 'button', className: 'erp-button erp-button-primary', disabled: busy, onClick: () => { void saveMapping() } }, t('action.validate')),
          e('button', { type: 'button', className: 'erp-button', disabled: busy, onClick: () => { void loadExample() } }, t('action.loadExample'))))

      const invokeCard = e('section', { className: 'erp-card' },
        e('div', { className: 'erp-card-head' },
          e('h4', { className: 'erp-card-title' }, t('invoke.title')),
          connections.length === 0 ? e('span', { className: 'erp-muted' }, t('invoke.needConnection')) : null,
          actions.length === 0 ? e('span', { className: 'erp-muted' }, t('invoke.needMapping')) : null),
        e('div', { className: 'erp-grid' },
          e('label', { className: 'erp-field', style: { gridColumn: 'span 2' } },
            e('span', null, t('invoke.action')),
            e('select', {
              className: 'erp-select',
              value: callAction,
              disabled: actions.length === 0,
              onChange: event => { setCallAction(event.target.value); setResult(null) },
            },
            e('option', { value: '' }, ''),
            actions.map(action => e('option', {
              key: action.domain + '::' + action.action,
              value: action.domain + '::' + action.action,
            }, actionLabel(action)))))),`r`n        e('label', { className: 'erp-field' },
          e('span', null, t('invoke.params')),
          e('textarea', {
            className: 'erp-area',
            rows: 4,
            value: callParams,
            spellCheck: false,
            onChange: event => setCallParams(event.target.value),
          })),
        e('p', { className: 'erp-note' }, t('invoke.paramsHint')),
        e('div', { className: 'erp-actions' },
          e('button', {
            type: 'button',
            className: 'erp-button erp-button-primary',
            disabled: busy || actions.length === 0,
            onClick: () => { void invokeCall() },
          }, t('action.invoke'))),
        result === null
          ? null
          : e('div', { className: 'erp-result' },
            e('div', null,
              e('p', { className: 'erp-note' }, t('invoke.request')),
              e('pre', { className: 'erp-pre' }, JSON.stringify(result.request, null, 2))),
            e('div', null,
              e('p', { className: 'erp-note' }, t('invoke.response')),
              e('pre', { className: 'erp-pre' }, JSON.stringify(result.response, null, 2)))),
        result === null
          ? null
          : e('p', {
            className: result.response?.success === true ? 'erp-note erp-note-ok' : 'erp-note erp-note-error',
          }, result.response?.success === true
            ? t('invoke.ok', { ms: result.response.latencyMs ?? 0, adapter: result.response.adapter ?? '—' })
            : t('invoke.failed') + ' · ' + String(result.response?.error?.code ?? '')))

      return e('div', { className: 'erp-page' },
        e('header', { className: 'erp-bar' },
          typeof props.onBack === 'function'
            ? e('button', { type: 'button', className: 'erp-button', onClick: props.onBack }, t('page.back'))
            : null,
          e('h3', null, t('tab.title')),
          e('span', { className: 'erp-bar-sub' }, t('tab.subtitle')),
          e('div', { className: 'erp-bar-actions' },
            connector === undefined
              ? null
              : e('span', { className: 'erp-badge', 'data-bad': connector.ready === true ? 'false' : 'true' },
                connector.ready === true ? 'connector' : 'connector ×'),
            e('button', { type: 'button', className: 'erp-button', disabled: busy, onClick: () => setNonce(value => value + 1) }, t('action.refresh')))),
        e('div', { className: 'erp-body' },
          phase.kind === 'loading' ? e('p', { className: 'erp-empty' }, t('state.loading')) : null,
          phase.kind === 'failed' ? e('p', { className: 'erp-note erp-note-error' }, t('state.loadError', { message: phase.message })) : null,
          warning,
          note === null ? null : e('p', { className: 'erp-note erp-note-ok' }, note),
          error === null ? null : e('p', { className: 'erp-note erp-note-error' }, error),
          state === null ? null : connectionCard,
          state === null ? null : mappingCard,
          state === null ? null : invokeCard,
          state?.store === undefined ? null : e('p', { className: 'erp-note' }, t('state.store', { path: state.store }))))
    }

    /**
     * Left-sidebar page wrapper: the same workbench with a fixed frame.
     * @param props - Slot props plus the client context.
     * @returns Page element.
     */
    function ErpPanel(props) {
      const back = () => { props.ctx.layout.selectPanel('conversation') }
      return e(ErpPage, { ...props, onBack: back })
    }

    /**
     * Sidebar row artwork.
     * @returns A small SVG mark.
     */
    function GuideArtwork() {
      const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }
      return e('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' },
        e('rect', { x: 1.8, y: 3.2, width: 5, height: 4, rx: 1, ...stroke }),
        e('rect', { x: 9.2, y: 8.8, width: 5, height: 4, rx: 1, ...stroke }),
        e('path', { d: 'M6.8 5.2h2.4a1.4 1.4 0 0 1 1.4 1.4v2.2', ...stroke }))
    }

    const inject = ['slots', 'locale', 'layout']

    /**
     * Register the dictionaries, the page, and its sidebar row.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      injectStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-erp-workbench: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, props => e(ErpPanel, { ...props, ctx }))), 'dsh-erp-workbench: page')
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 31,
        locale: NS,
        label: () => t('tab.title'),
      }, GuideArtwork)), 'dsh-erp-workbench: sidebar row')
    }

    const plugin = { inject, apply }
    if (typeof window !== 'undefined' && window.__DSH_ERP_WORKBENCH_TEST__ === true) {
      plugin.__test = {
        dictionaries: { zh, en },
        families: FAMILIES,
        blankConnection,
        formOf,
        connectionPayload,
        parseObject,
        actionLabel,
      }
    }
    return plugin
  },
})
