/**
 * Contract instance fixture for analytics tests.
 *
 * Production instance data arrives through `importInstances`; tests build the
 * same Turtle shape directly so they never depend on deployed sample data.
 */

/** Escape a Turtle string literal. */
function quote(value: string): string {
  return JSON.stringify(value)
}

/** UTC date shifted by whole days. */
function addDays(today: string, days: number): string {
  const date = new Date(`${today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * Build one contract instance batch covering the deployed vocabulary.
 * @param today - UTC date the relative dates are derived from.
 * @returns Turtle for the batch plus its contract count.
 */
export function sampleInstanceTurtle(today: string): { turtle: string; contracts: number } {
  const offset = (days: number): string => addDays(today, days)
  const rows = [
    { no: 'C-2026-001', title: '办公园区物业服务合同', amount: 1280000, signed: offset(-330), expiry: offset(-10), category: '服务采购', status: '已履行', dept: '行政部', party: '恒信物业' },
    { no: 'C-2026-002', title: '核心机房设备采购合同', amount: 3450000, signed: offset(-300), expiry: offset(12), category: '货物采购', status: '履行中', dept: '信息技术部', party: '云启科技' },
    { no: 'C-2026-003', title: '年度法律顾问服务合同', amount: 620000, signed: offset(-270), expiry: offset(25), category: '服务采购', status: '履行中', dept: '法务部', party: '中衡律所' },
    { no: 'C-2026-004', title: 'ERP 系统运维服务合同', amount: 1850000, signed: offset(-240), expiry: offset(140), category: '服务采购', status: '履行中', dept: '信息技术部', party: '云启科技' },
    { no: 'C-2026-005', title: '员工商业保险采购合同', amount: 980000, signed: offset(-210), expiry: offset(30), category: '服务采购', status: '履行中', dept: '人力资源部', party: '泰安保险' },
    { no: 'C-2026-006', title: '总部办公家具采购合同', amount: 760000, signed: offset(-180), expiry: offset(60), category: '货物采购', status: '履行中', dept: '行政部', party: '美居家具' },
    { no: 'C-2026-007', title: '数据中台建设实施合同', amount: 4200000, signed: offset(-150), expiry: offset(210), category: '工程实施', status: '履行中', dept: '信息技术部', party: '数联科技' },
    { no: 'C-2026-008', title: '市场活动策划服务合同', amount: 540000, signed: offset(-120), expiry: offset(8), category: '服务采购', status: '履行中', dept: '市场部', party: '焦点传播' },
    { no: 'C-2026-009', title: '工厂生产线改造合同', amount: 6800000, signed: offset(-90), expiry: offset(320), category: '工程实施', status: '履行中', dept: '生产部', party: '恒远机械' },
    { no: 'C-2026-010', title: '云资源年度采购合同', amount: 2100000, signed: offset(-60), expiry: offset(300), category: '货物采购', status: '履行中', dept: '信息技术部', party: '蓝海云' },
    { no: 'C-2026-011', title: '差旅服务框架合同', amount: 450000, signed: offset(-30), expiry: offset(29), category: '服务采购', status: '待签署', dept: '行政部', party: '途安商旅' },
    { no: 'C-2026-012', title: '安全咨询服务合同', amount: 330000, signed: offset(-5), expiry: offset(180), category: '服务采购', status: '履行中', dept: '安全部', party: '盾安咨询' },
  ]
  const prefix = `@prefix c: <http://example.org/ontology/contract#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix inst: <http://example.org/inst/contract/> .`
  const partyIris = new Map<string, string>()
  const blocks = rows.map((row) => {
    const partyIri = partyIris.get(row.party) ?? `http://example.org/inst/party/${String(partyIris.size + 1).padStart(3, '0')}`
    partyIris.set(row.party, partyIri)
    return `inst:${row.no} a c:Contract ;
  c:contractNo ${quote(row.no)} ;
  c:contractTitle ${quote(row.title)} ;
  c:contractAmount "${String(row.amount)}"^^xsd:decimal ;
  c:signedDate "${row.signed}"^^xsd:date ;
  c:expiryDate "${row.expiry}"^^xsd:date ;
  c:category ${quote(row.category)} ;
  c:status ${quote(row.status)} ;
  c:ownerDept ${quote(row.dept)} ;
  c:hasParty <${partyIri}> .`
  })
  const parties = Array.from(partyIris, ([name, iri]) => `<${iri}> a c:Party ;\n  c:partyName ${quote(name)} .`)
  return {
    turtle: [prefix, ...blocks, ...parties].join('\n\n'),
    contracts: rows.length,
  }
}
