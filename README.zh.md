# Ontology OpenHarness

[English](README.md) | 中文

<p align="center">
  <img src="./apps/web/public/logo.png" alt="OpenHarness" width="180" />
  <br />
  <strong>Ontology OpenHarness</strong>
</p>

<p align="center">

[![Node.js](https://img.shields.io/badge/Node.js-≥24.9.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/) [![pnpm](https://img.shields.io/badge/pnpm-11.28+-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/jeokeo011222/Openharness/pulls) [![GitHub stars](https://img.shields.io/github/stars/jeokeo011222/Openharness?style=social)](https://github.com/jeokeo011222/Openharness/stargazers)

</p>

<p align="center">

**以插件为核心的智能体运行时：本体驱动的上下文注入、ERP 连接器与本地账号管理。**

</p>

---

## ✨ 为什么选择 OpenHarness

每一个智能体都受限于上下文窗口。**本体 OpenHarness** 给智能体的不只是一份可读的业务知识，而是一套**可通过它做事的本体**：Turtle 语法的 OWL/RDF 被解析为类与属性摘要供提示词使用；对象类型绑定到真实数据行，模型因此能查询对象；动作被声明出来，而模型只能「提议」——写操作必须由人批准。

内核之外是一套插件优先的运行时：客户端、工具、存储与模型提供方都是注册在既定扩展点上的 effect，新增能力 = 新增插件，而不是在智能体循环里再加一个分支。

## 🧭 架构一览

<p align="center">
  <img src="./docs/assets/readme/architecture.svg" alt="OpenHarness 架构：前端、核心与能力扩展点" width="100%" />
</p>

一次请求穿过三层，而中间层不会为任何一端做特例处理：

- **前端** — `http://127.0.0.1:3080` 上的 Vite + React Web 客户端与 Electron 桌面外壳共用一套 client 包：侧边栏面板、工具卡片与设置项都是插槽贡献。
- **核心** — webserver 与 API 负责注入客户端模块图并暴露 `auth`、`admin` 路由，智能体循环负责模型请求与工具调用，会话日志保证每一个对模型可见的输入都可重建。
- **能力扩展点** — shell、文件系统、Web 检索、子智能体、后台任务、MCP、本体注入器、ERP 连接器与 data-analysis 包都挂在这些扩展点上，不触碰循环本身。

## 🔥 核心特性

| 能力 | 它能做什么 |
|------|-----------|
| 🧩 **插件优先架构** | 插槽（slots）、瀑布监听器、服务、会话投影——全部通过已注册的 effect 实现。扩展行为 = 加插件，不改 agent-loop。 |
| 🔐 **本地账号** | 每个浏览器请求都必须携带已登录的本地账号，不再有平台账号可绑定。账号、角色与资源授权存放在 SQLite 目录中。 |
| 👑 **管理员工作台** | admin 角色绕过资源策略，并在侧边栏新增用户管理面板：创建、改名、重置密码、升降级、删除账号，并按工作区或会话授予 `owner`/`author`/`reviewer`/`publisher`/`viewer` 角色。 |
| 📚 **本体注入器** | 按业务域（合同、采购……）解析 Turtle OWL/RDF，提取类与属性摘要，在 pre-step 阶段注入智能体上下文。 |
| 🧱 **对象绑定** | 对象类型声明主键与字段映射，绑定 CSV 或 REST 数据源。一次同步是一个事务并保留运行历史，模型查的是对象而不是猜表结构。 |
| ⚡ **声明式动作** | 每个动作声明参数、声明式前置条件与副作用。模型只负责提议，人批准后才提交，且在提交时重新校验前置条件。 |
| 🔌 **ERP 连接器** | 独立的 Node 路由层：Zod 配置校验、适配器注册表与值转换器管道，内置 **用友 U8（v13/v15）** 与 **金蝶云·星空** 适配器骨架。 |
| 🖥️ **映射编辑器** | React + Vite 可视化编辑器，把本体动作与 ERP API 映射配对，内联转换器参数与实时 JSON 预览。 |
| 📊 **数据分析包** | `dsh-data-analysis` 配置包为 Web 客户端加入分析工具，并声明自己的侧边栏面板，因此这项能力以 bundle patch 的形式安装。 |
| 🧭 **双端 UI** | Web 与 Desktop 共用同一套 client 包，面板只写一次即可在两端渲染。 |
| 🐍 **Python SDK** | TypeScript 智能体循环的会话投影镜像——相同的 `SessionEventMap`、相同的 expected outputs、相同的持久化格式。 |
| 🛡️ **安全优先** | 插件级沙箱、凭据边界、会话格式版本化、本体发布前的结构校验，以及首次运行前的显式安全提示。 |

## 📚 本体注入流水线

<p align="center">
  <img src="./docs/assets/readme/ontology-pipeline.svg" alt="本体流水线：源文件、图数据库、推理、注入摘要与 ERP 调用" width="100%" />
</p>

业务知识只编译一次，却会在每一轮被读取：发布的本体先通过校验，再以 RDF 图的形式存储，并在第一个模型步骤之前被汇总进提示词。

- **源文件就是普通文件** — 每个业务域把自己的 Turtle OWL/RDF 文档放在项目里，上传后经结构校验写入图数据库。
- **图数据库是唯一事实来源** — `oxigraph` 持有 `graph.db.nq` 与上传的源文件，注入摘要每次请求都由图数据库重建，不靠手工编辑。
- **写操作必须有人** — 一份提案记录它要改的每个字段的前后值、每一条未满足的前置条件，以及受影响的关联对象。没有任何工具能替人批准。

## 🔐 本地账号与管理员工作台

<p align="center">
  <img src="./docs/assets/readme/local-access.svg" alt="本地登录闸门、账号目录、角色检查与管理员全量访问" width="100%" />
</p>

访问权限在页面渲染之前就已判定：只有携带已签名的本地会话，浏览器才能拿到应用；管理员在此基础上还会多出一个其他账号看不到的管理界面。

- **闸门是无条件的** — 没有有效会话 cookie 时，首页返回 `303` 跳转 `/login`；`/auth/login` 与 `/auth/register` 是仅有的本地表单，原有的 DeepSeek 平台登录已经移除。
- **目录掌握身份** — 账号、角色与授权存放在签名 cookie 背后的 SQLite 中；`/auth/state` 报告当前会话，`/admin/state` 报告工作台渲染的名册。
- **admin 即全部资源** — 远程访问策略对 admin 主体免除资源检查，只有会话携带该角色时，客户端才会把用户管理面板加入侧边栏。

## 🚀 快速开始

### 环境要求

- Node.js ≥ **24.9.0**
- pnpm ≥ **11.28**

<a id="install--run"></a>

### 安装运行

```sh
git clone https://github.com/jeokeo011222/Openharness.git
cd Openharness
pnpm install
pnpm run build
pnpm run dev:web          # http://127.0.0.1:3080
```

如果你已经有 API Key，一条命令即可：

```sh
DEEPSEEK_API_KEY=... pnpm dsh web
```

第一次浏览器访问会落在 `/login`：在那里注册账号，或用配置在 profile 的 `cordis.patch.yml` 里的管理员凭据登录。

## 📂 仓库结构

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
│   ├── identity/         # Local account directory (SQLite) + admin routes
│   ├── ontology-injector/   # OWL/RDF → agent context + inference
│   ├── ...               # subagent, compaction, guard, session, mcp…
│   └── experimental/     # capabilities without product-support commitment
├── data-analysis/        # Root-level dsh-data-analysis profile bundle
├── erp-connector/        # Standalone ERP router package (Yonyou / Kingdee adapters)
├── erp-mapping-editor/   # React + Vite visual mapping editor
├── ontology-store/       # Embedded RDF graph database (graph.db.nq) + uploaded sources
├── vendor/               # Vendored Cordis source
├── native/               # Node addon system
└── website/              # VitePress documentation
```

## 🛠️ 技术栈

- [Cordis](https://github.com/cordiverse/cordis) — 时空可组合运行时
- [TypeScript](https://www.typescriptlang.org/) `strict: true`，全程 ESM
- [oxigraph](https://github.com/oxigraph/oxigraph) — 承载本体的嵌入式 RDF 图数据库
- [rdflib](https://github.com/linkeddata/rdflib.js) — 嵌入式 RDF/OWL 解析，用于 Turtle 词汇
- [Zod](https://zod.dev/) + [Schemastery](https://github.com/cordiverse/schemastery) — 配置校验
- [Vite](https://vite.dev/) + [Electron](https://www.electronjs.org/) — 双端前端栈
- [pnpm workspaces](https://pnpm.io/workspaces) — Monorepo

## ❓ 常见问题

**Q: OpenHarness 可以用于生产环境吗？** 当前处于开发者预览阶段：公开 API 尚不稳定，版本之间存在破坏性变更，升级前请阅读对应版本的 upgrade guide。

**Q: 支持哪些模型提供方？** 任何支持 OpenAI 兼容协议的端点都能通过 DeepSeek SDK 表面接入；原生提供方与远程 BFF 适配器位于 `packages/llm/`。

**Q: 不用本体和 ERP 功能可以吗？** 可以——本体注入器与 ERP 连接器都是可选插件。基础 harness 提供插件优先的智能体/会话原语与完整的双端 UI 栈。

**Q: ERP 数据存在哪里？** OpenHarness 不存储任何 ERP 记录。连接器是无状态路由层，全权委托给已配置的适配器，凭据只存在本地 `cordis.yml` overlay 中，不会被提交。

## 🏷️ 关键词

智能体运行时（agent harness）· 本体 OWL/RDF · 知识图谱 · ERP 连接器 · 用友 U8 · 金蝶云·星空 · 本体动作 · MCP · 插件架构 · TypeScript · Electron · Web UI · 本地账号 · RBAC · SQLite · Python SDK

## 🤝 贡献

开发约定、门禁与插件编写指南详见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。插件、适配器与文档修正——所有贡献均欢迎。

> 每个插件声明都通过 `ctx.effect()` 注册；每个能力都是服务定义 + 服务提供方 + 消费方三件套，绝不藏单例。

## 📄 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
