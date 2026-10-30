---
description: "本地企业账号：注册、账号与授权管理、签名浏览器会话，以及接纳这些会话的身份接缝。"
kind: "package-reference"
---

# @deepseek-ai/dsh-account-directory

[English](README.md) | 中文

## 概述

`dsh-account-directory` 把本地企业账号保存在一个存储域中。管理员注册账号、分配全局角色与按资源授权，Host 提供登录页与管理页。签名会话 cookie 把每个浏览器绑定到一个账号与一个 authority；`user` principal 类型与 Connection 身份接缝让业务包能够授权该调用方。空目录上的第一个账号成为管理员，管理员通过每一个 Remote 访问检查。授权与管理员角色是访问策略仅有的输入，因此没有注册规则的资源类型仍保持 owner-only。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

插件随 bundle 自动装载，除配置外无需任何部署步骤：

| 配置字段 | 默认值 | 作用 |
|---|---|---|
| `sessionDays` | `30` | 浏览器会话与 cookie 的有效天数。 |
| `allowRegistration` | `true` | 除第一个账号外，其他账号能否在 `/login` 自助注册。 |
| `minPasswordLength` | `8` | 可接受的最短密码；更短的提交在哈希前即被拒绝。 |

通过 Host 页面操作目录：`/login` 注册第一个账号或登录已有账号，`/admin` 列出账号与授权，管理员可在此创建、修改、删除账号，重置密码，授予或撤销资源角色。`GET /auth/state` 以 JSON 返回已登录账号及其授权。

### 登录

成功的 `POST /auth/login` 或 `POST /auth/register` 返回指向 `/` 的 `303`，并带上作用域为请求 authority 的 HttpOnly、`SameSite=Strict` 会话 cookie。cookie 名包含该 authority 的哈希，因此同一台机器上的不同 authority 不会共享账号 cookie；Host 提供 HTTPS 时 cookie 带 `Secure`。`POST /auth/logout` 清除 cookie 并回到 `/login`。

### 管理账号与授权

`/admin` 对非管理员返回 `403`，对未登录访问者跳转到 `/login`。页面表单调用 `POST /admin/user/create`、`/admin/user/update`、`/admin/user/delete`、`/admin/grant/set`、`/admin/grant/delete`；成功时返回 `303` 回到 `/admin`，失败时带错误信息重新渲染页面。`GET /admin/state` 为客户端工作台以 JSON 返回同样的目录状态——`{ account, accounts, grants }`——未登录时返回 `401`，调用方不是管理员时返回 `403`，GET 与 HEAD 之外的方法返回 `405`。一条授权由资源类型、资源 id 与至少一个 `ACCOUNT_ROLES` 中的角色组成。删除账号会同时移除它持有的全部授权，并释放其缓存的 Peer。

### 贡献资源类型

通过 `ctx.typert.resources` 声明资源的业务包，为该类型贡献一次授权语义：

```ts
ctx.inject(['accountDirectory'], (scope) => {
  scope.effect(() => {
    const rule = scope.accountDirectory.acl.register({ kind: 'ontology-domain', bind: ontologyDomainBindings })
    const baseline = scope.accountDirectory.acl.registerBaseline(() => ONTOLOGY_BASELINE)
    return () => { baseline(); rule() }
  })
})
```

`bind` 决定存储的角色集合在该资源上对应哪些 Remote 动作；baseline 为每个已登录账号提供无需逐资源记录即可持有的绑定。两种注册在变化时都会使已缓存的访问判定失效。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

目录拥有 `account` 存储域、`user` 类型的一份 Remote 访问策略，以及 `connectionIdentity` 服务；可观察行为见[使用本包](#use-this-package)。policy 对持有 `admin` 角色的账号回答 `unrestricted()` 为 true，因此管理员通过所有 action 检查、页面以 owner 访问快照打开；其他账号只能在其授权与 ACL 注册表允许的范围内操作。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务：账号与授权变更、会话查询、策略、ACL 注册表、HTTP 路由 |
| [`src/session.ts`](src/session.ts) | 签名会话 token、cookie 名称与属性、会话密钥持久化 |
| [`src/password.ts`](src/password.ts) | scrypt 校验值派生与常量时间校验 |
| [`src/pages.ts`](src/pages.ts) | 登录页与管理页 HTML |
| [`src/http.ts`](src/http.ts) | 表单解析、JSON 与 HTML 响应、重定向、同源检查 |
| [`src/spec.ts`](src/spec.ts) | 账号与授权的存储域声明及记录校验模式 |
| [`src/types.ts`](src/types.ts) | 账号词汇、ACL 注册表接口、`user` principal 类型 |

### 设计决策

- **Host HTML，而非 Remote 命名空间。** `account` Remote 命名空间属于 DeepSeek 账号登录，因此账号与授权管理走 Host 表单与 JSON 路由，而不扩张客户端 Remote 面。
- **串行化变更。** 所有账号与授权变更经过同一条 promise 链，因此两个并发注册不会同时看到空目录，也不会撞用同一个用户名。
- **约束落在变更操作内。** 用户名形状、密码长度、重名、未知角色与末位管理员规则都在操作内部失败，因此 Host 路由与进程内调用者面对同样的拒绝。
- **每个 home 一个密钥。** 签名密钥存放于 credentials 存储的 `account-directory/session`，首次加载时生成；本构建无法读取的存储记录会让插件装载失败，而不是静默作废所有会话。
- **绑定 authority 的 cookie。** token 把请求 authority 与账号、过期时间一并签名，因此为某个本地 authority 签发的 cookie 不会被另一个 authority 接受。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [identity 包组地图](../README.zh.md)——同级包与包组范围。
- [dsh-api-remote-access](../../api/remote-access/README.zh.md)——本包供给的策略注册表、绑定与失效机制。
- [dsh-storage-domain](../../storage/storage-domain/README.zh.md)——承载账号表的域形式。
- [dsh-client-connection](../../client/connection/README.zh.md)——Connection 身份接缝与 Peer 接纳。
- [dsh-ontology-injector](../../context/ontology-injector/README.zh.md)——ACL 注册表的首个消费者，把角色映射到 ontology-domain 动作。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该目录不注册任何提示、工具或请求上下文贡献，只决定谁可以调用 Remote 动作。

#### KV Cache 影响

无；认证与授权发生在模型请求组装之前。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **资源授权只覆盖已声明的类型**——授权与管理员角色为 policy 供给任何包注册的资源类型的输入，但随发布包分发的 bundle 只为 `ontology-domain` 贡献规则；其他 Remote 面对非管理员仍为 owner-only，因此已登录的非管理员账号在客户端 UI 的 ontology 工作台之外会遇到拒绝。
- **Cookie authority 取决于 `Host` 头**——以两个不同 authority 提供服务的部署需要各自登录一次。
- **账号无法自助重置密码**——只有管理员可以替换密码，没有找回流程。
- **没有账号审计轨迹**——变更记录只写入行上的 `updatedAt`，没有“谁改了什么”的历史。
- **SQLite 由 bundle 路由提供**——本包只声明 `account` 域，后端由部署的 `storage-domain` 路由决定；没有该路由的部署以 JSON 存储。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确非权威；已发布行为以上述章节为准。

#### 待定：外部身份提供方

`connectionIdentity` 接缝目前只接纳一种会话格式。外部提供方（OIDC 或 LDAP）需要产生同样的 `user` principal，决定外部身份如何映射到本地账号记录，并把提供方的删除与本地授权对齐。

#### 待定：SPA 内的登录面

`/auth/state` 与 `/login` 都是 Host 渲染页面；客户端管理工作台改为读取 `/admin/state` JSON 路由。要把登录本身搬进 Web 客户端，仍需要一个区别于 DeepSeek `account` 命名空间的界面。

</details>
