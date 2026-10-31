# Object layer example: purchase orders

English | [中文](README.zh.md)

This example binds ontology vocabulary to real data rows and then walks one action round trip. It doubles as the acceptance script for the object layer.

## Files

| File | Role |
|---|---|
| `orders.csv` | Purchase order facts, keyed by `poNumber` |
| `suppliers.csv` | Supplier master data, keyed by `code` |
| `bindings.json` | Deployment configuration: two object types, one link, one action |

`bindings.json` is **deployment configuration, not vocabulary**: primary keys, column maps, and source endpoints change per customer environment, so none of it belongs in Turtle.

## Walk through it

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

## Expected result

- `sync` prints `read 3, inserted 3` for orders and `read 2, inserted 2` for suppliers.
- `PO-1003` (12 million) is stopped at proposal time by "超过一千万需要走招标流程".
- `PO-1001` passes its preconditions, but step 5 is refused: `a human must approve it before it can be committed`.
- After step 6, `PO-1001.status` moves from `pending` to `approved` and the proposal reads `committed`.

## Three hard rules for actions

1. Preconditions are **declarative** (field comparison or link existence); the model never contributes code.
2. A proposal records intent and writes nothing; `before` / `after` and every blocking precondition are stored for a human to check.
3. No tool can approve a proposal. Approval happens in the CLI (later the workbench) and records who decided.
