# Ontology OpenHarness

English | [中文](README.zh.md)

<p align="center">
  <img src="./apps/web/public/logo.png" alt="OpenHarness" width="180" />
  <br />
  <strong>Ontology OpenHarness</strong>
</p>

<p align="center">

[![Node.js](https://img.shields.io/badge/Node.js-≥24.9.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/) [![pnpm](https://img.shields.io/badge/pnpm-11.28+-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/jeokeo011222/Openharness/pulls) [![GitHub stars](https://img.shields.io/github/stars/jeokeo011222/Openharness?style=social)](https://github.com/jeokeo011222/Openharness/stargazers)

</p>

<p align="center">

**An enterprise-grade, ontology-driven agent harness: your business knowledge becomes context the agent can act through, your spreadsheets and databases become one analysis workbench, and mainstream ERPs become callable — all under local accounts you fully control.**

</p>

<p align="center">
  <img src="./docs/assets/readme/workbench.png" alt="The OpenHarness web workbench: sessions, plugins, and a chat that reaches every capability" width="49.5%" />
  <img src="./docs/assets/readme/quadnest.png" alt="QuadNest: four companion robots sharing one private micro-metaverse" width="49.5%" />
</p>

---

## ✨ Why OpenHarness

Every agent is context-limited. OpenHarness gives the agent a **business ontology it can act through** rather than only read: Turtle OWL/RDF parsed into class and property summaries for the prompt, object types bound to real rows so the model can query them, and declared actions it may only *propose* — a human approves before anything is written.

Around that core sits a plugin-first runtime: clients, tools, storage, and model providers are effects registered on documented seams, so a new capability is a new plugin instead of a new branch in the agent loop.

## 🏭 Enterprise ontology at the core

<p align="center">
  <img src="./docs/assets/readme/ontology.png" alt="The ontology center: published domains, knowledge graph, analysis, retrieval checks, and audit log" width="100%" />
</p>

Business knowledge is compiled once and read on every turn: published ontologies are verified, stored as an RDF graph, and summarized into the prompt before the first model step.

- **Sources are ordinary files** — each business domain keeps its Turtle OWL/RDF documents next to the project, and an upload publishes them into the graph store after structural validation.
- **The store is the single truth** — `oxigraph` holds `graph.db.nq` plus uploaded sources, and the injected summary is rebuilt from the store on each request instead of being hand-edited.
- **Writes need a human** — a proposal records the before/after of every field it would change, every blocking precondition, and the linked objects it touches. No tool can approve one.

The pipeline below is how one request meets your ontology — parse, store, infer, inject, and only then call the ERP behind an approved action:

<p align="center">
  <img src="./docs/assets/readme/ontology-pipeline.svg" alt="Ontology pipeline: sources, graph store, inference, injected summary, ERP call" width="100%" />
</p>

Working scenarios ship with the repo as Turtle documents and object bindings — contracts, procurement, and payment-priority analysis are already modeled end to end, so a new business domain starts from a template instead of a blank page.

## 📊 One workbench for business data

<p align="center">
  <img src="./docs/assets/readme/data-analysis.png" alt="The data analysis workbench: datasets from files, databases, and REST APIs, with charts and AI analysis" width="100%" />
</p>

The `dsh-data-analysis` bundle turns the web client into an analysis workbench: import CSV or Excel, connect databases and REST APIs into datasets, and query everything with a safe DSL.

- **One place for enterprise data** — files, database connections, and REST sources land as datasets the sidebar can browse, chart, and diff.
- **The agent reads the same numbers** — the model queries the dataset through tools instead of pasting rows into the prompt, so an analysis is reproducible instead of lucky.
- **Charts where the work happens** — saved charts sit next to the data, and every dataset keeps its source mapping for the next refresh.

## 🔌 Mainstream ERP adapters

<p align="center">
  <img src="./docs/assets/readme/erp-workbench.png" alt="The ERP workbench: connections, action mappings, and one test call" width="100%" />
</p>

The ERP connector is a standalone Node router with Zod schemas, an adapter registry, and a transformer pipeline — the workbench page is its way in from the product.

- **Yonyou U8 (v13/v15) and Kingdee Cloud Galaxy** ship as adapter skeletons, and a new ERP family is a new adapter plus a schema, not a fork.
- **The mapping editor pairs ontology actions with ERP APIs** — inline transformer specs, a live JSON preview, and one test call before anything real runs.
- **Nothing writes without a proposal** — the connector only executes actions the ontology declared and the visitor approved.

## 🧩 And the rest of the harness

<p align="center">
  <img src="./docs/assets/readme/quadnest-memory.png" alt="QuadNest: a companion's layered memory panel beside the stage" width="49.5%" />
  <img src="./docs/assets/readme/admin.png" alt="The admin console: accounts, roles, and per-resource grants" width="49.5%" />
</p>

| Capability | What it does |
|------------|--------------|
| 🧩 **Plugin-First Architecture** | Every seam — slots, waterfall listeners, services, projections — is a registered effect. No agent-loop code changes to extend behavior. |
| 🪺 **QuadNest micro-metaverse** | Four companion robots (星伴 / 溯游 / 灵旅 / 隅友） share one private stage with layered memory: persona, reflections, facts, and a recent window — raw transcripts stay in a journal, never re-enter the prompt. |
| 🔐 **Local Accounts** | Every browser request needs a signed-in local account; there is no platform account to link. Accounts, roles, and per-resource grants live in a SQLite directory. |
| 👑 **Admin Workbench** | An admin role bypasses resource policy and adds a user-management panel: create, rename, reset, promote, and delete accounts, then grant `owner`/`author`/`reviewer`/`publisher`/`viewer` roles — with multi-select resource grants. |
| 🖥️ **Mapping Editor** | A React + Vite visual editor that pairs ontology actions with ERP API mappings, with inline transformer specs and a live JSON preview. |
| 🧭 **Dual UI** | Web and Desktop frontends share one client package set, so a panel written once renders in both shells. |
| 🐍 **Python SDK** | A session-projected mirror of the TypeScript loop — the same `SessionEventMap`, the same expected outputs, and the same persistence format. |
| 🛡️ **Safety First** | Plugin-level sandboxing, a credential boundary, versioned session formats, structural validation before an ontology version is published, and an explicit safety notice before the first run. |

Access is decided before any page renders: without a signed session the index answers `303` to `/login`, and only `admin` sees the management surface:

<p align="center">
  <img src="./docs/assets/readme/local-access.svg" alt="Local sign-in gate, account directory, role check, and admin full access" width="100%" />
</p>

## 🧭 Architecture at a glance

<p align="center">
  <img src="./docs/assets/readme/architecture.svg" alt="OpenHarness architecture: frontends, harness core, and plugin seams" width="100%" />
</p>

One request crosses three layers, and nothing in the middle special-cases the ends:

- **Frontends** — the Vite + React Web client at `http://127.0.0.1:3080` and the Electron desktop shell share a single set of client packages: sidebar panels, tool cards, and settings are slot contributions.
- **Harness core** — the webserver and API inject the client module graph and serve the `auth` and `admin` routes, the agent loop owns model requests and tool calls, and the session log keeps every model-visible input reconstructable.
- **Capability seams** — shell, filesystem, web search, subagents, jobs, MCP, the ontology injector, the ERP connector, and the data-analysis bundle all attach without touching the loop.

## 🚀 Quick start

### Prerequisites

- Node.js ≥ **24.9.0**
- pnpm ≥ **11.28**

### Install & Run

```sh
git clone https://github.com/jeokeo011222/Openharness.git
cd Openharness
pnpm install
pnpm run build
pnpm run dev:web          # http://127.0.0.1:3080
```

One-command alternative if you already have a key:

```sh
DEEPSEEK_API_KEY=... pnpm dsh web
```

The first browser visit lands on `/login`; register an account there, or sign in with the administrator credentials configured in your profile's `cordis.patch.yml`.

## 📂 Monorepo layout

```
Openharness/
├── apps/
│   ├── web/              # Vite + React web client
│   └── desktop/          # Electron desktop wrapper
├── packages/             # 50+ workspace packages, grouped by concern
│   ├── core/             # Agent/session API
│   ├── llm/              # Model providers
│   ├── identity/         # Local account directory (SQLite) + admin routes
│   ├── ontology-injector/   # OWL/RDF → agent context + inference
│   ├── ...               # shell, fs, web, subagent, session, mcp…
│   └── experimental/     # capabilities without product-support commitment
├── data-analysis/        # dsh-data-analysis workbench bundle
├── erp-connector/        # Standalone ERP router (Yonyou / Kingdee adapters)
├── erp-workbench/        # The connector's product page: connections, mappings, test call
├── erp-mapping-editor/   # React + Vite visual mapping editor
├── ontology-store/       # Embedded RDF graph database (graph.db.nq) + uploaded sources
├── ontology-rag/         # Retrieval-augmented service over published ontologies
├── quadnest/             # dsh-quadnest: the four-companion micro-metaverse bundle
├── vendor/               # Vendored Cordis source (MIT, see vendor/README.md)
├── native/               # Node addon system
└── website/              # VitePress documentation
```

## 🛠️ Built with

- [Cordis](https://github.com/cordiverse/cordis) — spatiotemporal composability runtime
- [TypeScript](https://www.typescriptlang.org/) `strict: true`, ESM everywhere
- [oxigraph](https://github.com/oxigraph/oxigraph) — embedded RDF graph database holding ontologies
- [rdflib](https://github.com/linkeddata/rdflib.js) — embedded RDF/OWL parser for the Turtle vocabulary
- [Zod](https://zod.dev/) + [Schemastery](https://github.com/cordiverse/schemastery) — config validation
- [Vite](https://vite.dev/) + [Electron](https://www.electronjs.org/) — dual-frontend stack
- [pnpm workspaces](https://pnpm.io/workspaces) — monorepo

## ❓ FAQ

**Q: Is OpenHarness production-ready?** It is a developer preview: public APIs are pre-stable and versions can break between releases, so read the matching upgrade guide before upgrading.

**Q: Which model providers are supported?** Any provider with an OpenAI-compatible endpoint works through the DeepSeek SDK surface; native providers and remote BFF adapters live in `packages/llm/`.

**Q: Can I use OpenHarness without the ontology or ERP features?** Yes — the ontology injector, the ERP connector, and the analysis bundle are optional plugins. The base harness ships the plugin-first agent/session primitives and the full dual UI stack.

**Q: Where does my ERP data live?** OpenHarness stores no ERP records. The connector is a stateless router that delegates to configured adapters, and credentials stay in local `cordis.yml` overlays that are never committed.

## 🏷️ Keywords

Enterprise ontology · OWL/RDF · Knowledge graph · Data analysis · ERP connector · Yonyou U8 · Kingdee Cloud Galaxy · Ontology actions · Agent harness · MCP · Plugin architecture · TypeScript · Electron · Local accounts · RBAC · SQLite · Python SDK

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development conventions, gates, and the plugin authoring guide. Plugins, adapters, and documentation fixes are all welcome.

> Every new plugin declaration goes through `ctx.effect()`; every capability is a service definition, a service provider, and a consumer — never a hidden singleton.

## 🙏 Acknowledgements

Special thanks to **[DeepSeek](https://www.deepseek.com/)**.

OpenHarness is designed, built, and verified against DeepSeek's open models and API every day — the workbench you see above, every plugin panel, the ontology pipeline, and the ERP calls were all driven end to end by DeepSeek during development. Its fast, capable, and open model family is what makes a self-hostable enterprise agent harness practical instead of theoretical. 谢谢 DeepSeek！

## 📄 License

[Apache-2.0](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the vendored Cordis source under `vendor/` remains MIT, as its upstream authors licensed it.
