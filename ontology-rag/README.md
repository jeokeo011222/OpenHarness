# Ontology-Guided RAG on DeepSeek Harness

English | [中文](README.zh.md)

## Summary

OntoRAG answers business questions from an ontology first, not from a vector index first. A query is parsed into entities, properties, relations, and business constraints by an ontology parser, answered by a weighted three-tier recall (graph 0.60 > exact text 0.25 > vector 0.15), and every candidate conclusion is re-validated by a SHACL rule engine before it reaches the user. If validation fails, the answer is blocked and the conflicting triples, the violated rule, and the supporting evidence are returned instead. This repository is a secondary development on DeepSeek Harness: the FastAPI service owns the semantic stack, and a TypeScript plugin bridges it into the harness tool registry and agent lifecycle. In the current test-stage deployment the graph lives in Fuseki and everything else — chunks, vectors, audit, tenants — lives in one PostgreSQL 16 database with the pgvector extension.

> **Runtime has moved.** The FastAPI service in this directory no longer ships with the product: retrieval,
> ontology compatibility filtering, the SHACL gate, and the provenance chain were re-implemented in TypeScript
> on top of oxigraph inside `packages/context/ontology-injector`. The client needs Node only — no Python
> interpreter, no Fuseki, no JVM. The Python implementation stays as a **reference implementation and offline
> evaluation baseline** (the twelve-question set, the metric definitions, the pg and Fuseki adapters) so the new
> implementation can be compared against it; it is not on the runtime path. The old `/debug` demo page is
> replaced by the retrieval-check tab in the ontology center.

## Table of Contents

- [Design](#design)
- [Repository layout](#layout)
- [Deployment](#deploy)
- [Storage and migration](#storage)
- [Request lifecycle](#lifecycle)
- [Ontology modeling guide](#ontology)
- [Harness integration](#harness)
- [Ingestion and chunking](#ingest)
- [POC demo flow](#poc)
- [Accuracy evaluation](#eval)
- [Acceptance criteria](#acceptance)
- [Known limitations](#limits)

-----

<a id="design"></a>
## Design

### Three-tier retrieval with fixed weights

The weights are not tuned per query and are not learned; they are asserted at startup by `require_weight_integrity()` so a misconfigured deployment fails loudly instead of silently degrading into a vector search.

| Tier | Store | Weight | Fires |
| Ontology graph | Fuseki SPARQL | 0.60 | whenever the structured query has an entity space |
| Exact text | PostgreSQL tsvector (BM25 on Elasticsearch) | 0.25 | whenever the query has text |
| Vector | pgvector HNSW cosine (Milvus) | 0.15 | only when the first two are insufficient |

The order is an architectural constraint, not a performance tweak. The graph tier narrows the candidate space to the objects the business constraints already point at; keyword and vector only fill in around that space. Doing it the other way round also "works", but the dirty recall has already happened by the time you filter, and filtering only hides it.

`app/retrieval/` is split so every decision has exactly one home:

| Module | Owns |
| `contract.py` | the input: entities, constraints, time range |
| `constraints.py` | constraint → target class + properties to project |
| `planner.py` | structured query → read-only `SELECT` |
| `compat.py` | the ontology compatibility verdict |
| `scoring.py` | every numeric factor |
| `service.py` | tier orchestration, gate, filter, rank |

The vector tier is a decision, not a default. `_need_vector` demands both enough candidates and a strong enough top score, and the reason is recorded verbatim in `RecallStats.tier_decisions` (`skipped:sufficient:count=5,best=0.538`, `insufficient-count:3/5`, `insufficient-score:0.31<0.45`). A skipped tier must be distinguishable from a forgotten one.

### Scoring, and why each factor exists

| Factor | Shape | Why |
| Graph path | `0.7 × path_strength + 0.3 × property_coverage` | evidence two hops from the entity is weaker than one hop; an entity missing half of its constraint properties cannot support an arithmetic conclusion |
| Keyword | `0.65 × x/(x+6) + 0.35 × term_coverage` | BM25 and `ts_rank_cd` have different scales; `x/max` collapses on a single outlier, a saturating curve does not |
| Vector | `(cos − 0.30)/(1 − 0.30) × 0.85` | below 0.30 is noise, and the discount guarantees a vector hit never outranks an equally scored graph hit |
| Fusion | `Σ w_t·s_t + 0.05·(tiers−1)` | agreement between independent channels is worth something, but less than any single weight |
| Ontology | `1 + 0.10 × min(overlap, 3)` | capped, so a chunk cannot win by stacking labels |
| Document | priority table × freshness | applied once, at the very end |

Document priority is applied exactly once — in `finalize`. Applying it inside each tier as well would penalise a low-priority clause twice for the same property, which is the most common way fusion ranking goes wrong. In the keyword tier, priority only acts as a tie-break so that the `top_k` window does not drop an equally matching regulation.

### Ontology first, vector last

The retriever narrows before it scores. `pre_retrieval_hook` produces a `QueryIntent` carrying `ontology_classes` and `ontology_properties`, and both the keyword index and the vector index filter on those labels, so an out-of-domain chunk is rejected at the store rather than demoted at the ranker. When a query names a business code (`C-2024-001`, `PAY-1001`), only the entities that reach that code through the graph survive — text matching would miss it, because a payment IRI does not contain the contract number it belongs to.

After recall, `OntologyCompatibility` is the single place that decides whether a chunk may answer the query: class comparability through the `rdfs:subClassOf` closure (a shared root such as `top:Entity` does not count, or every chunk would pass), property equivalence through `subPropertyOf` and `owl:inverseOf`, and `rdfs:domain` bridging for chunks tagged only with properties. Graph hits are exempt, because the fact chain already justifies them; an invoice clause retrieved while answering a payment question is cross-evidence, not noise. Every verdict carries a machine-readable reason (`class-hierarchy:ContractClause~Clause`), so a dropped chunk can be explained after the fact. The effect is measured: the evaluation set reports 0.00% dirty recall, where dirty recall is the share of fused candidates that the ontology had to discard.

### The guard is not optional

Bare model output is not returned. The generator must emit a JSON claim set, because free text cannot be SHACL-validated and therefore cannot be intercepted; a non-JSON reply raises `OntologyGuardError` and the request fails closed. The claim set is then checked twice: structurally (unknown predicate, unresolved subject, dangling object) and semantically, against the output-gate shapes in `claim_shapes.ttl`. Two shape sets exist on purpose — `contract_shapes.ttl` and `carbon_shapes.ttl` police stored data quality, while `claim_shapes.ttl` polices conclusions. Merging them would make the system unable to answer questions about data it correctly considers non-compliant.

<a id="layout"></a>
## Repository layout

```text
ontology-rag/
├── backend/
│   ├── app/
│   │   ├── adapters/          # memory, Fuseki, PostgreSQL+pgvector, Elasticsearch, Milvus, DeepSeek, SQLite
│   │   ├── api/routers/       # query, hooks, tools, admin, health, debug
│   │   ├── ingest/            # PDF and Word parsing, triple extraction
│   │   ├── ontology/          # model loader, entity linker, chunker, SHACL validator
│   │   ├── pipeline/          # intent, retrieval adapter, generator, guard, orchestrator
│   │   ├── retrieval/         # contract, constraints, planner, compat, scoring, service
│   │   ├── evaluation/        # metric kernel (judging, dirty recall) + report/CSV rendering
│   │   ├── compat.py          # event-loop shim for psycopg on Windows
│   │   ├── container.py       # dependency wiring for every backend combination
│   │   ├── ports.py           # Protocol contracts every adapter satisfies
│   │   ├── settings.py        # env-driven configuration
│   │   └── sparql_guard.py    # read-only enforcement and tenant graph scoping
│   ├── tests/                 # 40 unit cases + 9 PostgreSQL integration cases
│   ├── serve.py               # launcher: sets the loop policy before uvicorn
│   └── Dockerfile
├── ontology/
│   ├── top/top_core.ttl
│   ├── domain/domain_contract.owl
│   ├── domain/domain_carbon.ttl
│   ├── vocab/synonyms.ttl
│   └── shacl/claim_shapes.ttl
├── data/seed/                 # demo and other tenant instance graphs plus chunk JSONL
├── retrieval/pg/schema.sql
├── retrieval/es/chunks.mapping.json
├── config/mysql_mapping.json
├── deploy/fuseki/ontorag.ttl
├── scripts/                   # init_pg, migrate_to_pg, ingest_documents, mysql_to_rdf, init_retrieval, eval_accuracy
├── tests/eval/qa_set.jsonl
├── harness-plugin/            # TypeScript bridge plugin for DeepSeek Harness
├── docker-compose.yml
└── .env.example
```

<a id="deploy"></a>
## Deployment

### Mode A: memory, zero dependencies

`RAG_MODE=memory` runs the identical pipeline against in-process adapters: a real rdflib SPARQL engine, real BM25, real cosine similarity over deterministic hashing embeddings, and a real pyshacl gate. Only the storage is in-process. This is the mode used by the unit test suite, and it needs neither Docker nor a model key.

```bash
cd ontology-rag/backend
python -m venv .venv && ./.venv/Scripts/python.exe -m pip install -r requirements.txt
./.venv/Scripts/python.exe -m pytest -q
./.venv/Scripts/python.exe serve.py
```

### Mode B: full stack

Compose brings up three containers: Fuseki with TDB2 for the graph, PostgreSQL 16 with pgvector for everything else, and the backend on top. The backend waits on service health, not merely on container start. Elasticsearch, etcd, MinIO and Milvus are still defined but behind the `es` profile, so they only start when asked for.

```bash
cd ontology-rag
cp .env.example .env    # fill TENANT_KEYS, PG_PASSWORD and DEEPSEEK_API_KEY; never commit .env
docker compose up -d --build
docker compose logs -f backend
```

After the stack is healthy, initialise PostgreSQL, load the tenant graph into Fuseki, and optionally sync the business database.

```bash
docker compose exec backend python /srv/scripts/init_pg.py --tenant demo --recreate
curl -u admin:change-me-fuseki -X PUT \
  'http://localhost:3030/ontorag/data?graph=urn:ontorag:tenant:demo:graph' \
  -H 'Content-Type: text/turtle' --data-binary @data/seed/demo.ttl
docker compose exec backend python /srv/scripts/migrate_to_pg.py
```

### Required environment

Every secret is injected, never baked into the image.

```dotenv
RAG_MODE=live
RETRIEVAL_BACKEND=pg
AUDIT_BACKEND=auto
TENANT_STORE=auto
TENANT_KEYS={"demo": "replace-with-a-random-key"}
PG_DSN=postgresql://ontorag:change-me-pg@postgres:5432/ontorag
FUSEKI_URL=http://fuseki:3030
DEEPSEEK_API_KEY=
WEIGHT_GRAPH=0.60
WEIGHT_KEYWORD=0.25
WEIGHT_VECTOR=0.15
DAILY_TOKEN_BUDGET=2000000
TASK_TOKEN_LIMIT=24000
```

One environment trap is worth naming. If the host exports `HTTP_PROXY` / `HTTPS_PROXY` — common when endpoint-security agents or platform tooling inject them — a default `httpx` client would route even `http://fuseki:3030` through that proxy. The proxy cannot reach the internal graph store and answers `502`, so the failure looks like "the validator works on my machine and not on yours". The graph and keyword adapters therefore construct their clients with `trust_env=False`: internal dependencies are always direct. The LLM gateway keeps `trust_env` on, because egress through a proxy may be exactly what the deployment intends.

### Health checks

`/healthz` reports liveness and the loaded shape count; `/readyz` pings the actual storage backend — the PostgreSQL pool when there is one, otherwise the SQLite file — so a half-started stack is never routed to.

```bash
curl -s http://127.0.0.1:8000/healthz
curl -s http://127.0.0.1:8000/readyz
```

<a id="storage"></a>
## Storage and migration

One database holds four things, and the graph deliberately stays outside it. Fuseki owns RDF because SPARQL is the product's primary access path; pushing triples into relational tables would mean re-implementing the query engine the ontology was designed around.

| Table | Holds | Replaces |
| `app_tenant` | Tenant ids and HMAC-hashed API keys | `TENANT_KEYS` env JSON |
| `ontology_chunk` | Chunk bodies, ontology labels, tsvector index | Memory repository, ES documents |
| `chunk_vector` | Embeddings plus the name of the embedder that produced them | Milvus collection |
| `audit_run` | Full-chain audit rows with jsonb payloads | SQLite `audit.db` |

Three details in the schema are load-bearing rather than cosmetic. Chinese text is tokenised into bigrams before it reaches `to_tsvector('simple', ...)`, because the built-in parser does not segment Chinese and would otherwise store one lexeme per clause. `chunk_vector.embedding` is declared as `vector(1024)` from a placeholder substituted at migration time, because pgvector cannot parameterise a column dimension. And `chunk_vector.model` records which embedder produced each row, so a query embedding from a different model returns nothing instead of returning neighbours from an unrelated space.

```bash
python scripts/init_pg.py --tenant demo --tenant other --recreate
python scripts/migrate_to_pg.py --dry-run
python scripts/migrate_to_pg.py
```

<a id="lifecycle"></a>
## Request lifecycle

Every step below is mandatory and the order cannot change; the orchestrator records an audit row on every exit path, including the blocked ones.

1. The client posts `POST /v1/query` with `X-Tenant-Id` and `X-Api-Key`; the tenant dependency verifies the key in constant time against the tenant table and resolves the tenant graph IRI.
2. The ontology parser extracts entities, properties, relations, and business constraints, and normalises terms through the SKOS synonym library; unresolved surfaces fall back to fuzzy matching only for short queries.
3. The router runs the weighted hybrid recall and returns ranked candidates with a per-tier trace.
4. The post-recall filter validates each chunk against the current intent's ontology constraints and discards incompatible ones, counting them as dirty recalls.
5. Results are ordered by document priority: current regulation, then current contract or ledger, then national standard, then archive; expired and superseded documents are filtered or down-weighted.
6. The generator produces a JSON claim set plus citations, routed to the flash model or the stronger model by task shape.
7. The SHACL engine validates the claim set against `claim_shapes.ttl` and against the fetched context graph.
8. On failure the request returns 422 with the conflicting triples, the violated rule, and the evidence; nothing is returned to the user as an answer.
9. On success the response carries the answer, the original-text citations, the SPARQL path, and the trace id, and the full audit record is persisted.

<a id="ontology"></a>
## Ontology modeling guide

### Three layers

- Top layer (`ontology/top/top_core.ttl`): person, organization, project, document, clause, monetary amount, time period, regulation — the vocabulary every domain shares.
- Domain layer (`ontology/domain/*.owl`, `*.ttl`): the contract risk sub-ontology and the carbon accounting sub-ontology, each shipped with its own SHACL shapes. Adding engineering measurement later means adding a third directory, not editing the first two.
- Instance layer (`data/seed/*.ttl`, and per-tenant graphs in production): each tenant gets its own named graph `urn:ontorag:tenant:{id}:graph` from one shared domain template.

### Two shape sets

- Data-quality shapes police what is stored. `con:PaymentWithinRemaining` recomputes `amount × (1 − retention) − paid` and flags an over-application; `car:EmissionSourceSingleBoundary` groups by emission source and flags any source claimed by more than one mutually exclusive boundary.
- Output-gate shapes police what is said. `con:PaymentVerdictConsistency` rejects a verdict of `within-remaining` when the amount exceeds the remaining balance, and `car:EmissionClaimConsistency` recomputes every claimed emission figure from activity data, factor, and GWP.

### Add a domain

1. Write the domain ontology with `skos:altLabel` on every class and property the business actually says out loud; the synonym library is the single source of truth for entity linking.
2. Write the data-quality shapes with `sh:targetSubjectsOf` and `sh:sparql`, and keep `sh:prefixes` pointing at the ontology graph so prefixed names resolve.
3. Write the output-gate shapes for every conclusion property, and require `doc:basedOnChunk` on each one so an unsupported verdict cannot pass.
4. Register the prefix in `app/ontology/model.py` and the shape file in the loader; both shape graphs are merged with the ontology graph so prefixes resolve.
5. Register the constraint in `app/retrieval/constraints.py` (target class plus the properties it needs), and add at least two evaluation cases in `tests/eval/qa_set.jsonl` — one that must pass and one that must be blocked. There is no query template to write: `SparqlPlanner` derives the `SELECT` from the structured query, so a new constraint becomes retrievable without touching SPARQL by hand.

<a id="harness"></a>
## Harness integration

### Tools

The plugin registers into the harness tool registry through `ctx.inject(['tools'], ...)`. Every call carries `X-Tenant-Id` and `X-Api-Key`, and a `tools.guard` denies all four tools when the tenant or key is missing or when a tool is absent from `enabledTools`. A guard can only deny — listener ordering cannot turn a denial back into permission.

`fuseki_sparql_query` — facts.

- Only `SELECT` is accepted (`SPARQL_ALLOWED_FORMS=select`). `INSERT / DELETE / LOAD / DROP / …` are rejected by keyword, and a `;`-chained second statement is rejected as a shape violation rather than being ignored.
- `FROM` / `GRAPH` may only name the tenant graph. `GRAPH ?g` is rejected because its target cannot be decided statically.
- `FROM <urn:ontorag:tenant:{id}:graph>` is injected into every query. The dataset runs with `tdb2:unionDefaultGraph`, so an unscoped query would read every tenant's triples — injection here is the isolation itself, not an optimisation.
- An existing `LIMIT` is rewritten down to the cap; an oversized limit is a caller-chosen escape hatch, not a preference.
- The timeout is clamped on both sides and the caller can only shorten it. A timeout returns 400, never an empty result page — an empty page reads as "no such record" and invites a fabricated negative answer.

`shacl_validate` — conclusions.

- Takes candidate triples, merges the tenant facts, and evaluates the claim shapes.
- Results are partitioned by `sh:severity`: `Violation` sets `blocked: true`, the endpoint returns 422, and `tools/post-execute` converts that into `{ kind: 'block' }` so the turn stops. `Warning` and `Info` land in `warnings` and do not block unless the tenant opts into `fail_on_warning`.
- Two engines. `pyshacl` runs in-process. `fuseki` compiles the shapes into SPARQL, ships the candidate graph into a throwaway named graph over GSP, queries it there, and always deletes it. Apache Jena's Fuseki 5 serves no SHACL endpoint, so compiling to SPARQL is the only way to move evaluation into the graph store without adding a JVM sidecar.
- A shape component the compiler does not understand raises `ShapeCompileError`. Skipping it silently would leave a gate that looks active and is not.

`ontology_entity_link` — wording.

- DeepSeek Flash only proposes candidate surface forms. Its output schema has no IRI field, so it cannot invent one; IRIs come from the deterministic alias table, then fuzzy matching above 0.86, and anything left over is listed in `unmapped` for the caller to ask about.
- `use_llm: false`, a missing key, or a model failure falls back to lexicon-only, and the `extractor` field states which path actually ran.

`ontology_rag_answer` — the full pipeline: answer, citations, SPARQL path, guard report.

### Lifecycle hooks

- `agent/pre-step` calls `/v1/hooks/pre-retrieval` once per turn at step 1, delegates to `next()` first, and injects the parsed intent as one user-role message whose declared source kind is `ontology-rag`. It never injects twice for the same turn, and a failed parse degrades to no injection rather than blocking the conversation.
- `tools/post-execute` intercepts `ontology_rag_answer`, checks the per-turn token budget, then calls `/v1/hooks/post-generation`; a 422 becomes `{ kind: 'block' }` with the violated rules as feedback. Blocking here rather than at the assistant text is deliberate: assistant text is streamed and cannot be retracted, while an answer that enters the context as a tool result can still be refused.

### Model routing and cost control

Simple extraction and summarisation go to `LLM_MODEL_FLASH`; NL2SPARQL and multi-hop business reasoning are routed to `LLM_MODEL_STRONG` by hint matching. A tenant-scoped TTL plus LRU cache serves repeated questions at zero token cost, a circuit breaker opens after repeated failures, and both a per-task limit and a daily budget are enforced — exceeding either raises 429 instead of silently spending. Setting `LLM_PROVIDER=offline` skips the model entirely and falls back to the deterministic generator, which is what makes an air-gapped test deployment possible without pretending the output is model quality.

### Mount it

```yaml
- name: '@deepseek-ai/dsh-ontology-rag-bridge'
  config:
    baseUrl: 'http://127.0.0.1:8000'
    apiKey: '${ONTORAG_DEMO_KEY}'
    tenantId: 'demo'
    timeoutMs: 30000
    maxTokensPerTurn: 24000
    auditPath: './var'
    injectIntent: true
    enforceGuard: true
    requireApiKey: true
    # Empty means "all four". Narrow it per tenant when needed, e.g.
    # enabledTools: ['ontology_rag_answer'] turns off raw SPARQL for that tenant.
    enabledTools: []
```

<a id="ingest"></a>
## Ingestion and chunking

Fixed-length chunking is forbidden. `OntologyChunker` splits by ontology business unit — one clause, one rule, one field definition — and falls back to sentence boundaries only when a single unit exceeds 1200 characters. Every chunk carries its ontology labels, its document priority, and its effective window; a document with a `superseded_by` pointer or an `effective_to` in the past is marked deprecated at chunk time, so retrieval can filter it without a second pass.

```bash
python scripts/ingest_documents.py --tenant demo --source ./docs --out ./data/seed --extract
python scripts/mysql_to_rdf.py --tenant demo --since 2026-01-01 --push
python scripts/init_pg.py --tenant demo
```

<a id="poc"></a>
## POC demo flow

The bundled seed data is deliberately non-compliant so the guard has something real to catch: `PAY-1001` over-applies against `C-2024-001`, `INV-1001` exceeds its payment, and one emission source belongs to two mutually exclusive boundaries.

1. Start the stack, then ask about the over-application: the answer must state the excess, cite the governing clause, and pass the gate.
2. Ask about a payment that is within the remaining balance: the verdict must be `within-remaining` with the same arithmetic.
3. Ask about the boundary conflict: the answer must refuse to assign the source and must name both boundaries.
4. Ask a question whose only support is a deprecated document: the archive chunk must not be cited for a current-period question.
5. Call `POST /v1/admin/audit/{trace_id}` and confirm the record holds the query, the recall list, the SPARQL, the model input and output, the token counts, the tenant id, and the timestamp.

### Visual debug panel

`GET /debug/` serves a self-contained panel (no CDN, no build step, works on an air-gapped demo laptop) that runs one full chain and lays out every intermediate stage: the parsed intent, the three recall tiers with their per-chunk scores and verdicts, the SHACL report, the answer with its provenance chain, and a pure-vector baseline for contrast.

The panel calls `POST /v1/debug/trace`, which runs `pipeline.inspect()`. `inspect()` and `answer()` share `orchestrator._execute()`, so the SPARQL shown in the panel is the SPARQL that actually ran — a demo that re-simulates the pipeline proves nothing.

```bash
curl -s -X POST http://127.0.0.1:8000/v1/debug/trace \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-Id: demo' -H 'X-Api-Key: key-demo' \
  -d '{"question": "C-2024-001 这笔 700 万的付款申请是否超付？", "top_k": 5}'
```

Two parts of that payload are what the demo turns on. Each tier states why it did or did not run (`skipped:sufficient:count=5,best=0.582`), so "the vector tier was not needed" is distinguishable from "the vector tier was forgotten". And the baseline block reports how many chunks a plain vector search would have used that the ontology judges incompatible with the question — that count is the measurable difference between ontology-guided and naive RAG.

`DEBUG_PANEL_ENABLED=false` removes the page and the `/v1/debug/*` routes together. It is on by default because the panel returns chunk text, hit reasons, and violation details.

`tests/smoke/bridge_smoke.mjs` drives the compiled plugin client against a running backend and asserts all five behaviours above, including that a forged `within-remaining` verdict is blocked by `PaymentVerdictConsistency` rather than returned.

```bash
curl -s -X POST http://127.0.0.1:8000/v1/query \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-Id: demo' -H 'X-Api-Key: key-demo' \
  -d '{"question": "C-2024-001 这笔 700 万的付款申请是否超付？"}'
```

<a id="eval"></a>
## Accuracy evaluation

`scripts/eval_accuracy.py` runs a labelled set through the real pipeline and writes two artefacts: `report.md` (verdicts, failure buckets, per-case table, definitions) and `results.csv` (one row per case). It exits non-zero when accuracy, dirty recall, or the SHACL violation budget is missed, so it can gate a release.

```bash
python scripts/eval_accuracy.py --threshold 0.92 --max-dirty-recall 0.05
python scripts/eval_accuracy.py --only pay-over,closed-contract --verbose
python scripts/eval_accuracy.py --csv out/results.csv --report out/report.md
```

Each case carries `question`, `standard_answer`, `expected_sparql`, `expected_evidence`, and an optional `judge` block (`all_of` / `any_of` / `none_of` / `expect_block`).

Three metrics answer three different questions:

| Metric | Question it answers | Definition |
| --- | --- | --- |
| Answer accuracy | Is the conclusion right? | gate conforms + every `all_of` fact present + at least one `any_of` fact + no forbidden phrase |
| Dirty recall | How much irrelevant text came back? | `dirty / (dirty + relevant)`, micro-averaged. Dirty means an annotated counter-example or a document from another domain. Same-domain chunks without a label stay `unjudged` and are reported separately |
| Hallucination violations | Did the gate have to reject a claim? | count of `Violation`-severity SHACL results, excluding adversarial cases annotated `expect_block` |

Facts are compared by value, not by string: `5,500,000`, `5500000` and `550 万` are one amount, and `未超付` does not count as mentioning `超付`. `expected_sparql` supplies machine-checkable gold facts (amounts, counts, statuses — no internal IRIs) and yields the gold fact coverage, measured against the answer rather than against the system's own query: projection choices would otherwise decide the number.

```text
cases           : 12
accuracy        : 12/12 = 100.00% (>= 92%)
dirty recall    : 0/14 = 0.00% (<= 5%)
hallucinations  : 0 (SHACL Violation)
gold fact cover : 80.56%
unjudged share  : 46.15% (12/26 retrieved chunks had no ground truth)
verdict         : PASS
```

The report names the generator that produced the answers. With `LLM_PROVIDER=offline` (no model key configured) the numbers describe the retrieval and gate chain only, not model quality, and the report prints that caveat instead of letting a 100% be misread.

<a id="acceptance"></a>
## Acceptance criteria

| Metric | Target | Enforced by |
| Business answer accuracy | >= 92% | `scripts/eval_accuracy.py` exit code |
| Dirty recall rate | <= 5% | `--max-dirty-recall` on the same run |
| Conclusion traceability | 100% | SHACL shapes requiring `doc:basedOnChunk` |
| SHACL violation count | 0 | `claim_shapes.ttl` blocks the response; `--max-hallucination` counts it |

<a id="limits"></a>
## Known limitations

- OWL 2 RL only. Subclass, domain and range, and inverse relations are supported; there is no OWL DL full reasoning, and a domain that needs it must pre-materialise the inferences.
- SHACL-SPARQL shapes are powerful but not cheap. A pathological shape can cost seconds on a large tenant graph, so `inference="none"` and per-shape targeting are used deliberately.
- The offline embedder is a deterministic hashing trick, not a semantic model. It keeps the demo dependency-free and reproducible, but vector recall quality in that mode is not representative of a real embedding model.
- `ts_rank_cd` is a coverage model, not probabilistic BM25, so ties are more common than with Elasticsearch. Ordering stays deterministic because the ranker breaks ties on priority and chunk id rather than on score alone.
- psycopg async connections are bound to the event loop that created the pool, and Windows defaults to a Proactor loop they cannot use. `serve.py` sets the policy before uvicorn starts; launching `uvicorn app.main:app` directly on Windows fails with a readable error instead of working.
- The harness plugin is source-only in this repository; it is compiled by the root `tsc -b` project graph and is not published as a standalone package.
