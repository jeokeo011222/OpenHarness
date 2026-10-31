# 本体论下一步 · FDE 评审与路线图

> 评审对象：`packages/context/ontology-injector`（10.6k 行）、`ontology-store/`、`erp-connector/`、`erp-mapping-editor/`、`data-analysis/`
> 评审基准：Palantir Foundry / AIP 的 Ontology 四层模型（Object / Link / Action / Function）
> 结论日期：2026-10-31

---

## 0. 一句话结论

**T-Box（词汇层）已经过剩，A-Box（对象层）与 K-Box（动作层）为零。**

继续在本体编辑器上加功能，边际收益极低；下一个真正的里程碑是让 **agent 能查到对象、并提议修改对象**。如果只做一件事：做 Action Type + `propose` / `commit` 的人工确认闭环。

---

## 1. 现状：已经建成的东西（质量不低）

| 能力 | 位置 | 状态 |
|---|---|---|
| 域管理 / 版本 / 草稿→审核→发布 | `src/index.ts` | 完整，含互斥写锁 |
| 文档 → 本体生成（LLM 抽取） | `src/generate.ts`、`extract.ts` | 完整，支持 PDF |
| 图谱编辑 / 增量补丁 / diff | `src/model.ts`、`index.ts` | 完整 |
| 存储（oxigraph + 单文件 N-Quads） | `src/graph-db.ts` | 完整，跨进程单写锁 + 原子重写 |
| 结构校验 | `src/validate.ts` | 完整（**非** SHACL） |
| 质量 P/R 评估 | `src/quality.ts` | 完整，但依赖人工上传 gold standard |
| 只读 SPARQL | `src/store.ts` | 完整 |
| 域级 ACL（viewer/author/reviewer/publisher/owner） | `src/acl.ts` | 完整 |
| 审计日志（18 类动作） | `src/types.ts` `AUDIT_ACTIONS` | 完整 |
| Agent 上下文注入 | `src/injector.ts` | 只注入"一行索引" |
| Agent 工具面 | `src/tools.ts`、`analytics-tools.ts` | **4 个，全部只读** |
| 指标分析 | `src/analytics.ts` | 5 条硬编码指标，全部 `unit: 'count'` |

这一层在开源项目里属于上游水平。**问题不在质量，在位置。**

---

## 2. 与 Palantir 本体论的对照：缺的恰好是"值钱的那三层"

| Palantir 层 | 本质 | 本项目 | 缺口 |
|---|---|---|---|
| **Object Type** | 实体定义 **+ 主键 + 数据源绑定 + 属性→字段映射 + 同步** | `owl:Class`（Turtle 里的一个标签） | 无绑定、无主键、无同步、无刷新水位 |
| **Link Type** | 两对象类型之间的连接 **+ join 语义 + 基数** | `owl:ObjectProperty` 的 `domain/range` 约束 | 有"能连"，没有"怎么连出来" |
| **Action Type** | 可写回的业务动作：参数 / 前置条件 / 副作用 / 权限 / 审批 | **不存在**（`AUDIT_ACTIONS` 只是审计日志分类） | 完全缺失 |
| **Function** | 动作与回写里的计算逻辑 | 不存在 | 完全缺失 |
| Application | 面向业务人员的应用（Workshop） | 本体工作台（面向本体工程师） | 面向业务端的应用层缺失 |
| AIP / Agent | LLM 通过对象与动作操作业务 | 只读到"类/属性文字摘要" | **只能读词表，不能查对象、不能做动作** |

**这就是问题的全部**：本项目建成了 Palantir 的"描述层"，但 Palantir 的护城河在"**绑定层 + 动力层**"。

Palantir 本体的价值不取决于本体本身多完整，而取决于**被引用次数**——同一份定义同时驱动数据接入、权限、动作、应用、AI。当前它只被"注入"引用了一次，引用次数 = 1。

---

## 3. 三个会杀死项目的具体缺陷（按严重度）

### 3.1 语义漂移已经发生，且无任何拦截机制

`ontology-store/contract/ontology.ttl` 里同时存在：

```turtle
store:Contract  a owl:Class ; rdfs:label "合同（微调）" .
store:Contract2 a owl:Class ; rdfs:label "合同（二次微调）" .
```

版本 `1.0.1` 的 note 是 `Graph edit (1 operations)`。

- 没有别名 / `sameAs` / 合并操作；
- 没有"新建前做近义检测"；
- 没有回归集，`quality.ts` 要求人工上传 gold standard 才能发现。

本体类项目的头号死因就是"同一个概念三个 id"。规模到几百个类时，注入摘要会自相矛盾，模型的回答开始不稳定，而**你看不到它正在变坏**。

### 3.2 动力层悬空：三处都在假设一个不存在的东西

- `erp-connector/src/types.ts:96`：`action: "Ontology action identifier, e.g. queryPurchaseOrders"`
- `erp-mapping-editor`：整块 UI 在做"把本体动作与 ERP API 配对"
- `README.zh.md:27`：*"模型知道……每个动作在你的 ERP 里暴露在哪里"*

而本体模型里（`src/types.ts:9`）只有 `class | object-property | datatype-property`——**没有"动作"这个实体**。

结果是：连接器、映射编辑器、README 三处都指向一个空位。这是全项目最贵的断裂，也是投入产出比最高的一处补口。

### 3.3 文档宣称 > 代码实现（demo 当场会爆的那种）

| README 宣称 | 代码事实 |
|---|---|
| "嵌入式五规则 OWL RL 推理器（子类传递、domain/range、`TransitiveProperty`），5 秒预算"（`README.zh.md:27/51/69/140`） | `grep -rn "reasoner\|entail\|infer" src/` **零命中**；`validate.ts:4` 自述 *"without an external reasoner"* |
| "本体发布的 SHACL 双重校验" | `grep -rn "shacl\|shapes" src/` **零命中**；`shapes.ttl` 文件存在但无代码引用 |

客户/评审第一件事就是验证 demo。"说的比做得多"在本体项目里是最贵的债——因为**本体本身就是一个"承诺"**，承诺失真等于整个方法论失信。

**建议**：这两条要么 4 周内实现，要么立刻从 README 删除并改称"结构校验"。我倾向于后者（见 §6"不做"）。

---

## 4. 战略判断：为什么现在不该继续做 T-Box

1. **T-Box 已过剩**：版本、审核、发布、审计、质量、SPARQL、ACL 全都有，再加一个"类继承可视化"不会带来任何新用户价值。
2. **注入路径已经封顶**：`injector.ts` 每轮只注入一行索引（`domainIndexLine`），完整摘要走 `domain_summary` 工具按需读。这个设计是**对的**（省 token），但它同时意味着——**模型对本体的消费上限就是"读一段文字"**。想提高本体价值，只能提高"消费方式"，不能提高"文字量"。
3. **分析层是硬编码的假象**：`analytics.ts:306` 的 `METRICS` 是 5 条写死的 `count` 指标，注释说"新域发布后就有自己的目录"，实际只是同一批 count 换了个 class 名。这不是"对象分析"，是"罐头查询"。客户第三个问题（"我能自己按任意字段分组吗"）会立刻打穿它。

---

## 5. 路线：一条竖切，四步，每步可演示

**选场景：采购订单 → 合同。** 理由：已有 `contract` / `procurement` / `pilot-procurement` 三个域，有 U8 / 金蝶适配器骨架，映射编辑器里已经有 `queryPurchaseOrders` 这类动作名。素材齐了，缺的只是"把它们串成一条线"。

### Step 1｜对象落地：把 Object Type 绑到真实数据上（1–2 周）

新增概念：

```ts
ObjectTypeBinding = {
  domain: 'procurement',
  objectType: 'PurchaseOrder',
  primaryKey: 'poNumber',                    // 稳定、不可变
  datasource: { kind: 'csv' | 'rest' | 'sql', ref: ... },   // 凭据走 credentials，配置只放引用名
  properties: [
    { name: 'amount',   column: 'AMOUNT',  type: 'decimal', filterable: true,  searchable: false },
    { name: 'supplier', column: 'SUP_NAME', type: 'string',  filterable: true,  searchable: true  },
    { name: 'signedAt', column: 'SIGN_DATE', type: 'date',   filterable: true,  searchable: false },
  ],
}

SyncRun = { id, mode: 'full' | 'incremental', watermark, rows, durationMs, failedReason?, finishedAt }
```

关键决定：

- **对象 ID 一律 `{domain}:{objectType}:{primaryKey}`**，此后永不改。这是后面动作、审计、lineage 全部能对齐的前提。
- **A-Box 存 SQLite，不存 RDF**。`packages/storage/storage-sqlite` 已经在用 `node:sqlite`，零新依赖。一个 Object Type 一张表，主键索引 + 可过滤列索引。
- **绑定元数据不进 Turtle**。`primaryKey` / `column` / `endpoint` 是**部署配置**（随客户环境变、要进 secrets、要能 diff），放 `bindings.json` 或独立命名图；`owl:Class` 里只留 `label` / `comment`。现在这套代码最容易搞混的就是这一点。

**验收（必须能当场演示）**：导入一张真实采购订单表（≥1 万行）→ 同步 → 界面显示 `lastSyncedAt` 与行数 → `get_object` 按主键返回 → `search_objects` 按"金额 > 500 万 且 未签署"返回前 50 条引用。

### Step 2｜对象工具面：让 agent 从"读词表"变成"查对象"（1 周）

四个工具，全部带权限与预算：

```
search_objects(domain, objectType, filters[], limit <= 50)
  → { total, items: [{ id, label, amount, supplier, signedAt }] }     # 引用，不是行集
get_object(domain, objectType, id)
  → 全属性 + 一层 link 摘要（合同? 供应商? 付款?）
traverse_links(domain, fromId, linkType, direction, limit)
  → 邻接对象引用列表
aggregate_objects(domain, objectType, groupBy?, metric, filters[])
  → 聚合数字，永不返回行
```

设计红线（这几条决定 agent 表现好坏）：

1. **只返回"引用"**：id + 3–5 个关键属性，逼模型下钻而不是一次拉全表。
2. **总是返回 `total`**：让模型知道"还有多少"，这是它决定是否继续过滤的唯一依据。
3. **每次调用写审计**：谁、查了什么、返回几行。这是"数据使用可见性"的最小版本，也是卖产品时的第一个合规问题。
4. **`domain_summary` 升级**：从"类/属性文字摘要"改为"**对象类型清单 + 可查字段 + 可用动作**"。模型需要的是"我能查什么、能做什么"，不是"本体长什么样"。

**验收**：模型回答"上季度华东区采购额超 500 万、且还没签合同的订单有哪些"，全程只用对象工具，不写 SQL / SPARQL，答案里每个对象带可点 id。

### Step 3｜Action Type + propose/commit（2 周，最高价值）

```ts
ActionType = {
  id: 'approvePurchaseOrder',
  targetObjectType: 'PurchaseOrder',
  parameters: [{ name: 'comment', type: 'string', required: false }],
  // 声明式前置条件，禁止 LLM 生成代码
  preconditions: [
    { kind: 'equals', property: 'status', value: 'pending-approval' },
    { kind: 'lessThan', property: 'amount', value: 10_000_000 },
    { kind: 'linkExists', linkType: 'hasContract' },   // 必须是"已存在"而不是"应该存在"
  ],
  effects: [
    { kind: 'set-property', property: 'status', value: 'approved' },
    { kind: 'call-connector', mapping: 'u8.approvePO' },   // ← 这里终于接上 erp-connector
    { kind: 'create-object', objectType: 'ApprovalRecord' },
  ],
  permission: 'author',
  approval: 'manager' | 'none',
}
```

两个工具，一条不可逾越的边界：

- `propose_action(domain, actionId, targetId, params)` → 返回**动作提案**：将改哪些属性（before/after 对照）、哪条前置条件不满足、影响哪些下游对象、需要谁批。**绝不执行。**
- `commit_action(proposalId, approvalToken)` → 人确认后执行：调连接器 → 回写对象 → 写审计 → 留存快照（可回滚）。

这条边界的价值远大于"安全"三个字：

| 解决的问题 | 怎么解决 |
|---|---|
| 安全 | 写操作有闸门，模型永远无法直接改数据 |
| 可信 | 提案里是 before/after 对照，人能一眼核对 |
| 合规 | 审计记录"谁批的、什么时候、依据什么、ERP 返回什么" |
| 可调试 | 前置条件不满足时，错误信息是**业务的**（"该订单已签署，不可再次审批"），不是 HTTP 500 |

同时把 `erp-connector` 从 standalone 包提升为 workspace 包，成为 `call-connector` effect 的唯一执行器。**这一步做完，"本体动作"这个说法才第一次成立。**

**验收**：审批一笔采购订单全链路——agent 提案 → 面板显示 before/after 与前置检查 → 人批准 → 连接器调用（先 mock 适配器）→ 对象状态回写 → 审计里完整一条（含 proposal id 与 ERP 原始响应）。

### Step 4｜治理（1 周，可与 Step 3 并行）

- **对象级 ACL**：现有 `acl.ts` 是域级 role。补 `marking`（对象类型级 / 属性级）与 `rowFilter`（声明式表达式 → 编译成 SQL WHERE）。多租户隔离靠它，卖产品也靠它。**新工具必须同时登记进 `READ_ACTIONS` / `WRITE_ACTIONS`，否则会绕过权限。**
- **Lineage**：对象 → 数据集 → 同步批次 → 源表/API → 源文档条款。T-Box 侧已有 `source` / `sourceText` 条款溯源（这一点做得比大多数开源方案都好），把它延伸到实例，**别丢**。
- **回归门禁**：把 `quality.ts` 的人工 gold standard 变成固定回归集 + CI 门禁（新版本对回归集的 P/R 不得低于基线 −1%）。语义漂移无法靠人眼看出来，只能靠回归集。

---

## 6. 架构落位（具体到包与文件）

| 决定 | 方案 | 理由 |
|---|---|---|
| 代码放哪 | 新建 `packages/context/ontology-objects`（或先做 workspace bundle） | 词汇与对象的**发布/部署边界不同**：词汇随业务演进，对象随客户环境变。塞进同一个包会让核心包随客户数膨胀 |
| 怎么复用 | 通过 `ctx.remote.ontologyStore` 调现有域/版本/审计/ACL，不复制 | 单一事实来源 |
| T-Box 存储 | oxigraph + `graph.db.nq`，**不动** | 几千三元组，够用 |
| A-Box 存储 | **SQLite（`node:sqlite`）**，一处表一个 Object Type | `graph-db.ts:6` 自述"每次变更后原子重写全量镜像"——这个模型在百万对象下会直接卡死。这是当前最明确的规模墙 |
| 绑定元数据 | `bindings.json` / 独立命名图，**不进 OWL** | 配置与词汇生命周期不同 |
| 工具注册 | 沿用 `tools.ts:24` 的 `defineTool` + `ctx.tools.register` | 与现有注入、审计、ACL 一致 |
| 前端 | 沿用 `client/index.ts` 的 slot 注册，新增"对象浏览器" + "提案收件箱"两个视图 | 不动已有 Workbench |

**注意与仓库宪法的冲突**：`修改/00-project-constitution.md` 第 1 条要求"不修改 `packages/`"，但同时要求"一个能力域一个 bundle"、"零依赖优先"。所以推荐走 bundle 形态先行，等对象层稳定后再决定是否上游进 `packages/`。

---

## 7. 明确不做（这一节和路线图同等重要）

1. **OWL RL 推理器**。Palantir 根本不用推理器。客户要的是"查得到、改得动、可追溯"，不是"能推出新的三元组"。README 里这条建议直接删，或降级为"结构校验"。**这是省下来的最大一笔预算。**
2. **自研图数据库 / 图算法 / 知识图谱可视化炫技**。瓶颈从来不在引擎，在绑定与动作。
3. **多 ERP 适配器铺量**。先把 U8 的一条主线（采购订单）打通，其余等真实客户出现。
4. **继续优化"文档 → 本体"全自动生成**。在对象层没有对应物之前，它只是把一条死路修得更平。
5. **往 Turtle 里塞绑定元数据**。会立刻把词汇层和部署层耦合死。

---

## 8. 三个北极星指标（防止"功能做完就完了"）

| 指标 | 定义 | 健康线 |
|---|---|---|
| **本体被引用率** | 每个 Object Type 被多少 action / tool / metric 引用 | < 2 的是死类型，应删 |
| **动作闭环率** | 提案 → 批准 → 执行成功占比；以及人工驳回率 | 驳回率高 = 前置条件写得不对 |
| **可追溯引用率** | 模型回答里带对象 id / 条款号的比例 | 这是幻觉的直接对立面；现有 `source` 机制已具备统计基础 |

---

## 9. 四周排期（单人）

| 周 | 交付 | 可演示的东西 |
|---|---|---|
| W1 | `ObjectTypeBinding` + SQLite A-Box + 同步（CSV 优先，REST 次之） | 1 万行采购订单同步完成，界面显示行数与 `lastSyncedAt` |
| W2 | 4 个对象工具 + `domain_summary` 升级 + 对象浏览器面板 | 一句话问出"超 500 万未签署订单"，结果带可点 id |
| W3 | `ActionType` 模型 + propose/commit + 提案收件箱（连接器走 mock） | 一笔订单从提案到批准的全链路，含 before/after 对照 |
| W4 | `erp-connector` 归位 + 真实适配器一条链路 + 审计/回滚 + 回归门禁骨架 | 同一条链路打真实 ERP（或沙箱） |

---

## 10. 如果只能做一件事

**做 Step 3：Action Type + propose/commit。**

因为它是"本体"从**文档**变成**业务系统**的唯一分界线，也是 agent 从"会说"变成"会做"的唯一分界线。没有它，前面所有工作都只是"更漂亮的文档"；有了它，那份 OWL 才第一次真正参与到业务的因果链里。

而它恰好只需要两周，且能立刻吃掉三笔已有的沉没成本：`erp-connector` 的适配器骨架、`erp-mapping-editor` 的映射 UI、README 里那句悬空的"每个动作在你的 ERP 里暴露在哪里"。

---

## 11. 实施记录（2026-10-31）

本节记录按本文档落地的第一个增量：**一条竖切——对象层 + 工具面 + 动作闭环**。范围刻意压在一处，不做横向铺开。

### 11.1 改动清单

新增（`packages/context/ontology-injector/`）：

| 文件 | 作用 |
|---|---|
| `src/objects/types.ts` | 对象层线格式：绑定、引用、同步、关联、动作、提案 |
| `src/objects/csv.ts` | 零依赖 CSV 解析（引号、转义、CRLF、BOM） |
| `src/objects/db.ts` | `objects.db`（SQLite / `node:sqlite`），全部 SQL 与事务边界 |
| `src/objects/sync.ts` | 从 CSV / REST 同步，全量与增量（水位），一次事务 |
| `src/objects/query.ts` | 引用式读路径：search / get / traverse / aggregate |
| `src/objects/actions.ts` | 声明式前置条件、提案、人工决策、提交时复检 |
| `src/objects/tools.ts` | 7 个 agent 工具（5 读 2 写） |
| `src/objects/index.ts` | 对外单一出口 + 注入用的一行对象索引 |
| `scripts/objects-cli.ts` | 运维 CLI：绑定、同步、提案、批准、提交 |
| `tests/objects.spec.ts` | 20 个用例覆盖上述全部路径 |
| `examples/procurement/` | 可复现的采购订单示例（CSV + bindings + 步骤说明） |

修改：

| 文件 | 改动 |
|---|---|
| `src/index.ts` | 注册对象工具；注入行追加「可查对象 / 可执行动作」 |
| `src/types.ts` | `AUDIT_ACTIONS` 增加 `object-sync`、`action-propose`、`action-commit` |
| `src/validate.ts` | 新增近义重复检测（`near-duplicate-label`、`counter-suffixed-id`） |
| `src/client/locales.ts`、`panels.tsx` | 三种新审计动作的 8 语言文案与映射 |
| `tsconfig.host.json` | 纳入新源文件 |
| `README.md`、`README.zh.md` | 删除推理器 / SHACL 的失实宣称，改写为对象与动作能力 |

### 11.2 关键设计决定

1. **A-Box 用 SQLite，T-Box 留 RDF**。`graph.db.nq` 每次变更全量原子重写，几千三元组没问题，百万对象会卡死。对象走 `objects.db`，一个文件装下所有域的绑定、行、同步历史与提案。
2. **绑定是部署配置，不进 Turtle**。主键、列映射、数据源地址随客户环境变化，进 `bindings.json`；`owl:Class` 只留词汇。
3. **工具只返回引用**。`search_objects` 给 id + 标签 + 少量字段 + 未分页总数，绝不给行集；上限 50。模型因此下钻而不是把表搬进上下文。
4. **模型只能提议，人才能批准**。`propose_action` 写提案不写数据；`commit_action` 要求状态已是 `approved`，而**没有任何工具能把提案改成 approved**。批准发生在 CLI（未来是工作台），并记录批准人。
5. **提交时复检前置条件**。世界可能在「人批准」与「提交」之间变化，所以提交重新求值，不信任提案时的结论；失败则提案转 `failed` 且不写任何字段。
6. **连接器副作用如实标记为 deferred**。`call-connector` 尚未接线，提交结果里写明「已记录、待接线执行」，不伪造成功。

### 11.3 已验证 / 未验证

已验证（可复现）：

- `npx vitest run packages/context/ontology-injector/tests` → **12 个文件 / 118 个用例全通过**（新增 23 个：对象层 20 + 近义重复 3）。
- `npx tsc -b packages/context/ontology-injector/tsconfig.host.json` 与 `tsconfig.client.json` → 均无错误。
- `npx tsx scripts/run-oxlint.ts packages/context/ontology-injector` → 0 warning / 0 error。
- `npx pnpm --filter @deepseek-ai/dsh-ontology-injector run bundle` → host 253 kB、client 213 kB 均构建成功。
- CLI 端到端实测（`examples/procurement`）：`apply` → `sync`（3 订单 / 2 供应商）→ `propose` 命中「超过一千万需要走招标流程」→ 未批准 `commit` 被拒 → `approve alice` → `commit` 成功 → 数据库内 `PO-1001.status` 由 `pending` 变为 `approved`，`PO-1003` 保持 `pending`。

未验证 / 未实施（如实列出）：

- **Remote 端点与工作台面板未接线**。审批目前只有 CLI，没有可视化「提案收件箱」。新增 `@Remote` 方法需要重跑 Typert 生成，本轮刻意避开以缩小改动面。
- **`call-connector` 副作用未执行**；`erp-connector` 仍是独立包，未成为 workspace 成员。
- **对象级 ACL 未做**：工具走的是工具权限面，不经过 `acl.ts` 的 Remote 动作表（与既有的 `domain_summary` 一致），因此写操作的当前边界是「人批准」而不是身份权限。对象级 / 属性级 marking 仍需在 Remote 层补。
- **实例级 lineage 未做**：对象只记 `syncedAt` / `runId`，没有到源表行与条款的回溯链。
- **回归集门禁未做**：近义重复检测只是告警，不阻断发布。
- **视觉未验证**：本轮没有打开 Web 界面确认注入行的实际渲染。

### 11.4 下一步（按优先级）

1. 给对象工具补上 ACL（`acl.ts` 增加 `object-read` / `object-write` 动作），否则多账号环境里写权限形同虚设。
2. 接 Remote 端点 + 「提案收件箱」面板，把批准从 CLI 搬到工作台——这是本增量唯一还缺的可用性环节。
3. `erp-connector` 提升为 workspace 包，作为 `call-connector` 的唯一执行器；先接一个 mock 适配器打通端到端，再接真实 U8 沙箱。
4. 对象 → 数据集 → 同步批次 → 源条款的 lineage 面板。
5. 把 `quality.ts` 的人工 gold standard 换成固定回归集 + CI 门禁，让语义漂移从「告警」升级为「阻断」。
