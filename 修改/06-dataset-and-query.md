# 06 · 数据集与查询层

**适用时机**：三条数据源里至少两条通了之后。
**产出**：统一的 Dataset 模型 + 受限查询 DSL + 数据画像。**这一层是图表和 AI 的地基。**

---

## 提示词正文（整段复制）

```text
【任务】把三条数据源收敛到同一个数据集模型，并实现一个受限查询层。这一轮不加新数据源、不做图表，只把"数据集"这一层做扎实。

【Dataset 模型（落盘 meta.json 的 schema，定死后不许轻易改）】
{
  id, name, version, createdAt, updatedAt,
  source: { kind: 'file'|'database'|'api', detail: {...}, waterMark? },
  schema: [{ name, type: 'string'|'integer'|'number'|'boolean'|'date'|'datetime', nullable, role?: 'dimension'|'measure', unit?, description? }],
  rowCount, columnCount,
  stats: { rowCount, nullRateByColumn, distinctByColumn, timeRange?, },
  derived: [{ name, expression, type }]   // 计算字段
}
行数据在 data.ndjson，不放进 meta。

【计算字段】
- 用白名单表达式，不要 eval、不要 new Function。
- 支持：+ - * / %、比较、AND/OR/NOT、IF(cond, a, b)、ROUND(x, n)、ABS、COALESCE、YEAR/MONTH/DAY/DATE_TRUNC(unit, x)、CONCAT、LOWER/UPPER、LENGTH。
- 表达式解析成 AST 再求值；解析失败返回带位置的错误（"第 7 个字符处：未知函数 FOO"）。
- 计算字段必须记录依赖的原始列，schema 变更时能提示"该字段已失效"。

【查询 DSL（模型和面板都用它，不让模型直接写 SQL 到内存数据）】
dataset_query({
  datasetId,
  dimensions: [{ field, timeGrain?: 'day'|'week'|'month'|'quarter'|'year', alias? }],
  measures: [{ field, agg: 'count'|'countDistinct'|'sum'|'avg'|'min'|'max'|'p50'|'p95', alias? }],
  filters: [{ field, op: '='|'!='|'>'|'>='|'<'|'<='|'in'|'notIn'|'contains'|'startsWith'|'isNull'|'notNull'|'between', value }],
  orderBy: [{ field, direction: 'asc'|'desc' }],
  limit?: integer,      // 默认 1000，硬上限 10000
  offset?: integer
})
→ { columns: [{ name, type }], rows: [[...]], rowCount, truncated, elapsedMs, queryHash }

【实现要求】
1. 流式扫描 data.ndjson，不要整体读入内存。聚合用增量累积（map + reduce），不要先收集所有行再算。
2. 时间粒度：先按字段类型归一化成 Date，再按 grain 截断；周从周一开始；时区用本地时区并在结果里回显 timezone。
3. 空值语义：sum/avg 跳过 null；count 计行数；countDistinct 跳过 null。这个规则要写进工具描述，让模型知道。
4. 除零返回 null，不要返回 Infinity 或 NaN（JSON 里会变成 null，前端会显示成空白，要提前处理）。
5. 排序：数值按数值排，字符串按 localeCompare('zh') 排；null 一律排最后。
6. 缓存：queryHash = hash(datasetId + version + DSL)，命中直接返回；数据集版本变化时缓存失效。
7. 超限：limit 超过硬上限时截断并 truncated: true，不要报错（报错会让模型卡住）。

【数据画像工具 dataset_profile】
→ {
  rowCount, timeRange,
  columns: [{ name, type, nullRate, distinct, min?, max?, mean?, p50?, p95?, topValues: [{ value, count, pct }] }],  // topValues 最多 10 个
  suggestedQuestions: [ ... ]   // 3 条，基于字段名和时间范围生成的、真的能答的问题
}
- 这是给模型看的"数据长什么样"，要控制在 2KB 以内（超过就截断 topValues）。
- suggestedQuestions 不要写"数据的趋势如何"这种空话，要具体："2024 年各月合同金额的环比变化"。

【Client 侧】
- 数据集详情页：字段表（名称/类型/空值率/distinct/单位）+ 前 20 行预览 + 计算字段管理。
- 字段表要能点列头排序，能搜索字段（字段多的时候）。
- 顶部显示数据源血缘：来自哪个文件/哪张表/哪个 API，什么时候导入的。

【验收】把下面每条的实际输出贴给我：
1) 用一份带时间列的数据集，按 month 聚合 sum，手算核对一个月的值
2) 有 null 的数值列做 avg，确认分母是"非空行数"
3) 除零场景返回 null 而不是 Infinity
4) limit = 999999 的查询被截到 10000 且 truncated
5) 计算字段 "金额/数量" 里数量为 0 时不出错
6) 同一查询连续调两次，第二次耗时明显更短（缓存生效）
7) dataset_profile 输出 < 2KB，suggestedQuestions 里的问题你用工具真的能答出来
```

---

## 关键点说明

- **DSL 而不是 SQL** 是这一层的核心决策。让模型写 SQL 到内存数据集，你需要一个 SQL 引擎（依赖 + 方言 + 注入面）；DSL 只有一个校验器，错了还能给出精确到字段的报错。
- **`suggestedQuestions` 必须"真的能答"**。这是最容易被写成装饰品的地方：生成一堆"请分析数据"的废话，用户点了发现答不了，信任直接归零。要求 AI 自己用工具验证一遍。
- **空值语义要写进工具描述**。否则模型会假设 avg 分母是总行数，解读时数字对不上。
- **缓存按 dataset version**，而不是按数据集 id，否则重新导入后还在返回旧结果。

## 验收清单

- [ ] 三条数据源产出的数据集结构完全一致（同一个查询工具都能查）
- [ ] 时间粒度聚合的数字能手算核对上
- [ ] null / 除零 / 空结果三种情况都有确定行为，不是崩
- [ ] 计算字段表达式注入（比如 `1; process.exit()`）被解析器拒绝
- [ ] 10 万行聚合 < 1s
- [ ] dataset_profile 体积可控，建议问题可答

## 常见翻车点

- 把 data.ndjson 整个 `readFileSync` 再 `split('\n')` —— 内存直接翻倍。
- 时间用字符串比较做范围过滤，跨月直接错。
- `countDistinct` 用 Set 存全部值，100 万行基数的列吃掉几百 MB。
- 计算字段用 `eval` 图省事，等于把进程控制权交给模型输出。
```
