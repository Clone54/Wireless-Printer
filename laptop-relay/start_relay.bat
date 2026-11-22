@echo off
set CLOUD_PRINT_URL=https://your-app-name.onrender.com
set CLOUD_PRINT_TOKEN=your-secret-token
python "%~dp0laptop_relay.py"
pause
