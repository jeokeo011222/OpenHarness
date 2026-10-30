---
description: "identity 包组：每个 harness home 一个匿名关联 id，以及接纳签名浏览器会话的本地企业账号目录。"
kind: "package-group"
---

# identity/ — 共享身份

[English](README.md) | 中文

## 概述

identity 组回答关于请求来源的两个问题。其中一个包为每个 harness home 提供一个匿名 id，该安装的遥测、反馈与 DeepSeek 请求会把它附加到各自的记录上，因此来自同一套安装的记录无需识别用户即可被辨认。另一个包是本地账号目录：它保存账号与资源授权，签发浏览器会话，并把会话接纳为业务包据此授权的 `user` principal。匿名 id 无需配置；账号目录需要一个管理员，由第一次注册产生。本页列出本组的组成，包 README 负责细节。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`anonymous-user-id`](anonymous-user-id/README.zh.md) | 让每个 harness home 拥有一个匿名 id，遥测、反馈与 DeepSeek 请求把它附加到记录上，使来自同一安装的记录无需识别用户即可被辨认 |
| [`account-directory`](account-directory/README.zh.md) | 保存本地账号与按资源的授权，提供 Host 登录页与管理页，并把签名会话接纳为 `user` principal |

<a id="related-documentation"></a>
## 相关文档

- [会话遥测子系统](../../docs/subsystems/session-telemetry.zh.md)——在导出中携带该 id 的遥测功能。
- [dsh-llm-deepseek](../llm/llm-deepseek/README.zh.md)——在请求中携带该 id 的 DeepSeek 提供方。
- [dsh-command-feedback](../feedback/command-feedback/README.zh.md)——在确认文本中点名该匿名安装的反馈命令。
- [dsh-api-remote-access](../api/remote-access/README.zh.md)——账号目录把授权绑定进去的访问策略。

<a id="dev-note"></a>
## 开发备注

无。
