---
description: "本地账号目录会话的侧边栏账号启动器：设置入口、管理员用户管理工作台入口与退出登录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-account

[English](README.md) | 中文

## 概述

账号启动器是侧边栏的本地会话入口。对 Host `/auth/state` 的一次探测决定它的标签与菜单项：已登录账号显示其显示名，并提供设置、管理员控制台与退出登录；未登录浏览器显示紧凑的 More 行，仅提供设置。管理员控制台入口只在探测到 `admin` 全局角色时出现，并在新标签页打开 `/admin` 用户管理工作台。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 Web 客户端需要展示本地账号会话、管理员需要进入用户管理工作台时挂载本插件。客户端 face 贡献 `settings.launcher` 组件；探测到 admin 会话时，还会贡献 `admin` 主面板（工作台页面）与侧边栏面板列表的盾形图标。认证本身由 Host 的本地账号路由承担，本包只读取这些路由并对其执行操作。

启动器每次挂载探测一次 `/auth/state`。已登录菜单提供设置（带 shell 配置的快捷键）、admin 会话的管理员控制台与退出登录；未登录菜单仅提供设置。退出登录向 `auth/logout` 发送 POST，并始终落在 `/login`，请求失败时也一样。

[管理工作台](#the-admin-workbench)渲染在 `/admin`，面向 Host 授权为 admin 的会话。它列出账号与授权，所有变更都以 urlencoded 表单提交到 Host 的 admin 路由。

<a id="the-admin-workbench"></a>
### 管理工作台

工作台读取 `/admin/state` 并渲染两张卡片。账号卡片列出每个本地账号，含显示名输入框、管理员复选框、可选的新密码输入框以及保存与删除操作；表格上方是创建账号表单。授权卡片列出 workspace 与 session 授权，每行带撤销操作，并有设置授权表单：选择一个账号、一个资源，以及将替换该资源原有授权的角色集合。

| 路由 | 操作 |
|---|---|
| `admin/user/create` | 按用户名、显示名、密码与管理员标志创建账号 |
| `admin/user/update` | 保存一个账号的显示名、管理员标志与可选的密码重置 |
| `admin/user/delete` | 删除一个账号 |
| `admin/grant/set` | 替换一个资源上某个账号的授权角色 |
| `admin/grant/delete` | 撤销一行授权 |

授权表单提供 Host 定义的账号角色：`owner`、`author`、`reviewer`、`publisher` 与 `viewer`。不完整的提交留在页面内：创建表单拒绝空用户名或空密码，授权表单拒绝缺失账号、资源或角色。被拒绝的 POST 显示本地化的错误提示，并保留全部字段供重试。

### 访问控制

启动器与工作台只渲染会话可用的内容。管理员入口跟随 `/auth/state` 的回答，`/admin/state` 则以 Host 自己的授权决定回答工作台读取；未授权的读取渲染禁止状态。这些决定由 [account-directory](../../identity/account-directory/README.zh.md) 与 [remote-access](../../api/remote-access/README.zh.md) 包负责。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

本节说明插件的设计；可观察行为见 [使用本包](#use-this-package)。

本包没有 Host face：`apply()` 是刻意的空操作，客户端直接与 Host 的账号路由通信。`dsh.client.inject` 声明 locale 服务与它贡献的 slot 面，因此组合顺序不影响探测。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 客户端 face：locale 字典、启动器注册，以及 admin 面板与侧边栏图标贡献 |
| [`src/client/AccountMenu.tsx`](src/client/AccountMenu.tsx) | 启动器：探测、菜单项与退出登录 |
| [`src/client/AdminWorkbench.tsx`](src/client/AdminWorkbench.tsx) | `/admin` 页面：状态读取、账号行与授权表单 |
| [`src/client/local-admin.ts`](src/client/local-admin.ts) | 类型化 fetch 助手与 fail-closed 响应守卫 |
| [`src/client/AdminIcon.tsx`](src/client/AdminIcon.tsx)、[`src/client/LogoutIcon.tsx`](src/client/LogoutIcon.tsx) | 侧边栏与菜单图标 |
| [`src/client/locales.ts`](src/client/locales.ts) | 八语言字典 |
| [`src/index.ts`](src/index.ts) | Host 入口；刻意为空 |

### 会话探测与守卫

探测在每次挂载时运行一次并带 `live` 标志，卸载后到达的回答不更新任何状态。每个响应先经过窄类型守卫再进入状态：意外的响应体让启动器保持未登录形态、让工作台保持禁止状态，而不是信任部分数据。表单提交是只以响应成败为结果的 urlencoded POST，因此任何 Host 载荷都不会被原样渲染。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级参考不够用时，阅读这些页面。

- [Account directory](../../identity/account-directory/README.zh.md) — 本地账号、角色、密码存储与 Host 认证路由。
- [Remote access policy](../../api/remote-access/README.zh.md) — Host 如何决定哪些会话可以使用它。
- [Architecture](../../../docs/architecture.zh.md) — 插件接缝与 Host/Client 拆分。

-----

<a id="model-experience"></a>
## 模型体验

无，因为启动器与工作台从不进入模型请求：其状态来自 Host 路由，其操作不写入任何模型可见内容。

#### KV Cache 影响

模型请求前缀不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **退出登录是尽力而为的导航** — 登出失败时浏览器仍会跳到 `/login`，启动器不报告 cookie 是否存留。
- **工作台信任 Host 的授权** — 页面以 `/admin/state` 的回答决定渲染，但除此之外不做任何强制；每个变更都由 Host 路由裁决。
- **授权资源固定** — 设置授权表单只覆盖 `workspace` 与 `session` 资源及上述账号角色；其他资源种类需要先扩展 Host 侧。
- **无自助资料编辑** — 账号只能通过管理员行修改自己的显示名或密码，工作台从不显示凭据。

<a id="dev-note"></a>
### 开发备注

行为测试位于 `tests/`，stub `fetch` 与导航；在 jsdom 中渲染启动器与工作台，在 Node 中测试 fetch 助手。运行方式：`pnpm exec vitest run packages/client/ui-settings-account/tests`。
