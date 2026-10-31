# 02 · 骨架与安装（第一个可验收增量）

**适用时机**：方案确认后。
**产出**：一个能装上、能点开、能调通的空壳插件。**不接任何数据源**。
**为什么单独一轮**：插件骨架涉及 manifest、patch、client 加载、slot 注册、locale、icon 六件事，任何一件错了后面都白搭。先让这条链路跑通，后面每加一个能力都只是往里填。

---

## 提示词正文（整段复制）

```text
【任务】按上一轮确认的方案，搭出插件的可运行骨架并安装到当前 profile。这一轮不做任何真实的数据源，只验证"插件装得上、面板点得开、工具调得通"。

【产出物】在工作区建一个目录 data-analysis/（下称 <bundle-dir>），包含：
- package.json：dsh.bundle.patch 指向 cordis.patch.yml；dsh.client 声明 web 平台；exports 暴露 "."、"./client"、"./locale/*.json"、"./icon"；files 列全所有运行时文件。
- cordis.patch.yml：insert 一行，id 用 data-analysis，name 用包名。
- index.js：Host 插件，export function apply(ctx, config)。这一轮只做两件事：
  1) 注册一个测试工具 analysis_ping，参数 { message?: string }，返回 { ok: true, echo, at }，用来验证工具链路；
  2) 用 ctx.systemPrompt.section() 加一小段说明（一句话即可），确认提示词注入的写法。
- client.js：Client 插件，window.__ModuleLoader__.load({ id, factory }) 形式。这一轮只做两件事：
  1) 用 ctx.sidebarRightTabs.register 注册一个 tab 类型，kind 叫 analysis，标题"数据分析"；
  2) 在 sidebar.right.pane.tab 这个 slot 上注册正文，渲染一个空态：标题"数据分析"+ 一句说明 + 一个"数据集"占位区。
- locale/zh.json 和 locale/en.json：meta.title、meta.description、tab 标题、空态文案。
- icon.svg：一个简洁的分析/柱状图图标（自己画，不要抄第三方素材）。

【硬性约束】
- 不要引入任何 npm 依赖，这一轮必须零依赖跑通。
- 不要写 CSS 文件；样式用内联 style + --dsw-alias-* token（先 cordis_inspect_query 查 Theme，拿到真实 token 名再写）。
- 不要 iframe，不要 CDN，不要往 body 上挂节点。
- 写完先自检：node --check 过一遍 index.js 和 client.js，确认 package.json 是合法 JSON，确认 files 里列的文件都真实存在。
- 用 plugin_manager 的 install_bundle 安装，target 传 <bundle-dir> 的绝对路径。安装结果里的 application 和 warnings 要原样贴给我，不要只贴"成功"。
- 装完用 cordis_inspect_query 确认：插件行已激活、tab 类型已注册、工具 analysis_ping 出现在工具列表里。

【验收方式】安装完成后告诉我：
1. 在 http://127.0.0.1:3080 上从哪里能看到"数据分析"这个 tab（具体点击路径）；
2. 我在聊天里说什么话能让你调用 analysis_ping；
3. 哪一项你没法验证（比如视觉），如实标出来。
```

---

## 关键点说明

**为什么先注册 tab 而不是先写工具？** 因为 tab 是用户能"看见"的东西，先看见再从里面长能力，比先堆一堆看不见的工具更容易判断方向对不对。

**为什么要求零依赖？** 第一个增量如果就卡在 pnpm 装不上，你会误以为是架构问题。把依赖推迟到 P1，能快速区分"链路问题"和"环境问题"。

**安装结果要原样回贴**：`application: applied` 才算真的生效；`restart-required`、`overridden`、`failed` 都是不同的问题，让 AI 自己解释，别让它含糊过去。

## 验收清单

- [ ] 插件列表 / 设置页里能看到插件，标题和描述是中英双语、不是模板文案
- [ ] 右栏出现「数据分析」tab，点开有内容，不是白屏
- [ ] 浏览器控制台没有 `slot entry crashed` 之类的报错
- [ ] 聊天里让 Agent 调 analysis_ping，能拿到结构化返回
- [ ] 深浅色切换下面板不崩（token 用对了）
- [ ] AI 明确说明了"视觉未验证"或"已在页面上确认"

## 常见翻车点

- `files` 少列了 client.js 或 locale，安装后加载 404 —— 让它装完自己 `read` 一遍安装目录核对文件清单。
- tab 注册了但正文不显示：`kind` 与 slot 的 `key` 没对上（正文 slot 的 key 要用类型注册时的 id）。
- 图标是 SVG 但没有 `viewBox`，显示成一个巨大的黑块。
- 用 `ctx.slots.register` 时 name 写错成 `sidebar.right.tab`（少了 `.pane`），注册静默无效。
