#!/bin/bash
set -e

echo "[entrypoint] Starting Xvfb virtual display..."
Xvfb :99 -screen 0 1920x1080x24 -ac &
XVFB_PID=$!
sleep 1

echo "[entrypoint] Starting x11vnc on port 5900..."
x11vnc -display :99 -forever -nopw -rfbport 5900 -shared -bg -o /dev/null 2>&1

export DISPLAY=:99

echo "[entrypoint] Display=$DISPLAY, VNC on :5900"
echo "[entrypoint] Starting worker..."

exec node /app/packages/worker/dist/index.js
