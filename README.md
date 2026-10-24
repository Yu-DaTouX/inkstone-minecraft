# Inkstone Minecraft

Minecraft Java 版启动器（Electron + React）。从砚（Inkstone）仓库 `integrations/inkstone-minecraft/` 拆出，只含启动器本体；mod 开发核心、伴随 mod 与 agent MCP 留在砚插件侧。

## 开发

```bash
npm install
npm run dev
```

首次安装后如果提示 Electron 未安装，运行 `node node_modules/electron/install.js` 下载 Electron。

## 检查

```bash
npm run typecheck
npm run test:all
npm run build
```

`scripts/shot*.ts` 用 CDP 截图走查界面，测试游戏目录用 `INKSTONE_MC_TEST_GAME` 指定（默认 `.tmp/m2b-game`）。数据目录可用 `INKSTONE_MC_DATA` 改到隔离目录。

## 许可

MIT，第三方组件见 [THIRD-PARTY.md](THIRD-PARTY.md)。
