# 05 · 数据源③ REST API

**适用时机**：文件与数据库两条链路跑通后。
**产出**：API 数据源配置 + 分页拉取 + JSON 拍平成数据集。

---

## 提示词正文（整段复制）

```text
【任务】给 data-analysis 插件加第三个数据源：调用应用系统的 RESTful API，把 JSON 变成数据集。

【连接配置（Config）】
每个 API 数据源一条配置：
{ id, name, baseUrl, auth: { kind: 'none'|'bearer'|'apiKey'|'basic', credentialRef?, headerName? }, headers?: {}, allowedHosts: [..], timeoutMs?, maxPages? }
- 密钥走 credentials，配置里只有 credentialRef。
- allowedHosts 必填且非空：请求前校验 URL 的 host 在列表内，重定向后的 host 也要校验（最多跟 3 跳）。这一条是 SSRF 的唯一防线，不许跳过。

【工具清单】
1. api_request({ sourceId, path, method?, query?, headers?, body?, maxBytes? })
   → { status, headers(裁剪后), contentType, json?, textPreview?, bytes, elapsedMs }
   - 只允许 GET/POST；POST 的 body 上限 1MB。
   - 响应超过 maxBytes（默认 2MB）时只截断返回，并标记 truncated。
2. api_discover({ sourceId, path }) —— 探测一次响应，推断"记录数组在哪一层"（见下）
   → { shape: 'array'|'object', itemPath?, fields: [{ name, type, sample }], itemCount }
3. api_import({ sourceId, path, itemPath?, pagination?, fieldMap?, filters?, maxPages?, name? })
   → 与文件导入相同的 Dataset 摘要

【分页：支持三种策略，配置里选一种】
- page：query 里 page / pageSize 递增，直到返回数组为空或到达 maxPages
- offset：query 里 offset += pageSize，同上
- cursor：从响应里按 cursorPath（如 data.nextCursor）取下一页游标，为空即结束
要求：每页请求之间不要 sleep 固定值；遇到 429 读 Retry-After，遇到 5xx 指数退避（200ms 起，最多 3 次，带抖动）。
maxPages 默认 20，硬上限 100。达到上限时返回 warnings："已达最大页数，数据可能不完整"。

【JSON 拍平规则】
1. 先定位记录数组：itemPath 显式给（如 data.items）；没给就自动找——响应根是数组则用它；根是对象则找第一个"元素是对象且长度 > 0"的数组字段，深度不超过 2 层。
2. 每个数组元素是一行；对象字段用点号展开（user.name → user.name），最多展开 3 层，超过就 JSON 序列化成字符串。
3. 数组字段（如 tags: [a,b]）：长度 ≤ 3 且元素是标量时，join 成 "a,b"；否则序列化成 JSON 字符串并在 warnings 里记一条。
4. null / 缺失字段统一成 null；字段集合取所有行的并集，缺的补 null。
5. 推断类型：按 JSON 原生类型映射（number→number、boolean→boolean、ISO 字符串→datetime、其余→string）。

【增量】
- 配置里可给 updatedSinceParam（如 updated_after）与 waterMarkPath（如 data.maxUpdatedAt）。
- 导入成功后把水位写进 dataset meta 的 source.waterMark；下次导入自动带上。

【Client 侧】
- 面板加「API」入口：数据源列表 + 新建表单（baseUrl、认证方式、凭据引用、允许域名）。
- 填完 baseUrl 和 path 后可以点"探测"，展示推断出的记录数组路径 + 字段表 + 前 5 行。
- 确认后点"导入"，显示分页进度（第 N 页 / 已取 M 行）。

【不要做的事】
- 不做 GraphQL、不做 WebSocket、不做 OAuth 授权码流程（第一期只支持静态 token / API Key / Basic）。
- 不自动跟随跨域重定向到白名单外的 host。

【验收】用你本地起的 mock server（或公开测试 API）把下面每种情况跑通并贴结果：
1) 返回 { data: { items: [...] } } —— 自动定位到 data.items
2) 三种分页各跑一次，确认拉到的总行数等于预期
3) 服务端返回 429 + Retry-After: 1 —— 确认等待后重试成功
4) 某字段是嵌套对象、某字段是长数组 —— 确认拍平结果符合规则
5) baseUrl 指向不在 allowedHosts 的域名 —— 被拒绝
6) 一个 2MB 的响应 —— 确认被截断且标记了 truncated
```

---

## 关键点说明

- **allowedHosts 是必须项而不是可选项**。这个工具本质上是"让模型发起任意 HTTP 请求"，没有白名单就等于把内网探测能力交给了模型。
- **自动定位记录数组**决定了这个功能好不好用。真实 API 的返回结构千奇百怪，让用户手填 JSONPath 门槛太高，先自动猜再让用户确认。
- **分页上限 + 明确的不完整提示**，比"默默拉到超时"有用得多。
- **增量水位**不是第一期必须，但字段先留好，否则以后加要改 meta 结构。

## 验收清单

- [ ] 白名单外的域名被拒（包括重定向后跳出去的）
- [ ] 三种分页都能拉全，且总行数和预期一致
- [ ] 429 / 5xx 有重试，且不会无限重试
- [ ] 嵌套对象和数组都被拍平，列名可读（`user.name` 而不是 `[object Object]`）
- [ ] 超过 maxBytes 的响应被截断并标记
- [ ] 探测出来的字段表和前 5 行能让人判断"这数据能不能用"

## 常见翻车点

- `fetch` 默认跟随重定向，一跳就跳出白名单。
- 把整个响应 `JSON.stringify` 存进 meta.json，单条记录就把 meta 撑到几十 MB。
- 分页写死 `pageSize=100`，但服务端上限是 20，导致每页只回 20 条却以为拉全了（要用实际返回条数判断结束）。
- 时间字段是 `"2024-01-01T00:00:00+08:00"`，直接按字符串排序，跨时区就错。
```
