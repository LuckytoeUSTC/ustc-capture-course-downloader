@echo off
chcp 65001 >nul
cd /d "%~dp0"
if "%~1"=="" (
  echo 请把保存的单堂课程 HTML 拖到此文件上。
) else (
  node download-course.mjs download "%~1" "%~dp0downloads"
)
pause
