#!/bin/bash

# Best Practice: Exit immediately if a command exits with a non-zero status
set -e

echo "📸 Starting up the Nanobanana Photobooth..."

echo -e "\n⏳ Auto-boot sequence initiated..."
echo "🛑 Press and hold ENTER (Arcade Button) NOW to cancel auto-boot and drop to shell..."
# The -t 5 flag waits 5 seconds. The -n 1 flag captures any single keystroke instantly.
if read -t 5 -n 1; then
    echo -e "\n\n🛑 Boot canceled by user input. Dropping to shell."
    exit 0
fi
echo -e "\n🚀 Proceeding with startup sequence..."

# Bulletproof: Kill any zombie processes from previous crashed runs before starting
echo "🧹 Cleaning up old processes..."
pkill -f "chromium" || true
pkill -f "server/index.ts" || true
pkill -f "unclutter" || true

# Bulletproof: Define trap EARLY so if the script fails during startup, we still clean up!
# Best Practice: Use a dedicated cleanup function with set +e inside it.
# If set -e is active inside the trap and a 'kill' fails (process already dead),
# the trap itself would abort, leaving zombie processes behind.
cleanup() {
    set +e
    echo "🛑 Shutting down Photobooth..."
    kill $SERVER_PID $UNCLUTTER_PID $CHROMIUM_PID 2>/dev/null
    wait $SERVER_PID $CHROMIUM_PID 2>/dev/null
    echo "👋 Photobooth stopped."
}
trap cleanup SIGINT SIGTERM EXIT


# Best Practice: Robust path resolution (handles symlinks gracefully)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
cd "$SCRIPT_DIR"

export DISPLAY=:0

echo "🩺 Running Pi Doctor..."
if [ -f "./pi-doctor.sh" ]; then
    bash ./pi-doctor.sh
else
    echo "⚠️ pi-doctor.sh not found. Skipping doctor checks."
fi

# --- SMART UPDATE ARCHITECTURE ---
# 1. Fetch metadata gently without touching local files
echo "⬇️ Checking GitHub for new updates..."
# Timeout prevents hanging if internet verification passed but github is unreachable
timeout 10s git fetch origin main || true

# Get local and remote commit hashes
LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "local_empty")
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "remote_empty")

if [ "$LOCAL" != "$REMOTE" ] && [ "$REMOTE" != "remote_empty" ]; then
    echo "✨ New code discovered! Preparing to update..."
    
    # Check if package-lock.json or package.json is about to be overwritten
    NEEDS_NPM=0
    if git diff --name-only HEAD origin/main | grep -qE "package-lock\.json|package\.json"; then
        NEEDS_NPM=1
        echo "📦 Dependency changes detected in the new commit."
    fi

    # Safely pull the new code
    git pull origin main || true
    
    if [ "$NEEDS_NPM" -eq 1 ]; then
        echo "📦 Re-installing dependencies..."
        if [ -f "package-lock.json" ]; then
            if ! npm ci --prefer-offline --no-audit; then
                echo "⚠️ npm ci failed! Attempting AUTO-FIX by clearing node_modules..."
                rm -rf node_modules
                npm ci --no-audit
            fi
        else
            if ! npm install --no-audit; then
                echo "⚠️ npm install failed! Attempting AUTO-FIX by clearing node_modules..."
                rm -rf node_modules
                npm install --no-audit
            fi
        fi
    else
         echo "⏩ No dependency changes detected. Skipping npm update for a fast boot!"
    fi
else
    echo "⏩ Code is completely up to date. Fast Boot Enabled."
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
# In production, this server now also serves the static files from /dist
npm run start:server > server.log 2>&1 &
SERVER_PID=$!

# Best Practice: Port Polling. Instead of an arbitrary 'sleep', we wait for the port to open.
# This prevents the white screen of death if Chromium launches faster than Vite.
echo "⏳ Waiting for backend server to become available on port 3001..."
MAX_RETRIES=60
RETRY_COUNT=0
# Loop until a curl to localhost:3001 succeeds
while ! curl --output /dev/null --silent --head --fail http://localhost:3001; do
    sleep 0.5
    RETRY_COUNT=$((RETRY_COUNT+1))
    if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
        echo "❌ Timeout waiting for server on port 3001"
        # We clean up everything if the server never comes online
        kill $SERVER_PID $UNCLUTTER_PID 2>/dev/null || true
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
# --use-fake-ui-for-media-stream: Automatically accepts the "Allow Camera Permissions" popup for our HTML5 logic
# --disable-dev-shm-usage: CRITICAL FOR PI. Prevents Chromium from overflowing the tiny /dev/shm shared memory cache and crashing.
# --js-flags="--max-old-space-size=512": Caps the Javascript V8 engine RAM usage to 512MB to prevent long-term memory leaks.
# --no-first-run: Suppresses the "Welcome to Chromium!" first-run wizard.
# --disable-features=Translate,TranslateUI: Prevents a translate bar from appearing over the UI.
# --disable-background-networking: Stops Chromium from phoning home for telemetry/safebrowsing over conference wifi.
# --disable-sync: Disables all sync features since there is no user profile.
# --autoplay-policy=no-user-gesture-required: Allows media to play automatically.
# --disk-cache-dir=/tmp/chromium-cache: Use a real temp dir instead of /dev/null to avoid errors.
CHROMIUM_FLAGS="--kiosk --incognito --disable-pinch --overscroll-history-navigation=0 --noerrdialogs --disable-infobars --disable-session-crashed-bubble --check-for-update-interval=31536000 --use-fake-ui-for-media-stream --disable-dev-shm-usage --no-first-run --disable-features=Translate,TranslateUI --disable-background-networking --disable-sync --autoplay-policy=no-user-gesture-required --disk-cache-dir=/tmp/chromium-cache --js-flags=\"--max-old-space-size=512\""

# Note: Temporarily disable set -e here because if Chromium crashes/is closed, 
# we want the script to continue to the standard trap and shutdown correctly.
set +e

# Bulletproof: Run Chromium in the background so we can monitor all crashes simultaneously
if command -v chromium-browser &> /dev/null; then
    chromium-browser $CHROMIUM_FLAGS http://localhost:3001 &
    CHROMIUM_PID=$!
elif command -v chromium &> /dev/null; then
    chromium $CHROMIUM_FLAGS http://localhost:3001 &
    CHROMIUM_PID=$!
else
    echo "🌍 Chromium not found. Open http://localhost:3001 in your browser!"
    # Since we didn't start Chromium, we just fallback to waiting on the servers
    wait -n $SERVER_PID
    exit
fi

# Best Practice: 'wait -n' waits for ANY of the background processes to exit.
# This means if Chromium, the backend, OR the frontend crashes, the entire script cleanly exits.
# If wrapped in an OS service (like systemd), this ensures the whole booth automatically restarts instantly!
wait -n $SERVER_PID $CHROMIUM_PID
