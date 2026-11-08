@echo off
chcp 65001 >nul
echo 正在停止投标业务工作台服务...
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.mjs*' }; if (-not $p) { Write-Host '没有找到正在运行的服务。' } else { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('已停止 PID ' + $_.ProcessId) } }"
timeout /t 2 >nul
