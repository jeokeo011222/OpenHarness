/**
 * Turtle → natural-language summary generator.
 *
 * Parses an OWL ontology (Turtle) with rdflib and extracts
 * classes, object properties, datatype properties, and comments
 * into a Markdown-format summary suitable for model injection.
 *
 * Gracefully handles missing rdfs:label / rdfs:comment — every
 * entity falls back to its local name so the summary never
 * contains blank entries.
 *
 * NOTE: rdflib's published type definitions are stricter than
 * Harness strict mode accepts for Quad/Statement interop, so we
 * intentionally keep one `any` boundary at the rdflib call site
 * and use our own simple structs downstream.
 */

import { writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Store, parse as rdflibParse, namedNode } from 'rdflib'

/** A single extracted OWL class. */
interface ExtractedClass {
  label: string
  localName: string
  comment: string
}

/** A single extracted property (object or datatype). */
interface ExtractedProperty {
  label: string
  localName: string
  domain: string
  range: string
  isObjectProperty: boolean
}

/** Result of parsing one Turtle document. */
interface ParsedOntology {
  classes: ExtractedClass[]
  properties: ExtractedProperty[]
}

const RDF_TYPE = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')
const RDFS_LABEL = namedNode('http://www.w3.org/2000/01/rdf-schema#label')
const RDFS_COMMENT = namedNode('http://www.w3.org/2000/01/rdf-schema#comment')
const RDFS_DOMAIN = namedNode('http://www.w3.org/2000/01/rdf-schema#domain')
const RDFS_RANGE = namedNode('http://www.w3.org/2000/01/rdf-schema#range')
const OWL_CLASS = namedNode('http://www.w3.org/2002/07/owl#Class')
const OWL_OBJECT_PROPERTY = namedNode('http://www.w3.org/2002/07/owl#ObjectProperty')
const OWL_DATATYPE_PROPERTY = namedNode('http://www.w3.org/2002/07/owl#DatatypeProperty')

/** Extract the local name after the last '#' or '/'. */
function localNameOf(iri: string): string {
  const hashIdx = iri.lastIndexOf('#')
  const slashIdx = iri.lastIndexOf('/')
  const idx = Math.max(hashIdx, slashIdx)
  return idx >= 0 ? iri.slice(idx + 1) : iri
}

/** Read all value strings for (subject, predicate, *) as an array. */
function matchValues(triples: Store, subject: unknown, predicate: unknown): string[] {
  const quads = (triples as any).match(subject, predicate, null) as Array<{ object: { value: string } }>
  return quads.map(q => q.object.value ?? '')
}

/** Return the value of any single (subject, predicate, *) match, or empty string. */
function anyValue(triples: Store, subject: unknown, predicate: unknown): string {
  const value = (triples as any).any(subject, predicate, null) as { value: string } | null
  return value?.value ?? ''
}

/** Parse Turtle text into a structured ontology summary. */
export function parseOntology(turtle: string, baseIri: string = 'http://example.org/ontology#'): ParsedOntology {
  const triples = new Store()
  rdflibParse(turtle, triples, baseIri, 'text/turtle')

  const allQuads: Array<{ subject: { value: string }; predicate: { value: string }; object: { value: string } }>
    = (triples as any).match(null, null, null)

  const classSubjects = new Set<string>()
  const propertySubjects = new Map<string, boolean>()

  for (const q of allQuads) {
    if (q.predicate.value === RDF_TYPE.value) {
      if (q.object.value === OWL_CLASS.value) {
        classSubjects.add(q.subject.value)
      } else if (q.object.value === OWL_OBJECT_PROPERTY.value) {
        propertySubjects.set(q.subject.value, true)
      } else if (q.object.value === OWL_DATATYPE_PROPERTY.value) {
        propertySubjects.set(q.subject.value, false)
      }
    }
  }

  const classes: ExtractedClass[] = []
  for (const iri of classSubjects) {
    const node = namedNode(iri)
    const labels = matchValues(triples, node, RDFS_LABEL)
    const comments = matchValues(triples, node, RDFS_COMMENT)
    const local = localNameOf(iri)
    classes.push({
      label: labels[0] || local,
      localName: local,
      comment: comments[0] || '',
    })
  }

  const properties: ExtractedProperty[] = []
  for (const [iri, isObject] of propertySubjects) {
    const node = namedNode(iri)
    const labels = matchValues(triples, node, RDFS_LABEL)
    const local = localNameOf(iri)
    const domainVal = anyValue(triples, node, RDFS_DOMAIN)
    const rangeVal = anyValue(triples, node, RDFS_RANGE)
    properties.push({
      label: labels[0] || local,
      localName: local,
      domain: domainVal ? localNameOf(domainVal) : '未指定',
      range: rangeVal ? localNameOf(rangeVal) : '未指定',
      isObjectProperty: isObject,
    })
  }

  return { classes, properties }
}

/** Render the parsed ontology into a Markdown summary. */
export function renderSummary(domain: string, parsed: ParsedOntology): string {
  const lines: string[] = []
  lines.push(`## 当前业务域：${domain}`)

  lines.push('')
  lines.push('### 对象类')
  if (parsed.classes.length === 0) {
    lines.push('_（未定义类）_')
  } else {
    for (const cls of parsed.classes) {
      const desc = cls.comment ? `：${cls.comment}` : ''
      lines.push(`- ${cls.label}（${cls.localName}）${desc}`)
    }
  }

  lines.push('')
  lines.push('### 关键关系')
  const objectProps = parsed.properties.filter(p => p.isObjectProperty)
  if (objectProps.length === 0) {
    lines.push('_（未定义对象关系）_')
  } else {
    for (const prop of objectProps) {
      lines.push(`- ${prop.domain} → ${prop.label} → ${prop.range}`)
    }
  }

  lines.push('')
  lines.push('### 数据属性')
  const dataProps = parsed.properties.filter(p => !p.isObjectProperty)
  if (dataProps.length === 0) {
    lines.push('_（未定义数据属性）_')
  } else {
    for (const prop of dataProps) {
      lines.push(`- ${prop.domain} → ${prop.label}（${prop.range}）`)
    }
  }

  return lines.join('\n') + '\n'
}

/** Write the summary.md file and return the rendered string. */
export async function generateSummary(storePath: string, domain: string, turtle: string): Promise<string> {
  const parsed = parseOntology(turtle)
  const rendered = renderSummary(domain, parsed)
  const summaryPath = join(resolve(storePath), domain, 'summary.md')
  await writeFile(summaryPath, rendered, 'utf8')
  return rendered
}

/** Return true if summary.md is missing or older than ontology.ttl. */
export async function summaryNeedsRefresh(summaryPath: string, ontologyPath: string): Promise<boolean> {
  let summaryStat
  try {
    summaryStat = await stat(summaryPath)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw cause
  }
  const ontologyStat = await stat(ontologyPath)
  return summaryStat.mtimeMs < ontologyStat.mtimeMs
}
