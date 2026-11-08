@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
echo ==========================================
echo   投标业务工作台 bid-bench - 安装依赖
echo ==========================================
where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没找到 Node.js，请先安装 Node.js 22 或更高版本：https://nodejs.org/zh-cn
  pause
  exit /b 1
)
node -v
echo.
echo 正在安装依赖（第一次约 100MB，请耐心等待）...
call npm install
if errorlevel 1 (
  echo.
  echo [X] 安装失败。若卡在下载，可换国内镜像重试：
  echo     npm install --registry=https://registry.npmmirror.com
  pause
  exit /b 1
)
if not exist "app\config.json" (
  copy "app\config.example.json" "app\config.json" >nul
  echo 已生成配置文件 app\config.json
)
echo.
echo 安装完成。双击 scripts\start.bat 启动工作台。
pause
