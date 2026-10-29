我无法直接生成可下载的文件附件，但可以把完整的 Markdown 文档内容给你。你复制下面全部内容，粘贴到任意文本编辑器（VS Code、记事本均可），保存为 `harness-ontology-vibe-coding-prompts.md` 即可。

---

```markdown
# DeepSeek Harness 本体注入插件 — Vibe Coding 提示词手册

> 适用场景：基于 DeepSeek Harness 开发企业 Agent 本体层（OWL/RDF/SHACL/Turtle），
> 通过 `agent/pre-step` 事件按会话业务域注入本体摘要。
> 当前阶段不涉及 ERP 对接。

---

## 目录

- [使用说明](#使用说明)
- [阶段零：项目启动约束](#阶段零项目启动约束)
- [阶段一：插件骨架 + 最小加载验证](#阶段一插件骨架--最小加载验证)
- [阶段二：本体存储与加载](#阶段二本体存储与加载)
- [阶段三：agent/pre-step 注入逻辑](#阶段三agentpre-step-注入逻辑)
- [阶段四：Turtle 提取流水线](#阶段四turtle-提取流水线)
- [阶段五：版本管理与 SHACL 校验 CLI](#阶段五版本管理与-shacl-校验-cli)
- [贯穿全程的追加提示词](#贯穿全程的追加提示词)
- [需要提前注意的坑](#需要提前注意的坑)
- [附录：文件布局与验收清单](#附录文件布局与验收清单)

---

## 使用说明

本手册按开发阶段组织，每个阶段包含一段可直接粘贴给 AI 的提示词和验收标准。

**使用方法：**
1. 每次新开对话，先粘贴【阶段零】的约束。
2. 按阶段顺序推进，一个阶段验收通过再进入下一阶段。
3. 每个阶段的提示词末尾都要求 AI“先说明思路再写代码”，请务必等它说明后再放行。
4. 遇到报错或代码不满意时，使用【贯穿全程的追加提示词】中的片段。

**核心原则：**
- 约束写死在提示词里，压缩 AI 自由发挥的空间。
- 验收标准前置，每个阶段有明确的“怎样算完成”。
- 解析逻辑与 Harness 解耦，能独立测试的先独立测试。

---

## 阶段零：项目启动约束

**用途：** 每次新对话先粘贴，防止 AI 随机决定架构、依赖和代码风格。

**提示词：**

```

你是一位精通 TypeScript / Node.js 和 DeepSeek Harness 插件开发的高级工程师。

【项目背景】
我正在开发一个 DeepSeek Harness 插件，用于在企业 Agent 中注入 OWL/RDF 本体摘要。

- 本体以 Turtle 格式存储，用 SHACL 做形状校验。
- 插件需要在 agent/pre-step 事件中，根据当前会话绑定的业务域，把本体摘要注入到模型上下文。
- 当前阶段不涉及 ERP 对接，只做本体层。

【技术栈约束】

- TypeScript（编译为纯 JS 后供 Harness 加载），Node.js >= 22
- RDF 处理：rdflib（JavaScript 版，用于解析 Turtle）
- SHACL 校验：调用 Python 的 pySHACL（通过子进程或 API，不要用不成熟的 JS 库）
- 文件存储：本地 JSON + Turtle 文件，不上数据库

【编码规范】

- 每次只生成一个文件或一个函数，生成后等我确认再继续
- 所有路径使用相对路径 + 配置项，禁止硬编码绝对路径
- 异常必须捕获并返回结构化错误，禁止空 catch
- 如果官方文档或 npm 上有成熟做法，直接复用，不要自己造轮子

【Harness 插件规范】

- 插件入口导出 name 和 apply(ctx)
- 需要 tools 服务时声明 inject: ['tools']
- 事件监听用 ctx.on('agent/pre-step', ...)
- 不要修改 Harness 核心代码

以上约束在整个项目中始终有效。

```

**验收标准：** AI 确认理解约束，后续代码遵守技术栈和规范。

---

## 阶段一：插件骨架 + 最小加载验证

**目标：** 先跑通“插件能被 Harness 加载”这件事，不写任何业务逻辑。

**提示词：**

```

基于以上约束，生成一个最小 Harness 插件骨架。

要求：

1. 导出 name = 'ontology-injector'
2. apply(ctx) 函数中只做两件事：
   - 打印日志：'[ontology-injector] plugin loaded'
   - 注册一个空的 agent/pre-step 监听器（暂时只打印 '[ontology-injector] pre-step triggered'）
3. 同时生成一个最小的 cordis.yml 片段，用于在本地开发时加载这个插件（参考 Harness 教程的 scratch-plugin 做法）

在开始编写代码前，请先简要说明：

- 这个插件应该放在项目的哪个目录下
- 如何用 pnpm dsh web --patch 加载它进行验证
- 验证成功的标志是什么（终端日志？Web UI 行为？）
  
  ```
  
  ```

**验收标准：**

- 启动 Harness 后终端出现 `plugin loaded`
- 每次发送消息时出现 `pre-step triggered`
- 确认插件生命周期和事件挂载正确

---

## 阶段二：本体存储与加载

**目标：** 能读取 Turtle 文件、解析出类/属性/关系、生成摘要文本。纯 Node.js，不依赖 Harness。

**提示词：**

```
实现本体的文件存储与摘要生成模块。不要涉及 Harness 事件，只写纯函数。

【文件布局假设】
ontology-store/
├── contract/
│   ├── ontology.ttl
│   ├── shapes.ttl
│   └── summary.md          （生成产物，可缓存）
└── registry.json            （域列表：{"domains": ["contract", "procurement"]}）

【需要实现的函数】
1. loadOntology(domain: string): { turtle: string, shapes: string }
   - 从 ontology-store/{domain}/ 读取 .ttl 文件
   - 如果目录不存在或文件缺失，抛出结构化错误

2. generateSummary(domain: string): string
   - 用 rdflib 解析 Turtle
   - 提取：所有 owl:Class（取 rdfs:label 或本地名）、
     所有 owl:ObjectProperty / owl:DatatypeProperty（取 domain、range、label）、
     以及注释中标注的“行动”（先用简单约定，后续再完善）
   - 输出格式参考：
     ## 当前业务域：{domain}
     ### 对象类
     - {label}（{localName}）：{comment}
     ### 关键关系
     - {domain} → {property} → {range}（{label}）
   - 将结果写入 ontology-store/{domain}/summary.md，同时返回字符串

3. listDomains(): string[]
   - 读取 registry.json 返回域列表

【约束】
- 用 rdflib 的异步 API
- 摘要生成要考虑 Turtle 中可能缺失 label/comment 的情况（fallback 到 localName）
- 不要在这里处理 SHACL 校验（下一阶段做）

先给出文件结构设计，再写代码。写完后告诉我如何用 node 直接运行一个测试脚本来验证。
```

**验收标准：**

- `node test-summary.js` 能输出格式正确的摘要
- 缺少 label/comment 时回退到 localName
- `summary.md` 正确写入文件

---

## 阶段三：agent/pre-step 注入逻辑

**目标：** 把摘要函数挂到 Harness 事件上，按会话域注入。

**提示词：**

```
现在把摘要生成接入 Harness 的 agent/pre-step 事件。

【需求细节】
1. 会话域绑定：假设 session 的元数据中有一个字段 `businessDomain`（字符串，如 "contract"）。
   - 在 pre-step 中从当前 session 读取这个字段。
   - 如果字段不存在，不注入任何内容，直接放行。

2. 注入时机：
   - 仅在每轮的第一步注入（参考 dsh-trellis 的 injectStep 配置，默认 step === 1 时注入）
   - 如果当前 step 不是第一步，跳过

3. 注入格式：
   - 将阶段二生成的摘要包裹在 `<system-reminder>` 帧中
   - 以 user 消息形式追加到消息列表末尾（参考 agent-instructions 插件的做法）
   - 示例：
     ```
     <system-reminder>
     ## 当前业务域：contract
     ### 对象类
     ...
     </system-reminder>
     ```

4. 缓存策略：
   - 优先读取 ontology-store/{domain}/summary.md
   - 如果 summary.md 不存在或比 ontology.ttl 旧，调用 generateSummary 重新生成
   - 用简单的 mtime 比较即可，不要引入复杂缓存库

【需要修改的文件】
- lib/index.js（或 src/index.ts）：在 apply 中注册 agent/pre-step 监听器
- 新增 lib/injector.ts：封装注入逻辑

【验收方式】
在 Web UI 中：
1. 先手动把 registry.json 和 contract/ontology.ttl 放好
2. 在会话中设置 businessDomain = "contract"
   （如果 Harness 没有现成的设置入口，先写一个临时的 command 或工具来设置）
3. 发送任意消息，检查终端日志或 session 记录中是否出现了注入的摘要文本

先说明你打算如何获取当前 session 的 businessDomain（查阅 Harness session 相关文档或类型定义），再写代码。
```

**验收标准：**

- 设置 `businessDomain = "contract"` 后，消息中出现注入摘要
- 未设置域时不注入、不报错
- 非第一步不重复注入

**重要提醒：** `agent/pre-step` 是 waterfall 事件，监听器必须调用 `next()` 才能继续后续逻辑。如果生成的代码没有 `next()`，运行时会卡住。

---

## 阶段四：Turtle 提取流水线

**目标：** 从制度文本生成候选 Turtle，SHACL 校验后人工确认。

**提示词：**

```
实现一个独立的 Node.js 脚本（不放在 Harness 插件里），用于从制度文本生成候选 Turtle。

【输入】
- 一份制度文本文件（纯文本或 Markdown）
- 目标域的 Turtle 骨架（预定义的命名空间和若干已有类）

【流程】
1. 文本切片：按条款/段落切分，每片附带 source_clause 标识（如 "第12条"）
2. 对每个切片，调用 DeepSeek API（用 OpenAI 兼容格式），prompt 要求：
   - 输出合法的 Turtle 片段
   - 只能使用骨架中预定义的命名空间
   - 每个新元素必须注释来源：`# source: 第X条`
   - 输出格式为 JSON：{"turtle": "...", "clauses": ["第X条"]}
3. 将多个切片的 Turtle 合并
4. 调用 Python pySHACL 做校验：
   - 如果 conforms = false，把 results_text 回传给模型，要求它修正
   - 最多重试 2 次
5. 输出：候选 Turtle 文件 + 校验报告

【约束】
- 不要自动写入 versions/ 目录，候选文件放在 candidates/ 下
- 人工确认后，由另一个脚本或手动操作移入正式版本目录
- DeepSeek API Key 从环境变量读取

【输出文件】
- candidates/{domain}-{timestamp}.ttl
- candidates/{domain}-{timestamp}-report.txt

先给出 API 调用的 prompt 模板（给模型看的那个），再写脚本。
```

**验收标准：**

- 输入一份真实制度文本，产出候选 Turtle
- SHACL 校验失败时能自动重试
- 候选文件不直接进正式版本

---

## 阶段五：版本管理与 SHACL 校验 CLI

**目标：** 一个命令把候选 Turtle 发布为新版本。

**提示词：**

```
写一个 CLI 脚本（Node.js 或 shell），用于发布本体版本。

【命令设计】
node publish-ontology.js --domain contract --candidate candidates/contract-20261029.ttl --version 1.1.0

【执行步骤】
1. 校验 candidate 文件存在
2. 调用 Python pySHACL：python3 -m pyshacl -s shapes.ttl -df turtle candidate.ttl
   - 解析 stdout 或退出码
   - 如果不通过，打印报告并退出（非零退出码）
3. 如果通过：
   - 创建 versions/{version}/ 目录
   - 复制 candidate.ttl → versions/{version}/ontology.ttl
   - 从当前 shapes.ttl 复制到 versions/{version}/shapes.ttl
   - 更新当前 ontology.ttl 的 owl:versionIRI 和 owl:priorVersion
     （用简单的文本替换或 rdflib 操作）
   - 调用阶段二的 generateSummary 重新生成 summary.md
4. 打印发布摘要：版本号、新增/修改的元素列表
   （用简单的文本 diff 对比新旧 Turtle）

【约束】
- pySHACL 通过 child_process.spawn 调用，不要引入额外的 Python 包管理
- 如果 pySHACL 不可用，给出清晰的错误提示和安装命令（pip install pyshacl）
- 版本号遵循 semver，但脚本不做强制校验

先给出完整的 pySHACL 调用代码片段（包括错误处理），再写完整脚本。
```

**验收标准：**

- 合格候选能发布成功，不合格候选被拦截
- 新版本目录包含 `ontology.ttl` + `shapes.ttl`
- `summary.md` 自动更新
- 旧版本保留可回溯

**补充：** pySHACL 的 Python 调用返回三元组 `(conforms, results_graph, results_text)`。CLI 场景用 `python3 -m pyshacl` 的退出码更简单：conforms 为 true 时退出码 0，否则非零。

---

## 贯穿全程的追加提示词

在任意阶段，如果 AI 生成的代码“差点意思”，追加以下提示词之一。

### 要求先说明思路

```
在写代码之前，先列出你的实现步骤，以及你打算查阅 Harness 文档的哪些部分。
等我确认步骤后再写。
```

### 要求自查

```
写完后，从以下角度检查你的代码：
1. agent/pre-step 监听器是否调用了 next()？如果不调用会怎样？
2. Turtle 解析是否处理了 label/comment 缺失的情况？
3. SHACL 校验失败时，是否把报告传回给模型而不是直接抛异常？
4. 有没有硬编码的路径或域名？
逐条回答，发现问题直接修复。
```

### 遇到报错时

```
这是运行时的完整报错：
[粘贴报错]
请先分析根本原因，不要直接改代码。分析清楚后给出修复方案。
```

---

## 需要提前注意的坑

### Harness 仍处于 Developer Preview

API 可能变化。如果 AI 生成的代码引用了不存在的类型或事件名，**不要让它猜**。直接让它：

```
先搜索 node_modules/@deepseek-ai/ 下的类型定义文件，
找到 agent/pre-step 的实际类型签名，贴出来给我看，然后再写代码。
```

这样能避免 AI 基于过时记忆生成错误代码。

### waterfall 事件必须调用 next()

`agent/pre-step` 是 waterfall 事件。监听器不调用 `next()` 会导致 Agent 循环卡住。阶段三的代码生成后务必检查这一点。

### Turtle 解析的容错

真实制度文本提取出的 Turtle 常有缺失 `rdfs:label`、`rdfs:comment` 的情况。摘要生成必须有 fallback 到 localName 的逻辑，否则注入内容会出现空白项。

### 摘要内容不是 RDF 本体本身

注入的是 Turtle 的文本摘要，不是 RDF 图。模型消费的是自然语言 + 结构化列表，不是三元组。不要在注入层试图让模型“理解 RDF”。

---

## 附录：文件布局与验收清单

### 最终文件布局

```
ontology-store/
├── registry.json                    # {"domains": ["contract", ...]}
├── contract/
│   ├── ontology.ttl                 # 当前版本 OWL 本体
│   ├── shapes.ttl                   # 当前版本 SHACL 形状
│   ├── summary.md                   # 注入摘要（生成物）
│   └── versions/
│       ├── 1.0.0/
│       │   ├── ontology.ttl
│       │   └── shapes.ttl
│       └── 1.1.0/
│           ├── ontology.ttl
│           └── shapes.ttl
└── candidates/
    ├── contract-20261029.ttl
    └── contract-20261029-report.txt

plugin/
├── src/
│   ├── index.ts                     # 插件入口，注册 pre-step
│   ├── loader.ts                    # loadOntology / listDomains
│   ├── summary.ts                   # generateSummary
│   └── injector.ts                  # 注入逻辑
└── cordis.yml                       # 本地加载配置

scripts/
├── extract-ontology.js              # 阶段四：提取流水线
├── publish-ontology.js              # 阶段五：版本发布
└── test-summary.js                  # 阶段二：独立测试
```

### 分阶段验收清单

| 阶段  | 验收项   | 通过标志                                            |
| --- | ----- | ----------------------------------------------- |
| 一   | 插件加载  | 终端出现 `plugin loaded` 和 `pre-step triggered`     |
| 二   | 摘要生成  | `node test-summary.js` 输出格式正确的摘要                |
| 三   | 上下文注入 | 设置 businessDomain 后消息中出现 `<system-reminder>` 摘要 |
| 四   | 候选提取  | 真实制度文本产出候选 Turtle + 校验报告                        |
| 五   | 版本发布  | 合格候选发布成功，不合格被拦截，旧版本保留                           |

### 当前阶段边界（明确不做）

- 不实现本体行动与 ERP API 的映射
- 不处理写操作的安全确认机制
- 不设计统一 ERP 连接器的路由层
- 不上图数据库、不做 OWL 推理
- 不做全自动“一键生成本体”——提取与确认必须分离
  
  ```
  
  ```

---

以上即完整文档。保存为 `.md` 文件即可使用。如果后续需要我把某个阶段的提示词再细化（比如阶段四中给模型看的 Turtle 提取 prompt 模板），可以继续展开。
