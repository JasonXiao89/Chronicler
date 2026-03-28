@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0export-conversations.ps1"
