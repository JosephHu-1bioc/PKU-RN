#!/usr/bin/env bash
# 启动本地转写服务（源码模式）
set -euo pipefail

cd "$(dirname "$0")/.."

export HF_HOME="$PWD/service/.cache"
export HUGGINGFACE_HUB_CACHE="$PWD/service/.cache/hub"
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

PY="./service/.venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "[错误] 没找到 service/.venv，请先初始化：" >&2
  echo "    cd service && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

exec "$PY" service/service.py --model auto --device auto --host 127.0.0.1 --port 8765 --media-dir media
