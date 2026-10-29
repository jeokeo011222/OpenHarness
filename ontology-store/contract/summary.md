## 当前业务域：contract

### 对象类
- 合同（Contract）：双方或多方之间设立、变更、终止民事权利义务关系的协议
- 签约方（Party）：合同的一方当事人，可以是自然人或法人
- 条款（Term）：合同中具有独立法律意义的一条约定
- 义务（Obligation）：合同一方应当履行的行为或不行为
- 签署（Signature）：签约方在合同上签字或盖章的行为

### 关键关系
- Contract → 签约方 → Party
- Contract → 包含条款 → Term
- Term → 设定义务 → Obligation
- Contract → 由方签署 → Signature

### 数据属性
- Contract → 合同标题（string）
- Contract → 签署日期（date）
- Contract → 合同金额（decimal）
