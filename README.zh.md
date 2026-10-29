<p align="center">
  <img src="./apps/web/public/logo.png" alt="OpenHarness" width="180" />
  <br />
  <strong>Ontology OpenHarness</strong>
</p>

<p align="center">

[![Node.js](https://img.shields.io/badge/Node.js-≥24.9.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-11.28+-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/jeokeo011222/Openharness/pulls)
[![GitHub stars](https://img.shields.io/github/stars/jeokeo011222/Openharness?style=social)](https://github.com/jeokeo011222/Openharness/stargazers)

</p>

<p align="center">

**以插件为核心的智能体运行时，本体知识注入 + ERP 连接器开箱即用。**

[English](README.md) · 中文

</p>

---

## ✨ 为什么选择 OpenHarness

每一个 AI 智能体都受限于上下文窗口。**本体 OpenHarness** 在运行时将 **结构化业务知识** 注入到智能体循环中——以 Turtle 语法解析 OWL/RDF 本体摘要，并通过嵌入式 OWL RL 推理增强——让智能体真正知道：有哪些实体、它们之间是什么关系、在你的 ERP 里去哪里调用它们。

运行时基于 **Cordis** 插件架构：每个能力都是注册 effect，每个声明都可组合，每个扩展点都不触及智能体循环源码。

## 🔥 核心特性

| 能力 | 它能做什么 |
|------|-----------|
| 🧩 **插件优先架构** | 插槽（slots）、瀑布监听器、服务、会话投影——全部通过 `ctx.effect()` 注册。扩展行为 = 加插件，不改 agent-loop。 |
| 📚 **本体注入器** | 按业务域（合同、采购……）解析 Turtle OWL/RDF，自动提取类 + 属性，在 pre-step 时注入智能体上下文。 |
| 🧠 **OWL RL 推理** | 嵌入式五规则推理器（子类传递、domain/range、TransitiveProperty 等），单次最长 5 秒，返回增强后的知识图谱。 |
| 🔌 **ERP 连接器** | Zod 配置校验 + 适配器注册表 + 值转换器管道。内置 **用友 U8（v13/v15）** 和 **金蝶云·星空** 适配器骨架。 |
| 🖥️ **映射编辑器** | React + Vite 可视化编辑器，本体行动 ↔ ERP API 映射，内联转换器参数编辑 + 实时 JSON 预览。 |
| 🧭 **双端 UI** | Web（默认 `http://127.0.0.1:3080`）+ Desktop（Electron），共用一套 client 包。 |
| 🐍 **Python SDK** | TypeScript 智能体循环的会话投影镜像——相同的 `SessionEventMap`、相同的 expected outputs、相同的持久化格式。 |
| 🔐 **安全优先** | 插件级沙箱、凭据边界、会话格式版本化、本体发布 SHACL 双重校验、首次运行前强制安全提示。 |

## 🚀 快速开始

### 环境要求

- Node.js ≥ **24.9.0**
- pnpm ≥ **11.28**

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

## 📂 仓库结构

```
Openharness/
├── apps/
│   ├── web/              # Vite + React Web 前端
│   └── desktop/          # Electron 桌面壳
├── packages/             # 50+ workspace 包，按能力分组
│   ├── core/             # Agent / Session API
│   ├── llm/              # 模型提供方
│   ├── shell/ | subprocess/ | ssh/ | terminal/
│   ├── fs/ | web/ | browser-use/ | computer-use/
│   ├── ontology-injector/   # 🆕 OWL/RDF → 智能体上下文 + 推理
│   ├── ...               # subagent、compaction、guard、session、mcp…
│   └── experimental/     # 未获产品承诺的实验性能力
├── erp-connector/        # 🆕 独立 ERP 路由包（用友 / 金蝶适配器）
├── erp-mapping-editor/   # 🆕 React + Vite 可视化映射编辑器
├── ontology-store/       # 🆕 本体 registry + versions/ + candidates/ 目录规范
├── vendor/               # 内置 Cordis 源码
├── native/               # Node addon 系统
└── website/              # VitePress 文档站
```

## 🛠️ 技术栈

- [Cordis](https://github.com/cordiverse/cordis) — 时空可组合运行时
- [TypeScript](https://www.typescriptlang.org/) `strict: true`，全程 ESM
- [rdflib](https://github.com/linkeddata/rdflib.js) — 嵌入式 RDF/OWL 解析 + 五规则 OWL RL 推理
- [Zod](https://zod.dev/) + [Schemastery](https://github.com/cordiverse/schemastery) — 配置校验
- [Vite](https://vite.dev/) + [Electron](https://www.electronjs.org/) — 双端前端栈
- [pnpm workspaces](https://pnpm.io/workspaces) — Monorepo

## ❓ 常见问题

**Q: OpenHarness 可以用于生产环境吗？**
当前处于 **开发者预览阶段**，公开 API 不稳定，版本间存在破坏性变更。升级前请查看对应版本的 Upgrade Guide。

**Q: 支持哪些模型提供方？**
任何支持 OpenAI 兼容协议的端点都能直接使用，通过 DeepSeek SDK 表面接入。原生提供方和远程 BFF 适配器位于 `packages/llm/`。

**Q: 不用本体和 ERP 功能可以吗？**
可以——本体插件和 ERP 连接器都是可选模块。基础 harness 提供插件优先的智能体/会话原语和完整的双端 UI 栈。

**Q: ERP 数据存在哪里？**
OpenHarness 不存储任何 ERP 记录。连接器是无状态路由层，全权委托给已配置的适配器。凭据只存在本地 `cordis.yml` overlay 中，不会被提交。

## 🤝 贡献

开发约定、门禁、插件编写指南详见 [CONTRIBUTING.md](CONTRIBUTING.md)。插件、适配器、文档修正——所有贡献均欢迎。

> 每个插件声明都通过 `ctx.effect()` 注册；每个能力都是服务定义 + 服务提供方 + 消费方三件套，绝不藏单例。

## 📄 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
