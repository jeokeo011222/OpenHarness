# 数据分析功能 · Vibe Coding 提示词包（DSH 二开版）

面向 **DeepSeek Harness（DSH）本体内二开**：把「数据分析」做成一个持久化插件（bundle），而不是另起一个 Web 应用。

- 数据源接入 → Host 侧能力（Node：文件 / 数据库 / HTTP）
- 数据集与图表 → Host 算 + Client 面板渲染（右侧栏 tab）
- AI 交互解读 → 天然由 Agent 承担（注册工具 + 系统提示词），面板只负责展示

## 怎么用

1. 新开一个会话，第一条消息贴 `00-project-constitution.md` 的提示词正文（全局宪法，一次即可）。
2. 之后**每条消息只贴一条提示词**，按 01 → 09 顺序推进。
3. 每条提示词跑完，让 AI 按「交付格式」回报；把它的回报（改了哪些文件、哪些没验证）作为下一条的输入。
4. 不要一次把 8 个提示词全丢进去 —— vibe coding 的质量取决于「每轮上下文小、每轮可验收」。
5. 出问题时用 `10-iteration-template.md`，别在原提示词上打补丁式追加要求。

## 提示词链

| 序号 | 文件 | 产出 | 关键验收 |
|---|---|---|---|
| 00 | `00-project-constitution.md` | 全局约束（每会话首条） | AI 复述铁律，不写代码 |
| 01 | `01-design-proposal.md` | 一页纸方案 + 分期 | 不写代码，只出方案 |
| 02 | `02-scaffold-and-install.md` | 可安装的空壳插件 + 右栏 tab + 1 个工具 | 装上了、点得开、调得通 |
| 03 | `03-import-file.md` | CSV / Excel 导入 | 中文表头、脏数据、10 万行 |
| 04 | `04-connect-database.md` | 数据库连接与查询 | 只读、超时、注入被拒 |
| 05 | `05-connect-rest.md` | REST API 接入 | 分页、重试、拍平 |
| 06 | `06-dataset-and-query.md` | 数据集模型 + 查询 DSL | 聚合口径正确 |
| 07 | `07-charts.md` | 图表规格与渲染 | 空数据、极值、深浅色 |
| 08 | `08-ai-analysis.md` | AI 解读与多轮追问 | 不编数字、能下钻 |
| 09 | `09-verification.md` | 验收 / 安全 / 性能 | 8 条端到端全过 |
| 10 | `10-iteration-template.md` | 修 bug / 评审 / 加需求模板 | 最小改动不返工 |

## 懒人版：一段式提示词

只想先看它能不能跑起来，用这段开局（后续仍建议回到 01 起的分步链路）：

```text
在 D:\Code\deepseek-harness 这个 DeepSeek Harness 仓库的架构内，给我做一个「数据分析」插件（bundle），不要另起 Web 应用。
需求：① 从 CSV/Excel 导入数据；② 连数据库读表；③ 调 REST API 取 JSON；④ 数据加载成「数据集」；⑤ 可视化图表；⑥ AI 交互分析解读。

约束：
- 用工作区目录建 bundle（package.json 里 dsh.bundle.patch + dsh.client），用 plugin_manager 的 install_bundle 安装，不要手写 profile 配置、不要在 profile 里跑 pnpm。
- Host 侧用 ctx.tools.register 注册工具；Client 侧用右栏 tab（ctx.sidebarRightTabs.register + sidebar.right.pane.tab slot）承载面板；AI 解读走 Agent 调工具，不要自己在插件里存 API Key。
- 任何 DSH API（服务方法、slot 名、props）先用 cordis_inspect_query 查，查不到再读源码；禁止凭记忆编 API。
- 样式只用 --dsw-alias-* 主题 token；文案走 locale（zh + en）；不用 iframe、不用 CDN、不引 @deepseek-ai/dsh-client-* 运行时包。
- 先给方案，我确认后再写代码。方案要回答：数据怎么落盘、三条数据源怎么统一成一个 Dataset、图表用什么渲染、AI 那条链路怎么走、第一期砍掉什么。

方案输出格式：目标/非目标、ASCII 架构图、数据模型、工具清单（名称+参数+返回）、面板信息架构、分期计划、风险、5 条验收场景。一页纸，不写实现代码。
```

## 三条设计主线（先跟 AI 对齐，避免它跑偏）

**1. 一个能力域 = 一个 bundle。** Host 工具、Client 面板、locale、icon 都在同一个包目录里，用一个 `cordis.patch.yml` 插入。不要拆成「后端服务 + 前端项目」。

**2. 数据集是唯一的中间层。** 三条数据源最终都收敛成同一个 `Dataset`（schema + 行数据 + 血缘 + 版本）。图表和 AI 只认 Dataset，不认「CSV 文件」或「SQL 结果」。这一层不统一，后面每加一个数据源就要改一遍图表和 AI。

**3. AI 不直接读原始数据。** 给模型的是「数据画像」（列类型、空值率、distinct、分位数、时间范围、前 N 行样本）和工具返回的聚合结果；原始行只进图表。这是控制幻觉和 token 成本的唯一可靠办法。

## 常见翻车点

- **AI 一上来写 800 行**：用宪法第 7 条拉回，要求「先骨架后能力」。
- **编 API**：它写 `ctx.dataset.register(...)` 这种不存在的东西时，让它先 `cordis_inspect_query` 跑一遍再改。
- **拿 iframe 嵌图表页**：直接否决，iframe 拿不到主题 token，深浅色一切换就崩。
- **面板里自己接大模型**：第一期不要。Agent 已经在会话里了，多接一套就要处理流式、上下文、成本、鉴权四件事。
- **把密码写进 cordis.patch.yml**：凭据走 credentials 服务，配置里只放引用名。
- **没浏览器控制还宣称"视觉已验证"**：验收只认「可安装 + slot 已注册 + 控制台无 crash」，视觉项如实标未验证。
