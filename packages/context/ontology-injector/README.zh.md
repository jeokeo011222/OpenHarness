---
description: "业务域知识本体中心：图数据库存储、按轮摘要注入，以及用于生成、编辑与版本化本体的工作台。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ontology-injector

[English](README.md) | 中文

## 概述

`dsh-ontology-injector` 用内嵌 RDF 图数据库保存业务本体，每轮为已启用业务域注入一行索引，`domain_summary` 工具按需返回完整词汇。工作台生成、编辑、版本化、发布、校验并查询业务域；分析页签对实例批次运行六个合同指标；合规报告按规则统计 SHACL 违规数——例如缺少签约方标识的合同。检索页签完成三级召回、本体兼容性过滤与 SHACL 闸门，并展示溯源链。只有已发布版本会到达模型；单一根目录保存全部数据；摘要上限 4000 字符。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当模型需要在回答制度、订单或其他已命名业务域的问题之前掌握组织的业务词汇时，挂载此插件。注入每轮只发生一次：`agent/pre-step` waterfall 监听器先委托下游，跳过被拒绝或已中止的步骤，并在第 1 步追加一条 user 角色消息。默认 `injectionMode: mention` 只注入用户在输入框上方点选、因而出现在消息里的 `@<本体名>`；没有该标记的消息不注入任何内容，就是普通对话，也不会回退到 `defaultDomains`。`injectionMode: always` 才按 `defaultDomains` 顺序注入。没有已发布版本或已停用的业务域都会被跳过，同一会话同一轮不会收到两次注入。

### 模型能得到什么

每个注入块以 `## 业务域本体知识：<domain>` 开头，携带一行索引：业务域标签与 id、类、对象关系与数据属性的数量，以及取回完整词汇的 `domain_summary` 调用。模型调用该工具时，它读取已发布版本图并渲染 Markdown 摘要：`### 对象类` 列出类标签与本地名，`### 关键关系` 以 `Domain → label → Range` 列出对象属性，`### 数据属性` 列出数据属性及其范围本地名。各块包裹在 `<system-reminder>` 中，并合并为一条来源类型为 `ontology-injector` 的 user 角色消息，因此该索引保留在持久历史中。超过预算的工具文本在行边界处截断，并以截断后缀结尾。

### 在对话里选择本体

新会话页上它与「默认工作区」「标准模式」同处一行（对话开始后落在输入卡片上方），这一个下拉列出所有业务域，停用域置灰并说明原因，默认停在「不使用本体」。点选后草稿里插入 `@<本体名>`，再选「不使用本体」移除，换选则原地替换；当前的选中态由草稿文本推导，所以手删标记后也会自动回到「不使用本体」。宿主只认能匹配到已注册且未停用业务域 label 或 id 的 `@` 标记，其余 `@`（例如 `@README.md`）仍按文件路径交给文件引用提示；命中时该轮注入块首行会先声明「指这个本体域，不是文件路径」。因此业务域 label 必须唯一，重命名时冲突会被拒绝。

### 配置

最小挂载无需任何配置：默认模式下在对话里点选业务域即生效，`defaultDomains` 只对 `injectionMode: always` 有意义。抽取模型需要 `apiKey` 或 `DEEPSEEK_API_KEY`；其余字段都有默认值。

```yaml
- name: '@deepseek-ai/dsh-ontology-injector'
  config:
    defaultDomains: [policy]
    maxSummaryChars: 4000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `storePath` | 仓库 `ontology-store/` | 保存图镜像与各业务域源文件的根目录 |
| `defaultDomains` | `[]` | 按顺序去除首尾空白并去重、在第 1 步注入的业务域 id（仅 `always` 模式使用） |
| `injectionMode` | `mention` | `mention` 只注入消息里 `@` 选中的业务域；`always` 每轮按 `defaultDomains` 注入 |
| `maxSummaryChars` | `4000` | `domain_summary` 工具返回的摘要保留的最大字符数 |
| `model` | `deepseek-chat` | 通过 OpenAI 兼容端点调用的抽取模型 |
| `baseUrl` | `https://api.deepseek.com/v1` | 抽取所用的 chat-completions 端点 |
| `maxClauses` | `12` | 每次生成处理的条款分组数量；其余部分作为警告报告 |
| `maxSourceBytes` | `20971520`（20 MiB） | 接受的上传文件最大字节数 |
| `maxInstanceBytes` | `20971520`（20 MiB） | 接受的单次实例 Turtle 导入最大字节数 |
| `maxEvidenceChars` | `200` | 每个节点保存的条款文本字符数 |
| `apiKey` | `DEEPSEEK_API_KEY` | 抽取端点的 Bearer 令牌 |

### 存储布局

根目录由一个 Oxigraph 数据集支撑。它在首次使用时加载，并在每次变更后原子重写，在 `urn:dsh:ontology:` 词汇下保存四类命名图。上传的文档留在图之外，因为它们是二进制输入。

- `graph.db.nq`——持久数据集镜像；损坏的镜像会以 `corrupt-image` 显式失败，记录为更新格式版本的镜像会以 `schema-mismatch` 失败。
- `graph.db.lock`——单写者锁；持有者仍存活时写入会以 `ontology/busy` 失败，由已死 pid 留下或超过 60 秒的记录会被接管。
- `urn:dsh:ontology:registry`——格式版本、业务域注册表与各业务域元数据。
- `urn:dsh:ontology:audit`——仅追加的审计轨迹。
- `urn:dsh:ontology:graph:<domain>` 与 `urn:dsh:ontology:graph:<domain>:<version>`——实时图，以及每个版本一份不可变快照。
- `urn:dsh:ontology:graph:inst:<domain>:<batch>`——每个导入的实例批次一个命名图，替换或清除批次不会触碰本体与其快照。
- `urn:dsh:ontology:graph:shapes:<domain>`——每个域一个存放 SHACL 形状的命名图。形状与实时图分离，因为工作台编辑会经模型层重写实时图，而该层无法表示 SHACL 空白节点结构。
- `<domain>/sources/`——上传的文档，以时间戳前缀和净化后的文件名保存；删除业务域不会移除它们。
- `backups/`——由 `OntologyDatabase.backup()` 写入的镜像。

### 工作台

Web 客户端面板分为五个页签：业务域列表、图谱工作台、分析页签、检索验证与审计日志。头部右侧的作用域下拉把当前业务域带给每个页签——切换后各页签一致地只看这个域，不必回到列表页签重新选择。图谱工作台渲染图画布、节点检查器与版本面板，并在执行破坏性操作前确认。它通过 `ctx.remote.ontologyStore` 与 Host 服务通信，这些方法为 `listDomains`、`createDomain`、`updateDomain`、`deleteDomain`、`generate`、`getGraph`、`applyEdits`、`applyPatch`、`listVersions`、`submitReview`、`publishVersion`、`deleteVersion`、`diffVersions`、`exportDomain`、`importOntology`、`validateDomain`、`evaluateQuality`、`queryDomain`、`listMetrics`、`runMetric`、`explainMetric`、`drilldownMetric`、`listMetricBatches`、`importInstances`、`deleteInstanceBatch`、`importShapes`、`exportShapes`、`complianceReport`、`auditLog` 与 `health`。

生成、编辑、补丁与导入产生的图都是草稿。草稿只改变工作台渲染的工作图，永不改变注入摘要；`submitReview` 将其转为 `review`，`publishVersion` 把该快照复制为实时图并标记激活。重新发布较早的已发布版本即回滚路径，草稿在审核前不能发布。每个节点还记录来源条款与条款文本摘录，在检查器中显示为来源条款与文本。

### 分析

分析页签与 `list_metrics`、`run_metric`、`explain_metric` 三个工具都针对选中的业务域作答：指标目录由该业务域的实时本体生成，类与属性来自本体本身，而不是固定词汇表。每个指标编译为在业务域实例命名图上运行的 SPARQL，并按实例 IRI 去重，因此同一实例跨批次重复出现也不会放大计数。筛选值必须是本体声明的类或属性，并在进入 SPARQL 之前完成校验；无论从页签还是工具运行，每次运行都会追加一条 `metric-run` 审计。

| 指标 | 类型 | 单位 | 读取内容 |
|---|---|---|---|
| `instance-count` | scalar | count | `rdf:type`；可选按类筛选 |
| `class-distribution` | group | count | `rdf:type` |
| `property-coverage` | group | count | 本体声明的数据属性；可选按属性筛选 |
| `relation-coverage` | group | count | 本体声明的对象属性；可选按属性筛选 |
| `property-values` | group | count | `property` 指定的属性 |

`class` 与 `property` 接受本体声明的本地 id 或绝对 IRI；未设置 `property` 时 `property-values` 拒绝运行。被拒绝的筛选以 `analytics/invalid-filter` 失败，未知指标 id 以 `analytics/unknown-metric` 失败。覆盖率指标在对应种类属性未声明时回退到实例图中的谓词；指标没有匹配数据时返回空结果并给出警告，因此空存储不会被当成真实答案。

`importInstances(domain, turtle, batch)` 解析一份 Turtle 文档并写入 `urn:dsh:ontology:graph:inst:<domain>:<batch>`；批次 id 已存在时直接替换。文档必须可解析且至少声明一条三元组，超过 `maxInstanceBytes` 的导入以 `ontology/invalid-request` 失败，无法解析或为空则以 `instance/invalid-turtle` 失败。`listMetricBatches(domain)` 列出已存在的实例批次，`deleteInstanceBatch(domain, batch)` 删除一个批次并记录 `instance-clear`。读取分析需要 `viewer` 角色，导入需要 `author`，删除需要 `owner`。

### 运维命令

校验、审计、导出与健康检查是 Remote 方法，备份与恢复是库调用；没有专用的 CLI 子命令。

- `validateDomain(domain)` 返回类型化的错误与警告；错误覆盖无法解析的文本、空图、重复的类 IRI、缺失标签、无法解析的节点、缺失的定义域或值域、定义域与值域相同的属性，以及重复标签。
- `auditLog(limit)` 按从新到旧返回条目，包含动作、业务域、详情与时间；动作包括创建、更新、删除、导入、生成、编辑、补丁、提审、发布、激活、质量评估、指标运行、实例导入与实例清除。
- `exportDomain(domain, 'text/turtle')` 返回工作图 Turtle，`importOntology(domain, turtle, note)` 将其保存为新的草稿版本。
- `evaluateQuality(domain, goldTurtle, baselineName)` 用上传的基准文档比照工作图，返回类与属性的精确率、召回率及差异 id。
- `health()` 返回存储路径、持久格式版本与各业务域计数。
- `OntologyDatabase.backup()` 在 `<root>/backups/` 下写入镜像，`OntologyDatabase.restore(root, file)` 用它替换实时镜像；之后重启 Host，使缓存句柄重新加载。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释插件的设计；可观察行为见[使用本包](#use-this-package)。

### 设计理念

两个独立分层共享同一根目录。图数据库保存数据集，并负责持久化、加锁、格式版本检查与备份；业务域存储把注册表、元数据、实时图与版本快照映射到命名图。每轮索引与 `domain_summary` 工具都只读取已发布版本快照，因此未发布的草稿永远不会进入提示词：读取与草稿路径都经过同一份 `graph.db.nq` 镜像与锁。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：pre-step 监听器与 `ctx.remote.ontologyStore` 服务 |
| [`src/injector.ts`](src/injector.ts) | 一行索引、摘要缓存与注入信封 |
| [`src/tools.ts`](src/tools.ts) | 只读的 `domain_summary` 工具 |
| [`src/analytics-tools.ts`](src/analytics-tools.ts) | `list_metrics`、`run_metric` 与 `explain_metric` 工具 |
| [`src/analytics.ts`](src/analytics.ts) | 指标目录、过滤校验与去重 SPARQL |
| [`src/analytics-types.ts`](src/analytics-types.ts) | Host 与客户端面板共用的指标传输类型 |
| [`src/loader.ts`](src/loader.ts) | 供摘要脚本使用的遗留实时图读取器 |
| [`src/summary.ts`](src/summary.ts) | Turtle 到 Markdown 摘要渲染 |
| [`src/store.ts`](src/store.ts) | 注册表、元数据、实时图、版本、源文件、审计与 SPARQL |
| [`src/graph-db.ts`](src/graph-db.ts) | Oxigraph 句柄、镜像加载与持久化、锁、格式版本、备份与恢复 |
| [`src/model.ts`](src/model.ts) | 本体模型、Turtle 解析与输出、编辑、差异 |
| [`src/validate.ts`](src/validate.ts) | 结构校验报告 |
| [`src/quality.ts`](src/quality.ts) | 基准精确率与召回率 |
| [`src/generate.ts`](src/generate.ts) | 条款切分与模型抽取 |
| [`src/extract.ts`](src/extract.ts) | DOCX、PDF 与文本抽取 |
| [`src/client/`](src/client/index.ts) | Web 工作台面板：画布、检查器、版本、分析与审计 |

### 主要流程

在第 1 步，监听器逐个解析配置的业务域：确认业务域存在，读取元数据以遵守 `disabled`，加载已发布版本快照，渲染其摘要，并追加包裹后的一行索引。`domain_summary` 工具按需渲染同一摘要，并截断到预算。每个写入路径先以 `ontology/busy` 拒绝同业务域的并发写入，然后获取镜像锁、重新加载镜像、变更，并通过临时文件重命名持久化。

一次生成会写入上传的源文件、抽取文本、按条款标记切分、对每个条款以最多 6000 字符连同已有词汇调用一次抽取模型、通过 Host 输出器合并 JSON 答案，然后保存录制为草稿的快照，它同时成为工作图。失败的条款被记录并跳过；只有所有条款都失败时整次运行才失败。图编辑与增量补丁遵循相同的草稿快照路径；只有发布已审核快照才会改变模型读到的内容。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级参考不够用时阅读以下页面。

- [context 组地图](../README.zh.md)——相邻的请求上下文包及其职责。
- [架构](../../../docs/architecture.zh.md)——插件接缝、会话事件与 Host/Client 分工。
- [测试策略](../../../docs/testing.zh.md)——如何选择行为测试与录制会话快照。

-----

<a id="model-experience"></a>
## 模型体验

### 按轮本体摘要

#### 模型看到的内容

每轮追加一条 user 角色消息，每个注入的业务域包含一个 `<system-reminder>` 块；模型调用 `domain_summary` 把一行索引展开为完整词汇。

##### 注入消息

```markdown
<system-reminder>
## 业务域本体知识：policy

制度域（policy）：2 个类、2 条对象关系、1 个数据属性。需要完整词汇时调用 domain_summary 工具（domain="policy"）。
</system-reminder>
```

#### Token 影响

消息每轮添加一次，重复轮次会重发相同的索引行，直到压缩将其遮蔽。每行只占几十个字符；完整摘要受 `maxSummaryChars` 限制，仅在模型调用 `domain_summary` 时加入，因此每轮成本不再随本体规模增长。

#### KV Cache 影响

文本追加在可复用请求前缀之后。图未变化时摘要文本相同，早先缓存的前缀仍可使用；重新生成或编辑会改写文本，并使该消息之后的缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本体中心何时不合适。它们是当前包约束。

- **内存与重写成本**——整个数据集驻留内存，每次变更都重写镜像。本体越大，加载时间越长，即使单处编辑也要完整重写。
- **每个镜像一个写者**——并发进程在 `graph.db.lock` 上串行；持有者存活时表现为 `ontology/busy`，接管遵循 60 秒年龄阈值，而不是显式解锁。
- **仅散文摘要**——注入只携带标签、注释与定义域/值域的本地名。约束、基数与 OWL 推理永远不会到达模型，缺失标签时回退到本地名。
- **静默跳过**——缺失或禁用的业务域不产生块，也没有模型可见提示，因此配置错误的 `defaultDomains` 条目与空本体看起来相同。
- **`@` 标记在记录里显示成文件引用**——用户消息中的 `@<本体名>` 与文件引用共用 `@` 语法，转录视图会先用文件规则匹配它，点开会指向不存在的路径。本轮只保证宿主解析正确，专用外观与用户文本规则留待下一轮。
- **审核是流程，而非身份校验**——草稿必须提审后才能发布，但所有调用方共用同一工作台身份；没有逐用户审批或业务域所有权校验。
- **抽取限制**——生成需要 API key，只接受 DOCX、PDF、MD 与 TXT，每个条款截取 6000 字符，最多处理 `maxClauses` 个条款分组，并信任模型给出的名称与标签 JSON。每个节点最多保留 `maxEvidenceChars` 个字符的条款文本。
- **只读查询**——`queryDomain` 接受 SELECT 与 ASK，并以 `ontology/query-rejected` 拒绝 INSERT、DELETE、CLEAR、DROP 及其他更新形式；行是词法字符串，不带数据类型或语言标签。
- **分析依赖本体 IRI**——指标按实时本体声明的 IRI 匹配实例数据。实例使用了本体之外的 IRI 时，这些指标看不到它，`class` 或 `property` 筛选也无法指定它。
- **去重只看 IRI**——每个指标都按实例 IRI 合并行，因此两份确实不同但共享同一 IRI 的资源会被合并。
- **不做数值聚合**——指标只统计实例与属性取值，不对数值属性求和或求均值，也不计算金额合计。
- **实例导入仅支持 Turtle 且不校验本体**——`importInstances` 只解析文档并写入其中声明的全部三元组，按其他词汇写入的批次只会得到空指标；没有 CSV 或 Excel 读取器，也不在导入时拒绝。形状违规由 `complianceReport` 事后发现并按规则计数，但不阻断写入。
- **不支持降级**——记录为更新格式版本的镜像会被拒绝，且没有回退迁移路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

行为测试位于 `tests/`，使用系统临时目录下的 `mkdtemp` 根目录；它们从不写入仓库的 `ontology-store/`。用 `pnpm exec vitest run packages/context/ontology-injector/tests` 运行。

</details>
