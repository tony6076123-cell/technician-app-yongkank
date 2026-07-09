@echo off
title 建立永康人員名單
chcp 65001 >nul
cd /d "%~dp0"
node seed-technicians.js 永康
pause
