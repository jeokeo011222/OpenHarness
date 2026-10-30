# React + TypeScript + Vite

[English](README.md) | 中文

此模板提供最小化的 React + Vite 环境，包含 HMR 与部分 Oxlint 规则。

目前有两个官方插件可用：

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) 使用 [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) 使用 [SWC](https://swc.rs/)

## React 编译器

本模板未启用 React 编译器，因为它会影响开发与构建性能。如需启用，参见[官方文档](https://react.dev/learn/react-compiler/installation)。

## 扩展 Oxlint 配置

如果要做生产应用，建议安装 `oxlint-tsgolint` 并编辑 `.oxlintrc.json`，启用类型感知的 lint 规则：

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

完整规则与分类见 [Oxlint 规则文档](https://oxc.rs/docs/guide/usage/linter/rules)。
