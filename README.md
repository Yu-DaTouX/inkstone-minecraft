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

## 打包与自动更新

```bash
npm run dist      # 本地打 Windows 安装包到 dist/，不发布
```

发版：把 `package.json` 的 `version` 改好、提交，再推同名标签（如 `v0.2.0`）。GitHub Actions（`.github/workflows/release.yml`）会打包并把安装包和 `latest.yml` 发到 Releases。

装好的启动器启动 15 秒后、之后每 6 小时检查一次 Releases，有新版就在后台下载，下好后顶栏出现「重启更新」；不点的话下次退出启动器时自动安装。游戏是独立进程，更新重启启动器不影响正在玩的游戏。开发版（`npm run dev`）不检查更新。

应用图标由 `npm run icon` 生成（`build/icon.png`）。

## 许可

MIT，第三方组件见 [THIRD-PARTY.md](THIRD-PARTY.md)。
