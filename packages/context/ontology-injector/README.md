---
description: "Ontology center for business-domain knowledge: graph-database storage, per-turn summary injection, and the workbench for generating, editing, and versioning ontologies."
kind: "package-reference"
---

# @deepseek-ai/dsh-ontology-injector

English | [中文](README.zh.md)

## Summary

`dsh-ontology-injector` stores business ontologies in an embedded RDF graph database and injects a one-line index per approved domain each turn; the `domain_summary` tool returns the full vocabulary on demand. The ontology center workbench creates, generates, edits, versions, publishes, validates, and queries domains, and its analytics tab runs six contract metrics over imported instance batches with per-contract deduplication, caveats, drilldown, and audit. Only published versions reach the model. One root holds the image, snapshots, instance batches, and sources; summaries cap at 4000 characters.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when the model should know the organization's business vocabulary before it answers questions about policies, orders, or other named business domains. Injection runs once per turn: a `agent/pre-step` waterfall listener delegates first, skips rejected or aborted steps, and adds one user-role message at step 1. Domains in `defaultDomains` are injected in order, but a domain with no published version is skipped, and a domain marked `disabled` is skipped in `updateDomain`. A session never receives two injections for the same turn.

### What the model gets

Each injected block starts with `## 业务域本体知识：<domain>` and carries a one-line index: the domain label and id, how many classes, object relations, and data properties it holds, and the `domain_summary` call that returns the full vocabulary. When the model calls that tool, it reads the published version graph and renders the Markdown summary: a `### 对象类` list of class labels with local names, a `### 关键关系` list of object properties as `Domain → label → Range`, and a `### 数据属性` list of datatype properties with their range local names. Blocks are wrapped in `<system-reminder>` and joined into one user-role message with the source kind `ontology-injector`, so the index stays in durable history. Tool text longer than the budget is cut on a line boundary and ends with a truncation suffix.

### Configuration

The minimal mount needs no configuration, but it injects nothing until a domain exists in the store and appears in `defaultDomains`. The extraction model needs `apiKey` or `DEEPSEEK_API_KEY`; every other field has a default.

```yaml
- name: '@deepseek-ai/dsh-ontology-injector'
  config:
    defaultDomains: [policy]
    maxSummaryChars: 4000
```

| Field | Default | Meaning |
|---|---|---|
| `storePath` | repo `ontology-store/` | Root directory holding the graph image and per-domain sources |
| `defaultDomains` | `[]` | Domain ids injected at step 1, trimmed and deduplicated in order |
| `maxSummaryChars` | `4000` | Maximum characters kept from the summary the `domain_summary` tool returns |
| `model` | `deepseek-chat` | Extraction model called from an OpenAI-compatible endpoint |
| `baseUrl` | `https://api.deepseek.com/v1` | Chat-completions endpoint for extraction |
| `maxClauses` | `12` | Clause groups processed per generation run; the rest are reported as a warning |
| `maxSourceBytes` | `20971520` (20 MiB) | Largest accepted upload, in bytes |
| `maxInstanceBytes` | `20971520` (20 MiB) | Largest accepted instance Turtle import, in bytes |
| `maxEvidenceChars` | `200` | Clause text stored on each node, in characters |
| `apiKey` | `DEEPSEEK_API_KEY` | Bearer token for the extraction endpoint |

### Storage layout

One Oxigraph dataset backs the root. It is loaded on first use and rewritten atomically after every mutation, and it holds four kinds of named graph under the `urn:dsh:ontology:` vocabulary. Uploaded documents stay outside the graph because they are binary inputs.

- `graph.db.nq` — the durable dataset image; damaged images fail loud with `corrupt-image`, and an image recorded at a newer format version fails with `schema-mismatch`.
- `graph.db.lock` — the single-writer lock; a live holder makes a write fail as `ontology/busy`, and a record left by a dead pid or older than 60 seconds is taken over.
- `urn:dsh:ontology:registry` — the format version, the domain registry, and per-domain metadata.
- `urn:dsh:ontology:audit` — the append-only audit trail.
- `urn:dsh:ontology:graph:<domain>` and `urn:dsh:ontology:graph:<domain>:<version>` — the live graph and one immutable snapshot per version.
- `urn:dsh:ontology:graph:inst:<domain>:<batch>` — one named graph per imported instance batch, so replacing or clearing a batch never touches the ontology or its snapshots.
- `<domain>/sources/` — uploaded documents, stored with a timestamp prefix and sanitized file name; domain deletion leaves them in place.
- `backups/` — images written by `OntologyDatabase.backup()`.

### The workbench

The Web client face has four tabs: the domain list, the graph workbench, the analytics tab, and the audit trail. The graph workbench renders the graph canvas, the node inspector, and the versions panel, and confirms destructive actions before they run. It talks to the Host service through `ctx.remote.ontologyStore`, whose methods are `listDomains`, `createDomain`, `updateDomain`, `deleteDomain`, `generate`, `getGraph`, `applyEdits`, `applyPatch`, `listVersions`, `submitReview`, `publishVersion`, `deleteVersion`, `diffVersions`, `exportDomain`, `importOntology`, `validateDomain`, `evaluateQuality`, `queryDomain`, `listMetrics`, `runMetric`, `explainMetric`, `drilldownMetric`, `listMetricBatches`, `importInstances`, `deleteInstanceBatch`, `auditLog`, and `health`.

Generated, edited, patched, and imported graphs all become drafts. A draft changes the working graph the workbench renders but never the injected summary; `submitReview` moves it to `review`, and `publishVersion` copies that snapshot into the live graph and marks it active. Publishing an older published version is the rollback path, and a draft cannot be published before review. Each node also records the clause it came from and a clause-text excerpt, shown in the inspector as the source clause and text.

### Analytics

The analytics tab and the `list_metrics`, `run_metric`, and `explain_metric` tools answer questions about the selected domain: the catalog is built from that domain's live ontology, so classes and properties come from the domain itself rather than a fixed vocabulary. Every metric compiles to SPARQL over the domain's instance named graphs and deduplicates by instance IRI, so an instance repeated across batches never inflates a count. Filters name a declared class or property and are validated against the ontology before they reach SPARQL, and each run appends a `metric-run` audit entry from either the tab or the tool.

| Metric | Kind | Unit | Reads |
|---|---|---|---|
| `instance-count` | scalar | count | `rdf:type`; optional class scope |
| `class-distribution` | group | count | `rdf:type` |
| `property-coverage` | group | count | declared data properties; optional property scope |
| `relation-coverage` | group | count | declared object properties; optional property scope |
| `property-values` | group | count | the property named by `property` |

`class` and `property` filters accept a local id or absolute IRI declared by the domain ontology, and `property-values` refuses to run until `property` is set. A rejected filter fails as `analytics/invalid-filter` and an unknown metric id as `analytics/unknown-metric`. When the ontology declares no properties of the kind a coverage metric reads, that metric falls back to the predicates present in the instance graphs; a metric with no matching data returns an empty result plus a warning, so an empty store never looks like a real answer.

`importInstances(domain, turtle, batch)` parses one Turtle document and writes it into `urn:dsh:ontology:graph:inst:<domain>:<batch>`, replacing that batch when the id already exists. The document must parse and declare at least one triple, and imports above `maxInstanceBytes` fail as `ontology/invalid-request`; unparsable or empty input fails as `instance/invalid-turtle`. `listMetricBatches(domain)` reports the batches already present, and `deleteInstanceBatch(domain, batch)` removes one and records `instance-clear`. Reading analytics needs the `viewer` role, importing needs `author`, and deleting needs `owner`.

### Operator commands

Validation, audit, export, and health are Remote methods, and backup and restore are library calls; there is no dedicated CLI subcommand.

- `validateDomain(domain)` returns typed errors and warnings; errors cover unparsable text, an empty graph, duplicate class IRIs, missing labels, unresolvable nodes, missing domains or ranges, a property whose domain equals its range, and duplicate labels.
- `auditLog(limit)` returns the newest entries first, with action, domain, detail, and time; actions are create, update, delete, import, generate, edit, patch, review, publish, activate, quality, metric run, instance import, and instance clear.
- `exportDomain(domain, 'text/turtle')` returns the working Turtle, and `importOntology(domain, turtle, note)` stores it as a new draft version.
- `evaluateQuality(domain, goldTurtle, baselineName)` compares the working graph with an uploaded gold-standard document and returns class and property precision, recall, and the differing ids.
- `health()` returns the store path, the durable format version, and per-domain counters.
- `OntologyDatabase.backup()` writes an image under `<root>/backups/`, and `OntologyDatabase.restore(root, file)` replaces the live image with it; restart the Host afterwards so cached handles reload.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the plugin; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Two independent layers share one root. The graph database keeps the dataset and owns durability, locking, schema checks, and backup; the domain store maps registry, metadata, live graphs, and version snapshots onto named graphs. Both the per-turn index and the `domain_summary` tool read only the published version snapshot, so an unpublished draft never reaches the prompt: reads and the draft path both go through the same `graph.db.nq` image and locks.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: pre-step listener plus the `ctx.remote.ontologyStore` service |
| [`src/injector.ts`](src/injector.ts) | One-line domain index, summary cache, and injection envelope |
| [`src/tools.ts`](src/tools.ts) | The read-only `domain_summary` tool |
| [`src/analytics-tools.ts`](src/analytics-tools.ts) | The `list_metrics`, `run_metric`, and `explain_metric` tools |
| [`src/analytics.ts`](src/analytics.ts) | Metric catalog, filter validation, deduplicating SPARQL |
| [`src/analytics-types.ts`](src/analytics-types.ts) | Metric wire types shared by the Host and the client face |
| [`src/loader.ts`](src/loader.ts) | Legacy live-graph reader used by the summary script |
| [`src/summary.ts`](src/summary.ts) | Turtle to Markdown summary rendering |
| [`src/store.ts`](src/store.ts) | Registry, metadata, live graphs, versions, sources, audit, SPARQL |
| [`src/graph-db.ts`](src/graph-db.ts) | Oxigraph handle, image load and persist, lock, schema, backup, restore |
| [`src/model.ts`](src/model.ts) | Ontology model, Turtle parse and emit, edits, diffs |
| [`src/validate.ts`](src/validate.ts) | Structural validation report |
| [`src/quality.ts`](src/quality.ts) | Gold-standard precision and recall |
| [`src/generate.ts`](src/generate.ts) | Clause slicing and model extraction |
| [`src/extract.ts`](src/extract.ts) | DOCX, PDF, and text extraction |
| [`src/client/`](src/client/index.ts) | Web workbench face: canvas, inspector, versions, analytics, and audit |

### Main flow

At step 1 the listener resolves each configured domain: it checks that the domain exists, reads its metadata to honor `disabled`, loads the published version snapshot, renders its summary, and appends the wrapped one-line index. The `domain_summary` tool renders the same summary on demand, truncated to the budget. Every write path first refuses a concurrent write for the same domain with `ontology/busy`, then takes the image lock, reloads the image, mutates, and persists through a temporary rename.

A generation run writes the uploaded source, extracts text, slices it by clause markers, calls the extraction model once per clause with up to 6000 characters and the existing vocabulary, merges the JSON answer through the Host emitter, then stores a new draft snapshot that also becomes the working graph. A clause that fails is recorded and skipped; the run fails only when every clause fails. Graph edits and incremental patches follow the same draft-snapshot path; publishing a reviewed snapshot is the only write that changes what the model reads.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level reference is not enough.

- [Context group map](../README.md) — sibling request-context packages and their roles.
- [Architecture](../../../docs/architecture.md) — plugin seams, session events, and the Host/Client split.
- [Testing policy](../../../docs/testing.md) — how behavior tests and recorded-session snapshots are selected.

-----

<a id="model-experience"></a>
## Model Experience

### Per-turn ontology summary

#### What the model sees

One appended user-role message per turn, containing one `<system-reminder>` block per injected domain; the model calls `domain_summary` to expand a line into the full vocabulary.

##### Injected message

```markdown
<system-reminder>
## 业务域本体知识：policy

制度域（policy）：2 个类、2 条对象关系、1 个数据属性。需要完整词汇时调用 domain_summary 工具（domain="policy"）。
</system-reminder>
```

#### Token effect

The message is added once per turn, and repeated turns resend the same index lines until compaction shadows them. Each line costs a few dozen characters, and the full summary, capped at `maxSummaryChars`, is added only when the model calls `domain_summary`, so the per-turn cost no longer grows with the size of each ontology.

#### KV Cache effect

Text is appended after the reusable request prefix. An unchanged graph produces identical summary text, so earlier cached prefixes stay usable; a regeneration or edit rewrites the text and invalidates cache entries after that message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the ontology center is a poor fit. They are current package constraints.

- **Memory and rewrite cost** — the whole dataset lives in memory and the image is rewritten on every mutation. Large ontologies cost load time and full rewrites even for a single edit.
- **One writer per image** — concurrent processes serialize on `graph.db.lock`; a live holder surfaces as `ontology/busy`, and takeover follows a 60-second age threshold rather than an explicit unlock.
- **Prose summaries only** — the injection carries labels, comments, and domain/range local names. Restrictions, cardinalities, and OWL inference never reach the model, and a missing label falls back to the local name.
- **Silent skips** — a missing or disabled domain produces no block and no model-visible notice, so a misconfigured `defaultDomains` entry looks the same as an empty ontology.
- **Review is a workflow, not an identity check** — a draft cannot be published until it is submitted for review, but every caller shares one workbench identity; there is no per-user approval or domain ownership enforcement.
- **Extraction limits** — generation needs an API key, accepts only DOCX, PDF, MD, and TXT, slices each clause to 6000 characters, processes at most `maxClauses` clause groups, and trusts the model's JSON for names and labels. Each node keeps at most `maxEvidenceChars` characters of clause text.
- **Read-only queries** — `queryDomain` accepts SELECT and ASK and rejects INSERT, DELETE, CLEAR, DROP, and other update forms with `ontology/query-rejected`; rows are lexical strings without datatype or language tags.
- **Analytics trusts the ontology's IRIs** — metrics match instance data by the IRIs the live ontology declares. An instance typed or populated with IRIs outside that vocabulary is invisible to those metrics, and a `class` or `property` filter cannot name it.
- **Deduplication is IRI-only** — every metric collapses rows by instance IRI, so two genuinely distinct resources that share an IRI merge into one.
- **No numeric aggregation** — the catalog counts instances and property values; it does not sum or average numeric properties, and currency totals are not computed.
- **Instance imports are Turtle-only and unvalidated against the ontology** — `importInstances` parses the document and writes every triple it declares. There is no CSV or Excel reader, no SHACL or shape check, and a batch written against a different vocabulary simply produces empty metrics.
- **No downgrade** — an image recorded at a newer format version is refused, and there is no migration path back.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Behavior tests live in `tests/` and use `mkdtemp` roots under the system temp directory; they never write into the repository `ontology-store/`. Run them with `pnpm exec vitest run packages/context/ontology-injector/tests`.

</details>
