@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title Inkstone Minecraft

rem 从 Electron 内置终端启动时会继承该变量，导致 Electron 只当 Node 跑
set "ELECTRON_RUN_AS_NODE="

rem 用法：
rem   双击或 启动.cmd        开发模式（改代码自动刷新）
rem   启动.cmd dist         打开已打包的 dist\win-unpacked 程序
rem   启动.cmd install      只安装依赖，不启动

if /i "%~1"=="install" goto install
if /i "%~1"=="dist" goto dist
goto dev

:dev
call :ensure_deps || goto fail
echo 启动开发模式，关闭此窗口即退出。
echo.
call npm run dev
goto done

:dist
if not exist "dist\win-unpacked\Inkstone Minecraft.exe" (
  echo 还没有打包产物。先运行 npm run dist 打包。
  goto fail
)
start "" "dist\win-unpacked\Inkstone Minecraft.exe"
goto done

:install
call :ensure_deps || goto fail
echo 依赖已就绪。
goto done

:ensure_deps
where node >nul 2>nul || (
  echo 找不到 Node.js，请先安装：https://nodejs.org
  exit /b 1
)
if not exist "node_modules" (
  echo 首次运行，安装依赖……
  call npm install || exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo 下载 Electron……
  call node node_modules\electron\install.js || exit /b 1
)
exit /b 0

:fail
echo.
echo 启动失败，请看上面的错误信息。
pause
exit /b 1

:done
endlocal
