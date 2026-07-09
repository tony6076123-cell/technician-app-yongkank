@echo off
title 技師業績 App
chcp 65001 >nul
cd /d "%~dp0"

if not exist "firebase-key.json" (
  echo ❌ 找不到 firebase-key.json
  echo 請把海哥給你的金鑰檔案，改名成 firebase-key.json，放進跟這個bat檔同一個資料夾
  pause
  exit /b
)

if not exist "node_modules" (
  echo === 第一次執行，安裝套件中（大概1-2分鐘）===
  call npm install
)

echo.
echo === 啟動技師業績 App ===
start "技師業績-伺服器" cmd /k "node server.js"

timeout /t 3 /nobreak >nul

echo.
echo === 開啟對外網址通道（每次重開網址會換新的）===
echo 底下出現 https://xxxx.trycloudflare.com 那一行，就是可以分享出去的網址
echo.
cloudflared.exe tunnel --url http://localhost:3000

pause
