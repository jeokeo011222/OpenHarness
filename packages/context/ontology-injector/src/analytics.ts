/**
 * Ontology-driven analytics over instance batches.
 *
 * Every metric is built from the selected domain's live ontology, not from a
 * fixed vocabulary: classes and properties are read from the domain model, so a
 * new domain gets its own catalog as soon as its ontology is published. Metrics
 * compile to SPARQL over the instance named graphs, deduplicated per instance
 * IRI so a batch copied twice cannot inflate a count. Filters are validated
 * against the domain vocabulary before they reach SPARQL.
 *
 * When the instance data does not carry the type or property a metric reads, the
 * metric returns no rows and a warning instead of a fabricated answer.
 *
 * @module @deepseek-ai/dsh-ontology-injector/src/analytics
 */

import { emptyModel, expandId, parseTurtle, type ModelClass, type ModelProperty, type OntologyModel } from './model.ts'
import { querySparql, readLiveTurtle } from './store.ts'
import type {
  AnalyticsErrorCode,
  MetricDetail,
  MetricExplanation,
  MetricFilters,
  MetricRun,
  MetricSummary,
} from './analytics-types.ts'

export type {
  AnalyticsErrorCode,
  MetricDetail,
  MetricExplanation,
  MetricFilters,
  MetricKind,
  MetricRun,
  MetricSummary,
  MetricUnit,
} from './analytics-types.ts'

const PREFIXES = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`

/** Named-graph prefix instance imports share; analytics only reads these graphs. */
const INSTANCE_GRAPH_PREFIX = 'urn:dsh:ontology:graph:inst:'

const TEXT_LIMIT = 200
const GROUP_LIMIT = 50
const VALUE_LIMIT = 20

/** Refusal that names one rejected metric request. */
export class AnalyticsError extends Error {
  /**
   * @param code - stable reason the Remote layer maps to an error code.
   * @param message - operator-facing detail.
   */
  constructor(readonly code: AnalyticsErrorCode, message: string) {
    super(message)
    this.name = 'AnalyticsError'
  }
}

/** Classes and properties the active domain's ontology declares. */
interface Vocabulary {
  readonly namespace: string
  readonly classes: readonly ModelClass[]
  readonly datatype: readonly ModelProperty[]
  readonly object: readonly ModelProperty[]
}

/** Filters after resolution against the vocabulary. */
interface ResolvedFilters {
  readonly classIri: string | undefined
  readonly property: ModelProperty | undefined
}

/** Quote one string as a SPARQL literal. */
function quote(value: string): string {
  return JSON.stringify(value)
}

/**
 * Read the live ontology of one domain.
 * @param root - ontology store root.
 * @param domain - domain id.
 * @returns the domain model split into classes and property kinds.
 */
async function loadVocabulary(root: string, domain: string): Promise<Vocabulary> {
  const turtle = await readLiveTurtle(root, domain)
  const model: OntologyModel = turtle.trim().length === 0 ? emptyModel(domain) : parseTurtle(turtle, domain)
  return {
    namespace: model.namespace,
    classes: model.classes,
    datatype: model.properties.filter(property => property.kind === 'datatype'),
    object: model.properties.filter(property => property.kind === 'object'),
  }
}

/** IRI of one declared ontology term. */
function termIri(id: string, namespace: string): string {
  return expandId(id, namespace)
}

/** Reject a filter that cannot be expressed safely or is out of range. */
function assertText(value: string, field: string): void {
  if (value.length === 0 || value.length > TEXT_LIMIT) {
    throw new AnalyticsError('invalid-filter', `${field} must be 1–${TEXT_LIMIT} characters`)
  }
}

/** Resolve one class filter against the declared classes. */
function resolveClass(vocabulary: Vocabulary, value: string): string {
  assertText(value, 'class')
  const wanted = value.trim()
  const found = vocabulary.classes.find(item => item.id === wanted
    || termIri(item.id, vocabulary.namespace) === wanted)
  if (found === undefined) {
    throw new AnalyticsError('invalid-filter', `Unknown class "${wanted}"; the domain declares ${classIds(vocabulary)}`)
  }
  return termIri(found.id, vocabulary.namespace)
}

/** Resolve one property filter against the declared properties. */
function resolveProperty(vocabulary: Vocabulary, value: string): ModelProperty {
  assertText(value, 'property')
  const wanted = value.trim()
  const found = [...vocabulary.datatype, ...vocabulary.object].find(item => item.id === wanted
    || termIri(item.id, vocabulary.namespace) === wanted)
  if (found === undefined) {
    throw new AnalyticsError('invalid-filter', `Unknown property "${wanted}"; the domain declares ${propertyIds(vocabulary)}`)
  }
  return found
}

/** Declared class ids, for a refusal message. */
function classIds(vocabulary: Vocabulary): string {
  return vocabulary.classes.length === 0 ? 'none' : vocabulary.classes.map(item => item.id).join(', ')
}

/** Declared property ids, for a refusal message. */
function propertyIds(vocabulary: Vocabulary): string {
  const ids = [...vocabulary.datatype, ...vocabulary.object].map(item => item.id)
  return ids.length === 0 ? 'none' : ids.join(', ')
}

/** Validate the wire filters against the vocabulary. */
function resolveFilters(vocabulary: Vocabulary, filters: MetricFilters): ResolvedFilters {
  const classIri = filters.class === undefined ? undefined : resolveClass(vocabulary, filters.class)
  const property = filters.property === undefined ? undefined : resolveProperty(vocabulary, filters.property)
  return { classIri, property }
}

/** Filter that keeps the query inside the domain's instance named graphs. */
function instanceScope(domain: string): string {
  return `    FILTER(STRSTARTS(STR(?g), ${quote(`${INSTANCE_GRAPH_PREFIX}${domain}:`)}))`
}

/** Optional class restriction shared by every query. */
function classPattern(filters: ResolvedFilters): string {
  return filters.classIri === undefined ? '' : `    ?instance a <${filters.classIri}> .`
}

/** Restrict a predicate pattern to one declared property list, or fall back to all predicates. */
function predicatePattern(properties: readonly ModelProperty[], vocabulary: Vocabulary): string {
  if (properties.length === 0) return ''
  const iris = properties.map(property => `<${termIri(property.id, vocabulary.namespace)}>`).join(', ')
  return `    FILTER(?predicate IN (${iris}))`
}

/** One metric definition: metadata plus the query builder. */
interface MetricDefinition extends MetricSummary {
  readonly build: (context: BuildContext) => string
}

/** What one metric build receives. */
interface BuildContext {
  readonly domain: string
  readonly vocabulary: Vocabulary
  readonly filters: ResolvedFilters
}

/** Instance count, deduplicated per IRI across batches. */
const INSTANCE_COUNT: MetricDefinition = {
  id: 'instance-count',
  title: '实例总数',
  description: '按实例 IRI 去重后的实例数量；同一条实例出现在多个批次图中只计一次。可按类筛选。',
  kind: 'scalar',
  unit: 'count',
  requires: ['rdf:type'],
  caveat: '去重依据是实例 IRI。同一实例被导入两个批次时会合并为一条，不会重复计数。',
  build: context => `${PREFIXES}
SELECT (COUNT(DISTINCT ?instance) AS ?value) WHERE {
  GRAPH ?g {
${instanceScope(context.domain)}
    ?instance a ?type .
${classPattern(context.filters)}
  }
}`,
}

/** Instance distribution by class. */
const CLASS_DISTRIBUTION: MetricDefinition = {
  id: 'class-distribution',
  title: '按类实例分布',
  description: '按实例的 rdf:type 分组统计数量；类名取自本体中出现的类型。',
  kind: 'group',
  unit: 'count',
  requires: ['rdf:type'],
  caveat: '一个实例声明多个类型时会在每个类型中各计一次；这是分类拆分，不是重复计数。',
  build: context => `${PREFIXES}
SELECT ?key (COUNT(DISTINCT ?instance) AS ?count) WHERE {
  GRAPH ?g {
${instanceScope(context.domain)}
    ?instance a ?type .
${classPattern(context.filters)}
  }
  BIND(REPLACE(STR(?type), "^.*[#/]", "") AS ?key)
} GROUP BY ?key ORDER BY DESC(?count) LIMIT ${String(GROUP_LIMIT)}`,
}

/** Coverage of the declared data properties. */
const PROPERTY_COVERAGE: MetricDefinition = {
  id: 'property-coverage',
  title: '数据属性覆盖率',
  description: '统计本体声明的每个数据属性有多少实例带值；选择属性时只看该属性，本体没有数据属性时回退为实例图中的全部谓词。',
  kind: 'group',
  unit: 'count',
  requires: ['数据属性'],
  caveat: '覆盖率按实例 IRI 去重。未导入实例的属性不会出现，不代表该属性没有在本体里定义。',
  build: (context) => {
    const declared = context.filters.property === undefined
      ? context.vocabulary.datatype
      : [context.filters.property]
    return `${PREFIXES}
SELECT ?key (COUNT(DISTINCT ?instance) AS ?count) WHERE {
  GRAPH ?g {
${instanceScope(context.domain)}
${classPattern(context.filters)}
    ?instance ?predicate ?value .
    FILTER(?predicate != rdf:type)
${predicatePattern(declared, context.vocabulary)}
  }
  BIND(REPLACE(STR(?predicate), "^.*[#/]", "") AS ?key)
} GROUP BY ?key ORDER BY DESC(?count) LIMIT ${String(GROUP_LIMIT)}`
  },
}

/** Usage of the declared object properties. */
const RELATION_COVERAGE: MetricDefinition = {
  id: 'relation-coverage',
  title: '对象关系使用',
  description: '统计本体声明的每个对象属性被多少实例使用；选择属性时只看该属性，本体没有对象属性时回退为实例图中的 IRI 值谓词。',
  kind: 'group',
  unit: 'count',
  requires: ['对象属性'],
  caveat: '统计的是带该关系的实例数，不是关系条数；一个实例指向多个对象仍只计一次。',
  build: (context) => {
    const declared = context.filters.property === undefined
      ? context.vocabulary.object
      : [context.filters.property]
    return `${PREFIXES}
SELECT ?key (COUNT(DISTINCT ?instance) AS ?count) WHERE {
  GRAPH ?g {
${instanceScope(context.domain)}
${classPattern(context.filters)}
    ?instance ?predicate ?value .
    FILTER(?predicate != rdf:type)
${predicatePattern(declared, context.vocabulary)}
${declared.length === 0 ? '    FILTER(isIRI(?value))' : ''}
  }
  BIND(REPLACE(STR(?predicate), "^.*[#/]", "") AS ?key)
} GROUP BY ?key ORDER BY DESC(?count) LIMIT ${String(GROUP_LIMIT)}`
  },
}

/** Value distribution of the property the filters select. */
const PROPERTY_VALUES: MetricDefinition = {
  id: 'property-values',
  title: '属性取值分布',
  description: '按选中属性的取值分组统计实例数；在筛选栏选择属性后运行，未选择时不会猜测。',
  kind: 'group',
  unit: 'count',
  requires: ['所选属性'],
  caveat: '多值属性的一个实例会出现在多个取值上；需要单值口径时请先在数据里做归一。',
  build: (context) => {
    const property = requireProperty(context)
    return `${PREFIXES}
SELECT ?key (COUNT(DISTINCT ?instance) AS ?count) WHERE {
  GRAPH ?g {
${instanceScope(context.domain)}
${classPattern(context.filters)}
    ?instance <${termIri(property.id, context.vocabulary.namespace)}> ?value .
  }
  BIND(STR(?value) AS ?key)
} GROUP BY ?key ORDER BY DESC(?count) LIMIT ${String(VALUE_LIMIT)}`
  },
}

/** The property a value metric needs, with a refusal that names the declared set. */
function requireProperty(context: BuildContext): ModelProperty {
  if (context.filters.property === undefined) {
    throw new AnalyticsError('invalid-filter', `property-values needs a property; the domain declares ${propertyIds(context.vocabulary)}`)
  }
  return context.filters.property
}

/** The metric catalog, in presentation order. */
const METRICS: readonly MetricDefinition[] = [
  INSTANCE_COUNT,
  CLASS_DISTRIBUTION,
  PROPERTY_COVERAGE,
  RELATION_COVERAGE,
  PROPERTY_VALUES,
]

/** Look one metric up by id. */
function requireMetric(metricId: string): MetricDefinition {
  const metric = METRICS.find(item => item.id === metricId)
  if (metric === undefined) {
    throw new AnalyticsError('unknown-metric', `Unknown metric: ${metricId}`)
  }
  return metric
}

/** Public metadata of one definition. */
function summarize(metric: MetricDefinition): MetricSummary {
  return {
    id: metric.id,
    title: metric.title,
    description: metric.description,
    kind: metric.kind,
    unit: metric.unit,
    requires: metric.requires,
    caveat: metric.caveat,
  }
}

/** Build context for one request. */
function contextOf(domain: string, vocabulary: Vocabulary, filters: MetricFilters): BuildContext {
  return { domain, vocabulary, filters: resolveFilters(vocabulary, filters) }
}

/** Parse the SELECT list into column names, in query order. */
function resultVariables(sparql: string): readonly string[] {
  const select = /SELECT\s+(.*?)\s+WHERE/is.exec(sparql)?.[1] ?? ''
  const names: string[] = []
  const pattern = /\(\s*(?:COUNT|SUM|MAX|SAMPLE|MIN|AVG)\s*\(\s*(?:DISTINCT\s+)?[^)]+\)\s+AS\s+\?([A-Za-z0-9_]+)\s*\)|\?([A-Za-z0-9_]+)/g
  for (const match of select.matchAll(pattern)) {
    const name = match[1] ?? match[2]
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * List the metrics the active domain offers.
 *
 * The catalog shape is stable; the vocabulary behind each query comes from the
 * domain's live ontology.
 * @param root - ontology store root.
 * @param domain - domain id whose ontology the metrics read.
 * @returns catalog entries in presentation order.
 */
export async function listMetrics(root: string, domain: string): Promise<readonly MetricSummary[]> {
  await loadVocabulary(root, domain)
  return METRICS.map(summarize)
}

/**
 * Explain one metric, including a query compiled from the supplied filters.
 * @param root - ontology store root.
 * @param domain - domain id whose ontology the metric reads.
 * @param metricId - catalog id.
 * @param filters - filters to compile with.
 * @returns definition, query, and result columns.
 */
export async function explainMetric(
  root: string,
  domain: string,
  metricId: string,
  filters: MetricFilters = {},
): Promise<MetricExplanation> {
  const metric = requireMetric(metricId)
  const vocabulary = await loadVocabulary(root, domain)
  const sparql = metric.build(contextOf(domain, vocabulary, filters))
  return { ...summarize(metric), sparql, variables: resultVariables(sparql) }
}

/**
 * Run one metric over the store.
 * @param root - ontology store root.
 * @param domain - domain id whose ontology and instance batches are read.
 * @param metricId - catalog id.
 * @param filters - optional filters resolved against the domain vocabulary.
 * @returns aggregated rows plus the compiled query and warnings.
 */
export async function runMetric(
  root: string,
  domain: string,
  metricId: string,
  filters: MetricFilters = {},
): Promise<MetricRun> {
  const metric = requireMetric(metricId)
  const vocabulary = await loadVocabulary(root, domain)
  const sparql = metric.build(contextOf(domain, vocabulary, filters))
  const startedAt = Date.now()
  const result = await querySparql(root, sparql)
  const warnings: string[] = []
  const emptyScalar = metric.kind === 'scalar'
    && (result.rows.length === 0 || Number(result.rows[0]?.value ?? 0) === 0)
  if (result.rows.length === 0 || emptyScalar) {
    warnings.push('指标无数据：确认当前本体已导入实例，且实例的 rdf:type 与属性使用本体声明的 IRI')
  }
  return {
    metricId: metric.id,
    title: metric.title,
    kind: metric.kind,
    unit: metric.unit,
    variables: result.variables,
    rows: result.rows,
    sparql,
    durationMs: Date.now() - startedAt,
    warnings,
    ranAt: new Date().toISOString(),
  }
}

/** Drilldown query for one metric: the instances behind its aggregated rows. */
function detailQuery(
  domain: string,
  metricId: string,
  vocabulary: Vocabulary,
  filters: ResolvedFilters,
  limit: number,
): string {
  const scope = instanceScope(domain)
  const classLine = classPattern(filters)
  if (metricId === 'property-values') {
    const property = filters.property
    if (property === undefined) {
      throw new AnalyticsError('invalid-filter', `property-values needs a property; the domain declares ${propertyIds(vocabulary)}`)
    }
    return `${PREFIXES}
SELECT DISTINCT ?instance ?value WHERE {
  GRAPH ?g {
${scope}
${classLine}
    ?instance <${termIri(property.id, vocabulary.namespace)}> ?value .
  }
} ORDER BY ?instance LIMIT ${String(limit)}`
  }
  if (metricId === 'property-coverage' || metricId === 'relation-coverage') {
    const declared = filters.property === undefined
      ? (metricId === 'property-coverage' ? vocabulary.datatype : vocabulary.object)
      : [filters.property]
    return `${PREFIXES}
SELECT DISTINCT ?instance ?predicate ?value WHERE {
  GRAPH ?g {
${scope}
${classLine}
    ?instance ?predicate ?value .
    FILTER(?predicate != rdf:type)
${predicatePattern(declared, vocabulary)}
${metricId === 'relation-coverage' && declared.length === 0 ? '    FILTER(isIRI(?value))' : ''}
  }
} ORDER BY ?instance LIMIT ${String(limit)}`
  }
  return `${PREFIXES}
SELECT DISTINCT ?instance ?type WHERE {
  GRAPH ?g {
${scope}
${classLine}
    ?instance a ?type .
  }
} ORDER BY ?instance LIMIT ${String(limit)}`
}

/**
 * List the instances behind one metric.
 * @param root - ontology store root.
 * @param domain - domain id whose ontology and instance batches are read.
 * @param metricId - catalog id.
 * @param filters - optional filters shared with the aggregated query.
 * @param limit - maximum rows, 1–500.
 * @returns deduplicated instance rows.
 */
export async function drilldownMetric(
  root: string,
  domain: string,
  metricId: string,
  filters: MetricFilters = {},
  limit = 100,
): Promise<MetricDetail> {
  requireMetric(metricId)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AnalyticsError('invalid-filter', 'limit must be an integer between 1 and 500')
  }
  const vocabulary = await loadVocabulary(root, domain)
  const sparql = detailQuery(domain, metricId, vocabulary, resolveFilters(vocabulary, filters), limit)
  const result = await querySparql(root, sparql)
  return {
    metricId,
    variables: result.variables,
    rows: result.rows,
    sparql,
    truncated: result.rows.length >= limit,
  }
}

/**
 * Read the compiled query of one metric without running it.
 * @param root - ontology store root.
 * @param domain - domain id whose ontology the metric reads.
 * @param metricId - catalog id.
 * @param filters - filters to compile with.
 * @returns SPARQL text.
 */
export async function compileMetric(
  root: string,
  domain: string,
  metricId: string,
  filters: MetricFilters = {},
): Promise<string> {
  const metric = requireMetric(metricId)
  return metric.build(contextOf(domain, await loadVocabulary(root, domain), filters))
}
