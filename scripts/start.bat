@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
if not exist "node_modules" (
  echo 还没有安装依赖，请先双击 scripts\install.bat
  pause
  exit /b 1
)
if not exist "app\config.json" copy "app\config.example.json" "app\config.json" >nul
powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:7830/api/health ^| Out-Null; exit 0}catch{exit 1}"
if not errorlevel 1 (
  echo 工作台已经在运行，直接打开浏览器。
  start "" http://127.0.0.1:7830
  exit /b 0
)
echo 正在启动投标业务工作台...
start "投标业务工作台服务" /min cmd /c "node app\server.mjs"
timeout /t 5 >nul
start "" http://127.0.0.1:7830
echo.
echo 已启动。关闭请双击 scripts\stop.bat
timeout /t 2 >nul
