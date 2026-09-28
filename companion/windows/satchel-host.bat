@echo off
rem Launched by Chrome/Edge. Must not print anything else to stdout.
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0satchel-host.ps1" %*
