# Inkstone Minecraft

Minecraft Java 版启动器（Electron + React）。从砚（Inkstone）仓库 `integrations/inkstone-minecraft/` 拆出，只含启动器本体；mod 开发核心、伴随 mod 与 agent MCP 留在砚插件侧。

## 启动

双击 `启动.cmd`（或在终端运行 `启动.cmd`）：

- 不带参数：开发模式，改代码自动刷新，关闭窗口即退出
- `启动.cmd dist`：打开已打包的 `dist\win-unpacked\Inkstone Minecraft.exe`
- `启动.cmd install`：只安装依赖，不启动

首次运行会自动 `npm install` 并下载 Electron。

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
# 可选：真实游戏多版本验证，会下载到项目 .tmp 并逐个启动、停止隔离测试实例
npm run verify:matrix
npm run build
```

`scripts/shot*.ts` 用 CDP 截图走查界面，测试游戏目录用 `INKSTONE_MC_TEST_GAME` 指定（默认 `.tmp/m2b-game`）。数据目录可用 `INKSTONE_MC_DATA` 改到隔离目录。

`npm run test:optimization` 覆盖 JVM 参数、依赖约束与替换保护、诊断、单版本内存恢复，以及不修改 `options.txt` 的边界。

`node --experimental-strip-types scripts/check-runtime.ts final` 在隔离数据中启动真实 Electron，检查深浅主题、900×600、减少动态效果、诊断弹窗与内存应用/恢复，并保存截图和渲染线程采样到 `.local-docs/checks/`。运行状态采样使用测试状态，不代表游戏 FPS。

`node --experimental-strip-types scripts/verify-game.ts` 另行下载一份隔离的 Minecraft 1.21.1 并验证 Java 21 启动，需要联网和已有 Java 21；不会使用用户存档或改变游戏内设置。

## 正版登录与 Mod 自动刷新

在启动页添加账号，或进入「设置 → 账号」，点击「微软正版登录」，取得设备码后打开微软登录页完成授权。启动器内置 Inkstone Minecraft 的 Microsoft 客户端 ID；刷新凭据在主进程中由 Electron `safeStorage` 加密单独保存，启动前刷新并检查 Minecraft Java 所有权和玩家档案。PCL 迁移的正版账号需要在这里重新登录；授权失败会显示错误，不会自动改用离线身份。

Mod 页面会监听当前实例实际使用的 `mods` 目录。外部添加、删除、替换 `.jar` 或改名为 `.jar.disabled` 后自动更新列表；目录不存在或被重建时由每 2 秒的文件状态检查恢复监听，离开页面即停止。返回窗口也会刷新一次；此功能只同步本地列表，不会自动下载 Mod 更新。

`npm run test:auth-watch` 覆盖模拟认证交换、失败/取消、凭据隔离、正版启动参数与真实文件系统监听。`scripts/verify-auth-watch-ui.ts` 在隔离数据下检查真实 Electron 页面（会向微软获取设备码，但不进行账号授权），结果存入 `.local-docs/checks/2026-10-27-auth-watch/`。

## 打包与自动更新

```bash
npm run dist      # 本地打 Windows 安装包到 dist/，不发布
```

发版：把 `package.json` 的 `version` 改好、提交，再推同名标签（如 `v0.2.0`）。GitHub Actions（`.github/workflows/release.yml`）会打包并把安装包和 `latest.yml` 发到 Releases。

装好的启动器启动 15 秒后、之后每 6 小时检查一次 Releases，有新版就在后台下载，下好后顶栏出现「重启更新」；不点的话下次退出启动器时自动安装。游戏是独立进程，更新重启启动器不影响正在玩的游戏。开发版（`npm run dev`）不检查更新。

应用图标由 `npm run icon` 生成（`build/icon.png`）。

## 许可

MIT，第三方组件见 [THIRD-PARTY.md](THIRD-PARTY.md)。
