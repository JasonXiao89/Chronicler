@echo off
cd /d "%~dp0"
echo Starting Chronicler...
start "" "http://localhost:3738"
node server.js
