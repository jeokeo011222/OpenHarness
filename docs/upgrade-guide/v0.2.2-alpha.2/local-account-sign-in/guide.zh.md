---
kind: upgrade-guide
description: "浏览器访问 Host 需要登录本地账号，DeepSeek 平台登录界面移除，管理员在 /admin 管理账号。"
---
# 浏览器访问需要登录本地账号

[English](guide.md) | 中文

## 变更

浏览器对 Host 的每个请求现在都需要已登录的本地账号。Host 前端门禁（packages/host/frontend-static）将未认证请求重定向到 `/login`，该页面由新的 account-directory 包（packages/identity/account-directory）提供，并以 SQLite 账号存储支撑。不带会话调用 Host 端点的自动化会收到重定向而非数据。

DeepSeek 平台登录界面已从 packages/client/ui-settings-account 移除：登录对话框、桌面引导流程、赠金通知、账号头像与账号区块、平台额度通知。账号菜单现在提供本地登录、登出与设置；额度通知的回退文案未变，仍归 ui-chat 所有。模型提供商凭据（packages/credentials/deepseek-account）与 DeepSeek API key 模型配置流程保留不变，移除的只是平台账号登录界面。

管理员账号获得用户管理工作台：左侧边栏面板与 `/admin` 页面，由 `GET /admin/state` 支撑，返回 `{ account, accounts, grants }`；非管理员账号在该处收到 403。远程访问策略新增 `unrestricted(principal)` 谓词，account-directory 将管理员账号标记为 unrestricted，因此管理员通过所有操作检查。

## 迁移

1. 在浏览器中打开 Host，并在 `/login` 完成注册。第一个注册的账号成为管理员；其余账号可从 `/admin` 创建，或保持开放注册。
2. 在 cordis.yml 中设置 account-directory 配置：存在管理员后将 `allowRegistration: false` 即可关闭自主注册（默认 `true`）。当前部署中 `devHint` 会在登录表单预填用户名 `admin` 与密码 `dsh-admin-2026`；它是部署配置而非产品默认值，共享使用前请修改。
3. 自动化先登录再发起请求，并携带会话 cookie；未认证请求不再返回数据。
4. 确认迁移：已登录的管理员能打开 `/admin` 并看到账号与授权两张卡片；非管理员账号在该处收到 403；DeepSeek 账号凭据与 API key 模型配置在设置中仍可使用。
