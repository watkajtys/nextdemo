#!/bin/bash

# Best Practice: Exit immediately if a command exits with a non-zero status
set -e

echo "📸 Starting up the Nanobanana Photobooth..."

# Bulletproof: Kill any zombie processes from previous crashed runs before starting
echo "🧹 Cleaning up old processes..."
pkill -f "chromium" || true
pkill -f "node" || true
pkill -f "unclutter" || true

# Bulletproof: Define trap EARLY so if the script fails during startup, we still clean up!
trap 'echo "🛑 Shutting down Photobooth..."; kill $SERVER_PID $VITE_PID $UNCLUTTER_PID $CHROMIUM_PID 2>/dev/null || true; exit' SIGINT SIGTERM EXIT


# Best Practice: Robust path resolution (handles symlinks gracefully)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
cd "$SCRIPT_DIR"

echo "⬇️ Fetching latest updates from GitHub..."
# We use || true so that if the Pi is offline/has no WiFi, 
# 'git pull' failing won't crash the script due to 'set -e'.
# It will just gracefully skip and run the local code!
git pull || true

echo "📦 Checking dependencies..."
# Best Practice: 'npm ci' is preferred over 'npm install' for production/demos.
# It strictly uses the lockfile, is usually faster, and guarantees exact versions.
# We also skip audits to speed up booting.
if [ -f "package-lock.json" ]; then
    npm ci --prefer-offline --no-audit
else
    npm install --no-audit
fi

echo "🔑 Checking for configuration..."
if [ ! -f ".env" ]; then
    echo "⚠️ No .env file found! Creating one from .env.example..."
    cp .env.example .env
    echo "Please make sure to add your GEMINI_API_KEY to the .env file later!"
fi

# Best Practice: Disable screensaver, power management, and hide the mouse for a kiosk
echo "🖥️ Configuring display for Kiosk mode..."
export DISPLAY=:0
# Prevent screen from blanking (requires xset)
if command -v xset &> /dev/null; then
    xset s off || true
    xset -dpms || true
    xset s noblank || true
fi
# Hide mouse cursor (requires 'unclutter' to be installed on the Pi)
if command -v unclutter &> /dev/null; then
    unclutter -idle 0.1 -root &
    UNCLUTTER_PID=$!
fi

echo "🚀 Starting servers..."

# Start the Node/Express backend in the background
npm run start:server &
SERVER_PID=$!

# Start the Vite frontend in the background
npm run dev &
VITE_PID=$!

# Best Practice: Port Polling. Instead of an arbitrary 'sleep', we wait for the port to open.
# This prevents the white screen of death if Chromium launches faster than Vite.
echo "⏳ Waiting for frontend server to become available on port 3000..."
MAX_RETRIES=60
RETRY_COUNT=0
# Loop until a curl to localhost:3000 succeeds
while ! curl --output /dev/null --silent --head --fail http://localhost:3000; do
    sleep 0.5
    RETRY_COUNT=$((RETRY_COUNT+1))
    if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
        echo "❌ Timeout waiting for server on port 3000"
        # We clean up everything if the server never comes online
        kill $SERVER_PID $VITE_PID $UNCLUTTER_PID 2>/dev/null || true
        exit 1
    fi
done
echo "✅ Server is up!"

echo "🖥️ Launching Kiosk UI..."

# Best Practice: Hardened Kiosk flags for a seamless demo experience:
# --noerrdialogs: Prevents "Chromium crashed, restore tabs?" messages
# --disable-infobars: Removes "Chromium is not your default browser" UI
# --disable-session-crashed-bubble: Prevents more crash bubbles
# --check-for-update-interval=31536000: Disables update checks completely
CHROMIUM_FLAGS="--kiosk --incognito --disable-pinch --overscroll-history-navigation=0 --noerrdialogs --disable-infobars --disable-session-crashed-bubble --check-for-update-interval=31536000"

# Note: Temporarily disable set -e here because if Chromium crashes/is closed, 
# we want the script to continue to the standard trap and shutdown correctly.
set +e

# Bulletproof: Run Chromium in the background so we can monitor all crashes simultaneously
if command -v chromium-browser &> /dev/null; then
    chromium-browser $CHROMIUM_FLAGS http://localhost:3000 &
    CHROMIUM_PID=$!
elif command -v chromium &> /dev/null; then
    chromium $CHROMIUM_FLAGS http://localhost:3000 &
    CHROMIUM_PID=$!
else
    echo "🌍 Chromium not found. Open http://localhost:3000 in your browser!"
    # Since we didn't start Chromium, we just fallback to waiting on the servers
    wait -n $SERVER_PID $VITE_PID
    exit
fi

# Best Practice: 'wait -n' waits for ANY of the background processes to exit.
# This means if Chromium, the backend, OR the frontend crashes, the entire script cleanly exits.
# If wrapped in an OS service (like systemd), this ensures the whole booth automatically restarts instantly!
wait -n $SERVER_PID $VITE_PID $CHROMIUM_PID
