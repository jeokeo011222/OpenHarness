export { createRouter, type Router, type CreateRouterOptions } from './router.js'
export { registerAdapter, unregisterAdapter, getAdapter, listAdapterNames, clearRegistry } from './registry.js'
export { applyTransform, transformParams } from './transformers.js'
export { YonyouU8Adapter, type YonyouU8Config } from './adapters/yonyou-u8-adapter.js'
export { KingdeeGalaxyAdapter, type KingdeeGalaxyConfig } from './adapters/kingdee-galaxy-adapter.js'
export type {
  ErpAdapter, ErpRequest, ErpResponse,
  ActionMapping, MappingConfigFile, ParamMapping, TransformerSpec, TransformKind,
  RouterInvokeArgs,
} from './types.js'
