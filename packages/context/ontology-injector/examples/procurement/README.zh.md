# 对象层示例：采购订单

[English](README.md) | 中文

这条示例把「本体词汇」接到「真实数据行」上，再走一遍动作闭环。它同时是对象层的验收脚本。

## 文件

| 文件 | 作用 |
|---|---|
| `orders.csv` | 采购订单事实表（主键 `poNumber`） |
| `suppliers.csv` | 供应商主数据（主键 `code`） |
| `bindings.json` | 部署配置：两个对象类型、一条关联、一个动作 |

`bindings.json` 是**部署配置，不是词汇**：主键、列映射、数据源地址都随客户环境变化，所以它不进 Turtle。

## 走一遍

```sh
cd packages/context/ontology-injector
STORE=/tmp/dsh-obj-demo

# 1. apply object types, link, and action
npx tsx scripts/objects-cli.ts --store $STORE apply procurement examples/procurement/bindings.json

# 2. sync objects from the CSV sources
npx tsx scripts/objects-cli.ts --store $STORE sync procurement

# 3. inspect bindings and sync history
npx tsx scripts/objects-cli.ts --store $STORE types procurement
npx tsx scripts/objects-cli.ts --store $STORE runs procurement

# 4. propose (the agent does this through the propose_action tool)
npx tsx scripts/objects-cli.ts --store $STORE propose procurement \
  approvePurchaseOrder procurement:PurchaseOrder:PO-1001 '{}'

# 5. committing an unapproved proposal is refused
npx tsx scripts/objects-cli.ts --store $STORE commit <proposalId>

# 6. a human approves, then the commit runs
npx tsx scripts/objects-cli.ts --store $STORE approve <proposalId> alice
npx tsx scripts/objects-cli.ts --store $STORE commit <proposalId>

# 7. read the proposal ledger
npx tsx scripts/objects-cli.ts --store $STORE proposals procurement
```

## 预期结果

- `sync` 输出 `read 3, inserted 3`（订单）与 `read 2, inserted 2`（供应商）。
- `PO-1003`（1200 万）在提案阶段就被「超过一千万需要走招标流程」拦下。
- `PO-1001` 提案通过前置检查，但第 5 步会被拒绝：`a human must approve it before it can be committed`。
- 第 6 步之后 `PO-1001` 的 `status` 从 `pending` 变为 `approved`，提案状态为 `committed`。

## 动作的三条硬约束

1. 前置条件是**声明式**的（字段比较 / 关联存在性），不接受模型生成代码。
2. 提案只记录意图，不写数据；`before` / `after` 与阻断项都存下来供人核对。
3. 没有工具能批准提案。批准发生在 CLI / 工作台，且会记录批准人。
