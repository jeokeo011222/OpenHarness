/**
 * Bridge between the workbench and the ERP connector.
 *
 * The connector is a plain library, not a plugin, so its compiled output under
 * `erp-connector/dist` is loaded lazily: a deployment that never built it still
 * starts, and the page says what to run instead of showing an empty table.
 *
 * One connection is one adapter instance. The connector's registry is global,
 * so each call registers its adapter under a per-connection name and removes it
 * afterwards — two saved U8 endpoints never overwrite each other's token.
 */
import { ErpError } from './util.js'

/** Location of the connector's compiled entry point. */
const CONNECTOR_URL = new URL('../../erp-connector/dist/index.js', import.meta.url)

/** Set once the module loads, so the dynamic import happens at most once. */
let loading

/**
 * Exports the workbench calls on, i.e. what makes a build usable at all.
 *
 * The connector registry is empty at import time — adapters are registered per
 * call — so readiness is judged by the exported surface, not by registry state.
 */
const REQUIRED_EXPORTS = ['createRouter', 'registerAdapter', 'unregisterAdapter', 'transformParams']

/** Adapter constructors the page can offer, in the order it lists ERP families. */
const ADAPTER_EXPORTS = ['YonyouU8Adapter', 'KingdeeGalaxyAdapter']

/**
 * Load the ERP connector, reporting a missing build as an actionable refusal.
 * @returns The connector module.
 */
export async function loadConnector() {
  if (loading === undefined) {
    loading = import(CONNECTOR_URL.href).catch(error => {
      loading = undefined
      throw new ErpError(
        'connector_missing',
        `The ERP connector is not built (${String(error?.message ?? error)}). Run: npm --prefix erp-connector run build`,
        503,
      )
    })
  }
  return loading
}

/**
 * Report whether the connector can serve calls right now.
 *
 * A stale or partial build must not look ready: the page would then offer a
 * button that fails at the first click. Anything short of the full exported
 * surface reports `ready: false` with the command that fixes it.
 * @returns readiness, the adapter constructors found, and why when unusable.
 */
export async function connectorStatus() {
  try {
    const connector = await loadConnector()
    const missing = REQUIRED_EXPORTS.filter(name => connector[name] === undefined)
    const adapters = ADAPTER_EXPORTS.filter(name => connector[name] !== undefined)
    if (missing.length > 0 || adapters.length === 0) {
      return {
        ready: false,
        adapters,
        error: `The ERP connector build is incomplete (missing ${[...missing, ...(adapters.length === 0 ? ADAPTER_EXPORTS : [])].join(', ')}). Run: npm --prefix erp-connector run build`,
      }
    }
    return { ready: true, adapters }
  } catch (error) {
    return { ready: false, adapters: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Build the adapter one connection describes.
 * @param connector - Loaded connector module.
 * @param connection - Stored connection.
 * @returns Adapter instance.
 */
function buildAdapter(connector, connection) {
  if (connection.family === 'yonyou') {
    return new connector.YonyouU8Adapter({
      version: connection.version === 'v15' ? 'v15' : 'v13',
      baseUrl: connection.baseUrl,
      token: connection.token ?? '',
      ...(connection.pathPrefix === undefined ? {} : { pathPrefix: connection.pathPrefix }),
    })
  }
  if (connection.family === 'kingdee') {
    return new connector.KingdeeGalaxyAdapter({
      baseUrl: connection.baseUrl,
      appId: connection.appId ?? '',
      appSecret: connection.appSecret ?? '',
      acctId: connection.acctId ?? '',
    })
  }
  throw new ErpError('bad_family', `No adapter for ERP family "${connection.family}".`)
}

/**
 * Validate a mapping document without running it.
 *
 * Validation goes through the connector's own schema, so a document the page
 * accepts is exactly a document `router.load` accepts.
 * @param mapping - Candidate mapping document.
 * @returns Nothing; throws when the document is refused.
 */
export async function validateMapping(mapping) {
  const connector = await loadConnector()
  if (mapping === null || typeof mapping !== 'object') {
    throw new ErpError('mapping_invalid', 'The mapping must be a JSON object.')
  }
  try {
    connector.createRouter().load(mapping)
  } catch (error) {
    const detail = error?.issues === undefined
      ? String(error?.message ?? error)
      : error.issues.map(issue => `${(issue.path ?? []).join('.') || '(root)'}: ${issue.message}`).join('; ')
    throw new ErpError('mapping_invalid', `The mapping document was refused: ${detail}`)
  }
}

/**
 * Every family name a mapping may use for one connection: the family itself,
 * the adapter name, and any versioned variant of the family.
 * @param connection - Stored connection.
 * @param adapterName - Concrete adapter name.
 * @returns Family names this connection can serve.
 */
function servedFamilies(connection, adapterName) {
  return new Set([connection.family, adapterName])
}

/**
 * Invoke one mapped action through one connection.
 * @param connection - Stored connection.
 * @param mapping - Stored mapping document.
 * @param call - `{ domain, action, params }`.
 * @returns The transformed request, the ERP response, and the mapping used.
 */
export async function invoke(connection, mapping, call) {
  const connector = await loadConnector()
  if (mapping === null) throw new ErpError('mapping_missing', 'No action mapping is configured yet.', 400)
  const adapter = buildAdapter(connector, connection)
  const adapterName = `workbench:${connection.id}`
  const families = servedFamilies(connection, adapter.name)

  connector.registerAdapter({ name: adapterName, execute: request => adapter.execute(request) })
  try {
    const router = connector.createRouter()
    // Only the families this connection can serve are redirected; a mapping
    // aimed at the other ERP keeps its own resolution and fails loudly below.
    const defaults = { ...(mapping.defaultAdapterByFamily ?? {}) }
    for (const entry of mapping.mappings ?? []) {
      if (families.has(entry.erp)) defaults[entry.erp] = adapterName
    }
    try {
      router.load({ ...mapping, defaultAdapterByFamily: defaults })
    } catch (error) {
      throw new ErpError('mapping_invalid', `The stored mapping is no longer valid: ${String(error?.message ?? error)}`)
    }

    const resolved = router.resolveMapping(call.domain, call.action)
    if (resolved === undefined) {
      throw new ErpError('mapping_not_found', `No mapping for domain="${call.domain}" action="${call.action}".`)
    }
    if (!families.has(resolved.erp)) {
      throw new ErpError(
        'adapter_mismatch',
        `Action "${call.action}" is mapped to erp="${resolved.erp}", but connection "${connection.id}" is a ${connection.family} endpoint.`,
      )
    }
    let preview
    try {
      preview = connector.transformParams(call.params, resolved.params)
    } catch (error) {
      throw new ErpError('transform_failed', `Parameter transform failed: ${String(error?.message ?? error)}`)
    }
    const response = await router.invoke({ domain: call.domain, action: call.action, params: call.params })
    return {
      request: { connectionId: connection.id, erp: resolved.erp, api: resolved.api, params: preview },
      mapping: { domain: resolved.domain, action: resolved.action },
      response,
    }
  } finally {
    connector.unregisterAdapter(adapterName)
  }
}

/**
 * Check that an endpoint answers at all.
 *
 * This is a reachability probe, not an ERP call: no business API is touched, so
 * testing a connection can never create or approve a document.
 * @param connection - Stored connection.
 * @returns the HTTP status the endpoint answered with.
 */
export async function probe(connection) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  const started = Date.now()
  try {
    const response = await fetch(connection.baseUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    })
    return { reachable: true, status: response.status, elapsedMs: Date.now() - started }
  } catch (error) {
    throw new ErpError(
      'endpoint_unreachable',
      `Cannot reach ${connection.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      502,
    )
  } finally {
    clearTimeout(timer)
  }
}
