# 第三方许可

本项目以 [MIT](LICENSE) 发布。本文件登记随分发保留的第三方组件及其许可，只做索引，不替代各组件原始许可文本。

## 界面

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [Lucide](https://lucide.dev)（`lucide-react`） | ISC | 界面图标 |
| React Aria Components（`react-aria-components`） | Apache-2.0 | 基础交互组件 |
| 砚（Inkstone）界面组件与设计令牌 | MIT，Copyright (c) 2026 Yu-DaTouX | `src/renderer/src/ui/`、`src/renderer/src/design/` 复制自砚仓库 `src/renderer/src/ui`、`src/renderer/src/design`（砚提交 `ac6ab9ff`），只保留启动器用到的组件 |

## Minecraft 加载器安装（Forge / NeoForge）

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [minecraft-launcher-core-node](https://github.com/Voxelum/minecraft-launcher-core-node)（XMCL，提交 `154e2719`）的 `packages/installer/forge.ts`、`neoforge.ts`、`profile.ts` | MIT，Copyright (c) 2023 CI010 | 安装器解包与安装处理器流程按 MIT 许可移植到 `src/core/install/forge-install.ts`、`processors.ts`，并按本项目的下载器、类型与版本 JSON 结构改写（未安装 `@xmcl/installer` 包，其 6.3.6 发布件不可用）。移植部分的文件头保留来源与版权声明。许可原文：<https://github.com/Voxelum/minecraft-launcher-core-node/blob/master/LICENSE> |
| `@xmcl/core`、`@xmcl/unzip`、`@xmcl/user` | MIT | npm 依赖 |

完整许可文本随各自分发包一起保留；升级依赖时请同步核对本表。
