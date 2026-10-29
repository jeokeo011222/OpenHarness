// Static data layer. In production these load from ontology-store/*/summary.md
// and an existing mapping.json; for now we mock them so the editor is
// functional end-to-end without an HTTP backend.

import type { MappingConfigFile, OntologyAction } from './types.ts'

/** Mock ontology actions — structure mirrors what summary.md would produce. */
export const MOCK_ACTIONS: OntologyAction[] = [
  {
    domain: 'contract', name: 'queryPurchaseOrders',
    params: [
      { name: 'region', type: 'xsd:string' },
      { name: 'status', type: 'xsd:string' },
      { name: 'date', type: 'xsd:date' },
    ],
  },
  {
    domain: 'contract', name: 'savePurchaseOrder',
    params: [
      { name: 'orderData', type: 'xsd:string' },
    ],
  },
  {
    domain: 'contract', name: 'querySalesOrders',
    params: [
      { name: 'custId', type: 'xsd:string' },
      { name: 'date', type: 'xsd:date' },
    ],
  },
  {
    domain: 'procurement', name: 'queryPurchaseItems',
    params: [
      { name: 'supplierId', type: 'xsd:string' },
      { name: 'category', type: 'xsd:string' },
    ],
  },
]

/** Initial mapping config — matches erp-connector/examples/sample-config.json. */
export const INITIAL_CONFIG: MappingConfigFile = {
  version: 1,
  defaultAdapterByFamily: {
    yonyou: 'yonyou-u8-v13',
    kingdee: 'kingdee-cloud-galaxy',
  },
  mappings: [
    {
      domain: 'contract',
      action: 'queryPurchaseOrders',
      erp: 'yonyou',
      api: 'u8_purchase_order_query',
      params: [
        { from: 'region', to: 'cRegion', transform: { kind: 'identity' } },
        { from: 'status', to: 'cStatus', transform: { kind: 'enum_map', map: { '未交货': '0', '部分交货': '1', '已交货': '2' } } },
        { from: 'date', to: 'dDate', transform: { kind: 'date_format', format: 'YYYYMMDD' } },
      ],
    },
  ],
}
