@echo off
title 建立歸仁人員名單
chcp 65001 >nul
cd /d "%~dp0"
node seed-technicians.js 歸仁
pause
