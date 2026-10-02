@echo off
chcp 65001 >nul
cd /d "%~dp0"
node download-server.mjs
pause
