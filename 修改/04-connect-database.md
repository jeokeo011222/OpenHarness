# 04 · 数据源② 数据库连接

**适用时机**：文件导入验收通过后。
**产出**：连接配置 + 测试连接 + 表结构探测 + 只读查询 + 整表导入为数据集。

---

## 提示词正文（整段复制）

```text
【任务】给 data-analysis 插件加第二个数据源：关系型数据库。目标是"能安全地读到数据"，而不是"一个通用 SQL 客户端"。

【驱动策略】
- 优先用运行时内置能力：Node ≥ 22.5 时用内置 node:sqlite 读 SQLite。
- PostgreSQL / MySQL 需要驱动（pg / mysql2）。先查当前运行时的 node_modules 能不能解析到；解析不到就明确报错"缺少驱动 pg，请安装或改用 SQLite"，不要静默失败、不要偷偷降级成假数据。
- 驱动不在依赖里时，这一轮允许只交付 SQLite 全链路 + PG/MySQL 的"连接与探测"骨架，并在交付说明里写清楚哪条链路没打通。

【凭据】
- 连接串/密码绝不写进 cordis.patch.yml，也绝不落进日志和工具返回值。
- 先用 cordis_inspect_query 查 credentials 相关 Service，确认存取方法后，配置里只存"凭据引用名"（如 pg.local）。
- 工具返回里出现的连接信息只保留 host:port/db，密码字段一律显示 ***。

【工具清单】
1. db_test_connection({ connectionId }) → { ok, serverVersion, latencyMs, error? }
2. db_list_objects({ connectionId, schema? }) → { schemas: [...], tables: [{ schema, name, kind: 'table'|'view', estimatedRows }] }
3. db_describe_table({ connectionId, schema, table }) → { columns: [{ name, type, nullable, isPrimaryKey }], rowCountEstimate }
4. db_query({ connectionId, sql, maxRows? }) → { columns, rows, rowCount, truncated, elapsedMs }
5. db_import_table({ connectionId, schema, table, where?, columns?, limitRows?, name? }) → 与文件导入相同的 Dataset 摘要

【安全要求，逐条实现，缺一不可】
1. 只读连接：连接建立后先执行只读设置（PG: SET default_transaction_read_only = on；MySQL: SET SESSION TRANSACTION READ ONLY；SQLite: 以 readonly 模式打开文件）。
2. SQL 白名单：只允许单条 SELECT / WITH ... SELECT。实现方式：去掉注释和字符串字面量后，检查首关键字，检查不含分号（除结尾）、不含 INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/GRANT/COPY/CALL/EXEC。
3. 禁止多语句：出现分号后还有非空内容直接拒绝。
4. 行数上限：默认 5000 行，返回 truncated: true 并在 warnings 里说明"已截断，请加聚合或筛选"。
5. 超时：默认 15s，用 AbortSignal 或驱动的 cancel 能力真正中断查询，不是只停止等待。
6. 参数化：db_query 不拼接用户输入；如果模型需要条件，走参数数组（$1/?）传值。
7. 任何拒绝都要返回可读原因（哪条规则被触发），不要只说 "invalid sql"。

【Client 侧】
- 面板加「数据库」入口：连接列表 + 新建连接表单（类型、host、port、database、user、凭据引用名）。
- 每个连接可展开看到表清单；点某张表 → 右侧显示字段结构 + "预览 20 行" + "导入为数据集"。
- 连接失败时把错误码和原文展示出来（ECONNREFUSED / 28P01 之类），不要吞。

【验收】把下面每种情况的实际返回贴给我：
1) SQLite：建一张测试表 → 探测结构 → 预览 → 导入数据集 → 面板里点开图表
2) 错误密码 → 看到明确的认证错误，不是超时
3) 执行 select * from 大表 → 返回 truncated: true 且 rowCount = 5000
4) 执行 drop table x → 被拒绝，提示命中"不允许的语句"
5) 执行 select 1; select 2 → 被拒绝，提示"不允许多语句"
6) 一条 sleep(30) 的查询 → 15s 内返回超时错误，连接池没有被拖死
```

---

## 关键点说明

- **只读是双保险**：连接层只读 + 语句白名单。任何一层单独都不够（只读事务挡不住 `DROP` 在某些引擎上的行为，白名单挡不住函数里的副作用）。
- **截断要显式**。返回 `truncated: true` 比返回 5000 行更诚实——AI 会因此改用聚合，而不是在 5000 行上算出一个错的结论。
- **超时必须是真中断**。只是 `Promise.race` 的话，数据库那头还在跑，连接池很快就满。
- **凭据引用而不是凭据**。这条不做到，你会在某次 `db_test_connection` 的返回值里看到明文密码，然后它进了会话日志。

## 验收清单

- [ ] 三种数据库的能力边界写清楚了（哪个能跑、哪个只到骨架）
- [ ] 密码在任何工具返回、日志、报错里都不出现
- [ ] DROP / 多语句 / 注释绕过（`/*x*/drop`）全部被拒
- [ ] 大表查询明确标了 truncated
- [ ] 慢查询 15s 内中断，且之后还能正常查询（连接没被污染）
- [ ] 面板能从"表"一步走到"数据集"

## 常见翻车点

- 用字符串拼接拼 WHERE 条件 —— 这就是 SQL 注入，而且模型会主动这么写。
- 只读设置执行失败被 try/catch 吞掉，后面所有安全检查形同虚设。
- 把 `information_schema` 查询写成跨库全量扫描，在大库上直接卡死。
- 导入整表时 `SELECT *` 没有 limit，1000 万行的表直接把内存打爆。
```
