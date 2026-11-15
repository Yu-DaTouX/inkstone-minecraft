# AGENTS.md

Inkstone Minecraft：Windows 上的 Minecraft Java 版启动器，Electron + React 19 + TypeScript。用户是开发者本人和朋友，熟手向。界面只有简体中文。

动手前先读：`PRODUCT.md`（产品范围与边界）、`DESIGN.md`（视觉规范，改界面必读），以及 `.local-docs/handoffs/` 里最新的一份交接。本文件只放约定和速查，跟 `DESIGN.md` 冲突时以 `DESIGN.md` 为准。

## 目录

| 路径 | 内容 |
|---|---|
| `src/core/` | 业务核心，纯 Node，不依赖 Electron：安装、下载、启动、Mod、崩溃诊断、账号、设置 |
| `src/core/service.ts` | 门面，主进程只调它；持有任务锁、运行状态、账号会话 |
| `src/main/` | Electron 主进程：窗口、托盘、IPC 注册、`safeStorage`、自动更新 |
| `src/preload/` | `contextBridge` 暴露 `window.craft` |
| `src/shared/` | 主进程和界面共用的类型、IPC 频道名（`channels.ts`）、`CraftApi` 类型（`api.ts`） |
| `src/renderer/src/` | React 界面；`ui/` 基础组件，`design/` 令牌与基础样式 |
| `scripts/test-*.ts` | 自动化测试（node 直接跑 TS） |
| `scripts/shot*.ts`、`check-runtime.ts`、`verify-*.ts` | CDP 截图、真实 Electron 检查、真实游戏验证 |
| `.local-docs/` | 交接文档和检查证据（截图、JSON），不进安装包 |

新增一个 IPC 能力要同时改五处：`shared/channels.ts` → `shared/api.ts`（`CraftApi`）→ `preload/index.ts` → `main/index.ts`（`ipcMain.handle`，参数先校验）→ `core/service.ts`。

## 命令

```bash
npm run dev          # 开发
npm run typecheck    # node 与 web 两套 tsconfig
npm run test:all     # 全部自动化测试，交付前必跑
npm run build
npm run verify:matrix  # 可选：联网下载并真实启动 8 个版本组合，耗时长
```

交付标准：`typecheck`、`test:all`、`build` 全部通过；改了界面要在深色、浅色、900×600 下各截一次图。

## 代码约定

- `src/core`、`src/shared`、`scripts` 的相对导入要写 `.ts` 后缀（测试靠 `--experimental-strip-types` 直接运行）；renderer 的导入不写后缀。
- 核心逻辑写成可注入依赖的纯函数或类（例如 `spawnImpl`、`fetch`、`encrypt/decrypt`），这样测试不用 Electron 也能跑。新功能要在对应的 `scripts/test-*.ts` 里加用例，新的测试组记得接进 `package.json` 的 `test:all`。
- 错误给用户看的是中文原因和下一步，原始错误放进可折叠的细节里。口令和令牌一律脱敏。
- 改了产品行为，要同步 `PRODUCT.md`、`README.md`；改了界面，要同步 `DESIGN.md`。
- 提交信息用中文，一句话说清做了什么。

## 安全与数据边界（硬性）

- 运行 Electron 或游戏时，用 `INKSTONE_MC_DATA`、`INKSTONE_MC_TEST_GAME` 指向 `.tmp/` 下的隔离目录，不碰用户真实数据 `%APPDATA%\inkstone-minecraft` 和真实游戏目录、存档。
- 不读取、不修改游戏的 `options.txt`；不改 Windows、驱动、电源或其他进程；不自动安装、删除或重新启用 Mod。
- 凭据（Microsoft 刷新令牌、外置登录令牌）只在主进程用 `safeStorage` 加密，单独存文件，不进 settings JSON，不跨 IPC 传给界面，不写日志。
- 从 PCL 只读迁移，不写 PCL 的文件。
- 删除一律移进 `.trash`，可以恢复；危险操作必须有确认框。
- 不要擅自推送、打标签、发版。发版流程：改 `package.json` 版本 → 提交 → 推 `vX.Y.Z` 标签，由 GitHub Actions 打包发布。

## Git worktree 里工作

worktree 里没有 `node_modules`。不要 `npm install`，在 worktree 根目录建一个目录联接复用主目录的：

```bash
cmd //c mklink /J node_modules "E:\Inkstone\projects\砚启动器\node_modules"
```

## 交接文档

阶段性工作结束时写 `.local-docs/handoffs/YYYY-MM-DD-主题.md`，分「实现 / 验证 / 未验证与边界」三节。只写实际跑过、看过的；模拟测试通过不能写成真实环境已验证。截图和检查数据放 `.local-docs/checks/YYYY-MM-DD-主题/`。

---

## UI 速查

### 设计方案一句话

整个窗口是一张种子生成的像素地图（世界层），操作浮在磨砂玻璃上。顶栏和左栏是同一块玻璃，连成 L 形；需要大段阅读的页面在右边铺一层厚玻璃内容面。**绿色只给「开始玩」，琥珀只给「修好它」。** 详见 `DESIGN.md`。

### 布局骨架

- **主操作永远在左栏底部**：66px 高的大按钮，按钮上写它作用的对象（「启动游戏 · 1.21.1」「安装 · 1.20.4」）。新页面也照这个放。
- 带分区导航的页面一律用 `SubNavLayout`（`src/renderer/src/SubNavLayout.tsx`）：
  - `groups` 是分区导航，`active`/`onChange` 控制选中，`header` 是左栏顶部，`footer` 放主操作大按钮，`onBack` 用于需要返回的页面（例如版本详情）。
  - 右侧内容的开头用 `PageHead`（`title` / `description` / `actions`）。
  - 空状态用 `EmptyBlock`（一句话说明 + 一个能解决它的按钮）。
- 弹层：`overlays.tsx` 的 `ConfirmDialog`（危险操作确认，`danger` 时确认按钮变危险样式）和 `Sheet`（侧边抽屉，例如日志、Mod 详情）。

### 基础组件（`src/renderer/src/ui/`，全部基于 React Aria Components）

| 组件 | 用途与要点 |
|---|---|
| `Button` | `variant`: `primary`（实心绿，一屏只能有一个）、`secondary`（默认操作）、`ghost`（次要、危险操作的入口）、`plain`、`danger`；`size`: `sm`/`md`；`icon` 放 Lucide 图标；`block` 撑满 |
| `IconButton` | 只有图标的按钮，图标作为 `children`，必须给 `aria-label`；需要悬停说明时外面包 `TooltipTrigger` + `Tooltip` |
| `TextField` / `TextArea` / `SearchField` | 表单输入，自带 `label`、`description`、`errorMessage` |
| `Select` / `ComboBox` / `ListBox` | 选择；可搜索时用 `ComboBox` |
| `Switch` / `Checkbox` / `CheckboxGroup` | 开关用于即时生效的设置，复选用于批量选择 |
| `Slider` | 连续数值一律用滑块，不用下拉或输入框；内存专用 `MemorySlider` |
| `SegmentedControl` | 两到四个互斥选项，例如主题 |
| `SettingSection` / `SettingRows` / `SettingRow` | 设置类页面的平铺行：左边标题加说明，右边控件；不做卡片 |
| `Notice` | 提示条，`tone`: `info`/`ok`/`ask`/`stall`/`fail`，`action` 放「重试」等动作 |
| `ErrorNotice` | 直接传入 `error`，会显示中文原因，技术细节折叠 |
| `Badge` | 小标签，`tone` 同语义色；`Kbd` 快捷键 |
| `ProgressBar` / `Meter` / `MeterRing` / `Spinner` | 进度；加载状态优先用一行文字或 `Skeleton`，不用转圈占满版面 |
| `StatusDot` / `StatusSlot` | 运行状态圆点 |
| `Tooltip` / `TooltipTrigger` / `TooltipHint` | 悬停提示，统一 300ms 延迟 |
| `Popover` | 浮层菜单 |
| `cx` | 拼 className |

业务通用件：`BlockIcon`（版本标志方块，同时是品牌标记）、`InstanceIcon`（版本图标）、`SkinHead`（玩家头像）、`MemorySlider`、`LogSheet`、`TaskIndicator`（顶栏任务中心）。文案与状态映射集中在 `labels.ts`（加载器名、运行状态、任务状态、账号类型），不要在页面里各写一份。

图标只用 `lucide-react`，导航和行内 18–20px，不出现 14px 以下的功能图标；不用 emoji，不画插画。

### 样式与令牌

- 层级：`design/index.css`（`@layer reset, tokens, base, primitives, patterns, features, utilities`）→ `design/world.css`（本项目对令牌的覆盖，**以它为准**）→ `ui/ui.css` 等组件样式 → `styles.css`、`launch.css` 页面样式。
- `design/tokens.css` 是生成文件，不要手改。来源是 `design/tokens.json`，用 `npm run tokens`（`scripts/design/build-tokens.mjs`）重新生成；`npm run typecheck` 会先校验两者是否一致。本项目自己的视觉差异优先写在 `world.css` 里覆盖；只有改基础令牌（字号、间距、密度等）时才改 `tokens.json`。
- 颜色只用令牌，主题由 `light-dark()` 自动切换，不写死色值：
  - 中性：`--bg`、`--fg`/`--fg2`/`--fg3`、`--line`/`--line2`、`--hover`、`--sel`、`--field`
  - 绿：`--accent`、`--accent-t`（文字）、`--on-accent`
  - 琥珀：`--fix`、`--fix-t`、`--fix-bg`、`--fix-edge`、`--on-fix`
  - 玻璃：`--glass`、`--glass-heavy`、`--glass-lo`、`--glass-blur`
  - 地形小色块：`--biome-*`，只用于 6–10px 的图例
  - 字：`--font-ui`、`--font-display`、`--font-mono`（只给路径和日志）
- 尺寸：可点区域不小于 36px，列表行 54–56px，左栏导航项 44px；圆角：小控件 8px，按钮和行 10–12px，大按钮 14px，内容面和弹层 18px。
- 动效：`--ease-spring`（选中滑块）、`--ease-back`（落入）。所有动效都要处理「减少动态效果」（`prefers-reduced-motion`）。

### 禁止

- 玻璃套玻璃、卡片套卡片；一块玻璃上不再放第二块带模糊的面。玻璃的祖先链上不能有 `filter`、`opacity<1`、`mask`、`clip-path`、`view-transition-name`，否则 `backdrop-filter` 会失效。
- 渐变按钮、彩色描边卡片、蓝紫霓虹、纯黑底、深色背景上叠半透明白卡片。
- 一屏多于一块实心绿；把琥珀用在「能修」以外的地方；用红色大按钮做删除。
- 解释性废话填版面；在界面上暴露内部目录名、哈希值这类技术串（放进折叠的细节里）。

### 改完界面自查

1. 有没有玻璃套玻璃、卡片套卡片？
2. 主操作是不是在左栏底部的大按钮里？
3. 实心绿是不是只有一块？琥珀是不是只用在「能修」的地方？
4. 有没有小于 36px 的可点区域、小于 18px 的图标？
5. 深色、浅色、900×600 都截图看过没有？截图脚本见 `scripts/shot*.ts`，必须用隔离数据目录。
6. 打开「减少动态效果」后还能正常用吗？
