/**
 * Structural ontology validation.
 *
 * Checks the shape of one Turtle ontology without an external reasoner:
 * declarations, required RDFS annotations, resolvable edges, and duplicate
 * labels. Messages are user-facing Chinese text rendered by the workbench.
 */

import { Store, parse as parseRdf } from 'rdflib'
import { compactIri, parseTurtle, type OntologyModel } from './model.ts'
import type { ValidationIssue, ValidationReport } from './types.ts'

export type { ValidationIssue, ValidationReport } from './types.ts'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDFS_CLASS = 'http://www.w3.org/2000/01/rdf-schema#Class'
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class'
const OWL_OBJECT_PROPERTY = 'http://www.w3.org/2002/07/owl#ObjectProperty'
const OWL_DATATYPE_PROPERTY = 'http://www.w3.org/2002/07/owl#DatatypeProperty'

/** Triple fields the parser exposes; narrowed here so validation stays typed. */
interface Triple {
  readonly subject: { readonly value: string }
  readonly predicate: { readonly value: string }
  readonly object: { readonly value: string }
}

/** Return every triple in a Turtle document, keeping duplicate class declarations visible. */
function triplesOf(turtle: string, domain: string): Triple[] {
  const store = new Store()
  parseRdf(turtle, store, `http://example.org/ontology/${domain}#`, 'text/turtle')
  return store.statementsMatching(null, null, null)
}

/** Build one issue, omitting `subject` when the check does not name an entity. */
function issue(code: string, message: string, subject?: string): ValidationIssue {
  return subject === undefined ? { code, message } : { code, message, subject }
}

/** Report classes declared more than once, or declared as both class and property. */
function checkDeclarations(model: OntologyModel, triples: readonly Triple[], errors: ValidationIssue[]): void {
  const classDeclarations = new Map<string, number>()
  const propertyDeclarations = new Set<string>()
  for (const triple of triples) {
    if (triple.predicate.value !== RDF_TYPE) continue
    if (triple.object.value === OWL_CLASS || triple.object.value === RDFS_CLASS) {
      classDeclarations.set(triple.subject.value, (classDeclarations.get(triple.subject.value) ?? 0) + 1)
    }
    if (triple.object.value === OWL_OBJECT_PROPERTY || triple.object.value === OWL_DATATYPE_PROPERTY) {
      propertyDeclarations.add(triple.subject.value)
    }
  }
  for (const [iri, count] of classDeclarations) {
    const id = compactIri(iri, model.namespace)
    if (count > 1) errors.push(issue('duplicate-class-iri', `类 IRI 重复声明：${id}`, id))
    if (propertyDeclarations.has(iri)) {
      errors.push(issue('duplicate-class-iri', `同一 IRI 同时被声明为类与属性：${id}`, id))
    }
  }
}

/** Report missing labels and unresolvable subclass edges. */
function checkClasses(model: OntologyModel, classIds: ReadonlySet<string>, errors: ValidationIssue[]): void {
  for (const item of model.classes) {
    if (item.label.length === 0) errors.push(issue('missing-label', `类 ${item.id} 未指定 rdfs:label`, item.id))
    for (const parent of item.parents) {
      if (classIds.has(parent)) continue
      errors.push(issue('missing-node', `类 ${item.id} 的 rdfs:subClassOf 指向不存在的节点：${parent}`, item.id))
    }
  }
}

/** Report missing RDFS annotations and edges that point at no declared node. */
function checkProperties(
  model: OntologyModel,
  classIds: ReadonlySet<string>,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  for (const item of model.properties) {
    if (item.domain.length === 0) errors.push(issue('missing-domain', `属性 ${item.id} 未指定 rdfs:domain`, item.id))
    if (item.range.length === 0) errors.push(issue('missing-range', `属性 ${item.id} 未指定 rdfs:range`, item.id))
    if (item.label.length === 0) errors.push(issue('missing-label', `属性 ${item.id} 未指定 rdfs:label`, item.id))
    if (item.domain.length > 0 && !classIds.has(item.domain)) {
      errors.push(issue('missing-node', `属性 ${item.id} 的 rdfs:domain 指向不存在的节点：${item.domain}`, item.id))
    }
    if (item.kind === 'object') {
      if (item.range.length > 0 && !classIds.has(item.range)) {
        errors.push(issue('missing-node', `属性 ${item.id} 的 rdfs:range 指向不存在的节点：${item.range}`, item.id))
      }
      if (item.domain.length > 0 && item.domain === item.range) {
        errors.push(issue('domain-equals-range', `对象属性 ${item.id} 的 rdfs:domain 与 rdfs:range 相同：${item.id}`, item.id))
      }
    }
    if (item.kind === 'datatype' && classIds.has(item.range)) {
      warnings.push(issue('datatype-object-range', `数据属性 ${item.id} 的 rdfs:range 指向类 ${item.range}，通常应为数据类型`, item.id))
    }
  }
}

/** Report the same non-empty label used by different entities. */
function checkLabels(model: OntologyModel, errors: ValidationIssue[]): void {
  const owners = new Map<string, string[]>()
  for (const item of [...model.classes, ...model.properties]) {
    if (item.label.length === 0) continue
    const list = owners.get(item.label) ?? []
    list.push(item.id)
    owners.set(item.label, list)
  }
  for (const [label, list] of owners) {
    if (list.length < 2) continue
    const first = list.at(0)
    errors.push(issue('duplicate-label', `标签重复：“${label}” 被 ${list.join('、')} 共用`, first))
  }
}

/** Warn about classes no property refers to. */
function checkIsolated(model: OntologyModel, warnings: ValidationIssue[]): void {
  const referenced = new Set<string>()
  for (const item of model.properties) {
    if (item.domain.length > 0) referenced.add(item.domain)
    if (item.range.length > 0) referenced.add(item.range)
  }
  for (const item of model.classes) {
    if (referenced.has(item.id)) continue
    warnings.push(issue('isolated-class', `类 ${item.id} 未被任何属性引用`, item.id))
  }
}

/**
 * Strip what distinguishes two labels about the same concept.
 *
 * Extraction tends to qualify rather than merge: "合同（微调）" and
 * "合同（二次微调）" are the same class to a reader and two classes to the store.
 * Removing parenthetical qualifiers, punctuation, and case makes those collide.
 * @param label - the declared `rdfs:label`.
 * @returns the comparable core of the label.
 */
function normalizeLabel(label: string): string {
  return label
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s\-_·・/、,，。.:：;；!！?？"'“”‘’]/g, '')
    .toLowerCase()
}

/**
 * Drop a trailing counter from an entity id.
 * @param id - one class or property local name.
 * @returns the id without its trailing digits.
 */
function stemId(id: string): string {
  return id.replace(/\d+$/, '')
}

/**
 * Warn about entities that read as the same concept.
 *
 * Two shapes show up in practice and neither is caught by an exact-label check:
 * labels that differ only by a qualifier, and ids that differ only by a counter
 * (`Contract` / `Contract2`). Both are how an ontology silently doubles itself,
 * so both are worth a warning even though neither is strictly invalid.
 * @param model - parsed ontology.
 * @param warnings - collected advisory issues.
 */
function checkNearDuplicates(model: OntologyModel, warnings: ValidationIssue[]): void {
  const byLabel = new Map<string, string[]>()
  const byStem = new Map<string, string[]>()
  for (const item of [...model.classes, ...model.properties]) {
    const key = normalizeLabel(item.label)
    if (key.length > 0) {
      const list = byLabel.get(key) ?? []
      list.push(item.id)
      byLabel.set(key, list)
    }
    const stem = stemId(item.id)
    if (stem.length > 0) {
      const list = byStem.get(stem) ?? []
      list.push(item.id)
      byStem.set(stem, list)
    }
  }
  for (const [label, list] of byLabel) {
    const unique = [...new Set(list)]
    if (unique.length < 2) continue
    warnings.push(issue(
      'near-duplicate-label',
      `疑似同一概念的多个实体：“${label}” 被 ${unique.join('、')} 分别声明，请确认是否需要合并`,
      unique[0],
    ))
  }
  for (const [stem, list] of byStem) {
    const unique = [...new Set(list)]
    if (unique.length < 2) continue
    warnings.push(issue(
      'counter-suffixed-id',
      `实体 id 仅靠数字后缀区分：${unique.join('、')}（共同前缀 ${stem}），通常是重复创建而非新概念`,
      unique[0],
    ))
  }
}

/**
 * Validate one ontology's structure.
 * @param domain - the business domain id, used for the fallback namespace.
 * @param turtle - the Turtle document to validate.
 * @returns hard errors and advisory warnings; an unparsable document reports `parse-error`.
 */
export function validateOntology(domain: string, turtle: string): ValidationReport {
  let model: OntologyModel
  let triples: Triple[]
  try {
    model = parseTurtle(turtle, domain)
    triples = triplesOf(turtle, domain)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { errors: [issue('parse-error', `Turtle 解析失败：${reason}`)], warnings: [] }
  }

  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  checkDeclarations(model, triples, errors)
  if (model.classes.length === 0 && model.properties.length === 0) {
    errors.push(issue('empty-ontology', '本体为空：既没有类也没有属性'))
  }
  const classIds = new Set(model.classes.map(item => item.id))
  checkClasses(model, classIds, errors)
  checkProperties(model, classIds, errors, warnings)
  checkLabels(model, errors)
  checkIsolated(model, warnings)
  checkNearDuplicates(model, warnings)
  return { errors, warnings }
}
