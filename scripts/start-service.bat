@echo off
chcp 65001 >nul
cd /d "%~dp0.."

set "HF_HOME=%~dp0..\service\.cache"
set "HUGGINGFACE_HUB_CACHE=%~dp0..\service\.cache\hub"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

echo ============================================================
echo  课堂实录回放笔记 - 本地转写服务（源码模式）
echo  请保持这个窗口开着；关闭窗口 = 停止转写服务
echo ============================================================
echo.

if not exist "service\.venv\Scripts\python.exe" (
  echo [错误] 没找到 service\.venv，请先初始化：
  echo     cd service
  echo     python -m venv .venv
  echo     .venv\Scripts\pip install -r requirements.txt
  echo.
  pause
  exit /b 1
)

"service\.venv\Scripts\python.exe" "service\service.py" --model auto --device auto --host 127.0.0.1 --port 8765 --media-dir "media"
echo.
echo 服务已停止。
pause
