@echo off
cd /d "%~dp0"
echo ============================================================
echo   LogiOps frontend - local web server
echo.
echo   Open in your browser:        http://127.0.0.1:5173
echo   Keep the API BASE field as:  https://tsptw.onrender.com
echo.
echo   Keep THIS window open while using the app.
echo   Close it (or press Ctrl+C) to stop the server.
echo ============================================================
echo.

set "PYCMD="
where python >nul 2>nul && set "PYCMD=python"
if not defined PYCMD (where py >nul 2>nul && set "PYCMD=py")
if not defined PYCMD (
  echo [ERROR] Python not found on PATH.
  echo Install it from https://www.python.org/downloads/
  echo and tick "Add Python to PATH" during setup.
  echo.
  pause
  exit /b 1
)

echo Starting server with "%PYCMD%" ...
echo (If the browser shows "connection refused", wait 2 seconds and refresh.)
start "" "http://127.0.0.1:5173"
%PYCMD% -m http.server 5173 --bind 127.0.0.1

echo.
echo Server stopped.
pause
