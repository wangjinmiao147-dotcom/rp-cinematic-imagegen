@echo off
setlocal
title Local scene LLM
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local-scene-llm.ps1"
if errorlevel 1 pause
endlocal
