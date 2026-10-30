# Ontology OpenHarness

English | [中文](README.zh.md)

<p align="center">
  <img src="./apps/web/public/logo.png" alt="OpenHarness" width="180" />
  <br />
  <strong>Ontology OpenHarness</strong>
</p>

<p align="center">

[![Node.js](https://img.shields.io/badge/Node.js-≥24.9.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/) [![pnpm](https://img.shields.io/badge/pnpm-11.28+-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/jeokeo011222/Openharness/pulls) [![GitHub stars](https://img.shields.io/github/stars/jeokeo011222/Openharness?style=social)](https://github.com/jeokeo011222/Openharness/stargazers)

</p>

<p align="center">

**A plugin-first agent harness with ontology-powered context injection and ERP connectors.**

</p>

---

## ✨ Why OpenHarness

Every AI agent is context-limited. Ontology OpenHarness injects **structured business knowledge** into the agent loop at runtime — as Turtle-parsed OWL/RDF summaries, augmented by lightweight OWL RL inference — so your agent knows *what* entities exist, *how* they relate, and *where* to call them in your ERP.

Built on **Cordis**, an everything-is-a-plugin runtime where every capability is an effect, every declaration is composable, and every surface is extensible without changing the agent loop itself.

## 🔥 Core Features

| Capability | What it does |
|------------|--------------|
| 🧩 **Plugin-First Architecture** | Every seam — slots, waterfall listeners, services, projections — is a registered effect. No agent-loop code changes to extend behavior. |
| 📚 **Ontology Injector** | Parse Turtle OWL/RDF per business domain (contracts, procurement…), summarize classes + properties, inject into agent context at pre-step. |
| 🧠 **OWL RL Inference** | Five-rule embedded reasoner (subclass transitivity, domain/range, TransitiveProperty…) runs in 5 s max and augments the injected summary. |
| 🔌 **ERP Connector** | Standalone Node router with Zod schema, adapter registry, and transformer pipeline. Ships skeletons for **Yonyou U8 (v13/v15)** and **Kingdee Cloud Galaxy**. |
| 🖥️ **Mapping Editor** | React + Vite visual editor pairing ontology actions ↔ ERP API mappings with inline transformer specs and live JSON preview. |
| 🧭 **Dual UI** | Web (`http://127.0.0.1:3080`) and Desktop (Electron) frontends, sharing a single client package set. |
| 🐍 **Python SDK** | Session-projected mirror of the TypeScript agent loop — same `SessionEventMap`, same expected outputs, same persistence format. |
| 🔐 **Safety First** | Plugin-level sandbox, credential boundary, session format versioning, SHACL double-verify for ontology publishes, and an explicit safety notice before first run. |

## 🚀 Quick Start

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

## 📂 Monorepo Layout

```
Openharness/
├── apps/
│   ├── web/              # Vite + React web client
│   └── desktop/          # Electron desktop wrapper
├── packages/             # 50+ workspace packages, grouped by concern
│   ├── core/             # Agent/session API
│   ├── llm/              # Model providers
│   ├── shell/ | subprocess/ | ssh/ | terminal/
│   ├── fs/ | web/ | browser-use/ | computer-use/
│   ├── ontology-injector/   # 🆕 OWL/RDF → agent context + inference
│   ├── ...               # subagent, compaction, guard, session, mcp…
│   └── experimental/     # capabilities without product-support commitment
├── erp-connector/        # 🆕 Standalone ERP router package (Yonyou / Kingdee adapters)
├── erp-mapping-editor/   # 🆕 React + Vite visual mapping editor
├── ontology-store/       # 🆕 Embedded RDF graph database (graph.db.nq) + uploaded sources
├── vendor/               # Vendored Cordis source
├── native/               # Node addon system
└── website/              # VitePress documentation
```

## 🛠️ Built With

- [Cordis](https://github.com/cordiverse/cordis) — spatiotemporal composability runtime
- [TypeScript](https://www.typescriptlang.org/) `strict: true`, ESM everywhere
- [oxigraph](https://github.com/oxigraph/oxigraph) — embedded RDF graph database holding ontologies
- [rdflib](https://github.com/linkeddata/rdflib.js) — embedded RDF/OWL parser + 5-rule OWL RL inference
- [Zod](https://zod.dev/) + [Schemastery](https://github.com/cordiverse/schemastery) — config validation
- [Vite](https://vite.dev/) + [Electron](https://www.electronjs.org/) — dual-frontend stack
- [pnpm workspaces](https://pnpm.io/workspaces) — monorepo

## ❓ FAQ

**Q: Which model providers are supported?** Any provider with an OpenAI-compatible endpoint works out of the box via the DeepSeek SDK surface. Native providers and remote BFF adapters live in `packages/llm/`.

**Q: Can I use OpenHarness without the ontology or ERP features?** Yes — the ontology plugin and ERP connector are optional modules. The base harness ships with plugin-first agent/session primitives and the full dual UI stack.

**Q: Where does my ERP data live?** OpenHarness does not store ERP records. The connector is a stateless router that delegates to configured adapters. Credentials stay in local `cordis.yml` overlays, never committed.

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development conventions, gates, and the plugin authoring guide. All contributions — plugins, adapters, documentation fixes — are welcome.

> Every new plugin declaration goes through `ctx.effect()`; every capability is a service definition + service provider + consumer, never a hidden singleton.

## 📄 License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
