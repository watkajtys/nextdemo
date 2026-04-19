# 🍌 Nanobanana Photobooth (Jules at NEXT 2026)

An industry-standard, hardware-accelerated, and completely offline-resilient photobooth kiosk built for a massive 1,500-person tech conference. 

This project demonstrates a robust **Edge vs. Cloud** split architecture, leveraging local hardware for zero-latency capture and physical printing, while asynchronously orchestrating heavy AI storytelling via a cloud VPS and GitHub pull requests.

---

## 🏗️ The Architecture

The system is designed to survive brutal conference Wi-Fi dropouts by cleanly separating "fast" hardware tasks from "slow" AI and network tasks using a **"Golden Thread" ID tracking system**.

### 1. The Edge (Raspberry Pi 5)
The Pi is responsible for the immediate, physical user experience. It runs `BOOTH_ROLE=edge`.
*   **Hardware ISP Pipeline:** A native Python microservice (`scripts/camera_service.py`) uses `Picamera2` to bypass V4L2 lockups. It streams a live MJPEG preview to the React frontend and handles instantaneous, zero-shutter-lag high-res captures.
*   **Local Gemini AI:** The Node.js backend compresses the raw 1080p frame and feeds it to a local Gemini 3.1 Flash model. The prompt aggressively forces a 1-bit, high-contrast cyberpunk anime aesthetic.
*   **Hardware Safety:** The backend runs a mathematical 1-bit thresholding algorithm on the AI output. This guarantees that the USB thermal printer *never* receives grayscale or color pixels, which would otherwise crash the hardware buffer.
*   **The Golden Thread:** The moment the shutter clicks, the Pi generates a deterministic ID (e.g., `portrait-12345`). It prints a physical receipt featuring a QR code linked to that exact ID.
*   **Robust Sync Queue:** To survive network drops, the Pi drops the raw image and the `portraitId` into a local ACID-compliant `better-sqlite3` database. A resilient background worker continuously attempts to stream the binary payload to the VPS over a secure Tailscale VPN.

### 2. The Cloud Orchestrator (VPS)
The Cloud server acts as the asynchronous receiver. It runs `BOOTH_ROLE=cloud`.
*   **Split-Brain Prevention:** Because of the `cloud` role, the VPS bypasses all local Gemini generation and thermal printer hardware checks, preventing redundant API billing and ghost printer crashes.
*   **Jules Integration:** Upon receiving the sync payload from the Pi, the VPS immediately triggers a session using the `@google/jules-sdk`. It passes the raw image and the exact `portraitId` to Jules.
*   **Automated PRs:** Jules writes a localized cyberpunk story based on the image, formats it into a JSON metadata file, and automatically opens and merges a Pull Request back into this GitHub repository.

### 3. The Frontend Experience (React + Vite)
*   **Deterministic PRNG Mosaic:** The public gallery dynamically renders portraits into the shape of the GitHub logo. Instead of random scattering (which breaks spatial history when refreshed), it uses a seeded `mulberry32` PRNG algorithm. This guarantees that "User 151" will ALWAYS appear in the exact same grid slot on every single device—from a mobile phone to the giant conference screens.
*   **Graceful Degradation:** If a user scans their thermal receipt QR code immediately, before Jules has finished merging the PR to GitHub, they do not see a 404 error. The React app intercepts the `?portrait=` parameter and displays a sleek "Uplink Established" overlay that automatically polls GitHub until the data arrives, snapping them instantly into the mosaic.

---

## 🚀 Setup & Installation

### Prerequisites
*   **Hardware:** Raspberry Pi 5, Raspberry Pi HQ Camera, USB Thermal Printer.
*   **Cloud:** A VPS orchestrator (e.g., DigitalOcean, AWS).
*   **Network:** Tailscale installed on both the Pi and the VPS for secure, bypassed-NAT communication.

### 1. Raspberry Pi Setup (The Edge)
1. Clone this repository to `/home/jules/photobooth`.
2. Create your environment file:
   ```bash
   cp .env.example .env
   ```
3. Configure the `.env` file:
   ```env
   BOOTH_ROLE=edge
   GEMINI_API_KEY=your_gemini_key
   BOOTH_SECRET=your_secure_shared_secret
   CLOUD_SERVER_URL=http://your_tailscale_vps_ip:3001
   ```
4. Run the installation script to configure system dependencies, Python, and the autostart daemon:
   ```bash
   bash install.sh
   ```
5. The booth will automatically launch Chromium in Kiosk mode on boot via `start-booth.sh`.

### 2. VPS Setup (The Cloud Orchestrator)
1. Clone this repository to your VPS (e.g., `/opt/nanobanana_backend`).
2. Create your environment file:
   ```bash
   cp .env.example .env
   ```
3. Configure the `.env` file:
   ```env
   BOOTH_ROLE=cloud
   JULES_API_KEY=your_jules_key
   GITHUB_REPO=your_org/your_repo
   BOOTH_SECRET=your_secure_shared_secret
   ```
4. Build and start the Docker container:
   ```bash
   docker build -t nanobanana-orchestrator .
   docker run -d \
     --name nanobanana \
     -p 3001:3001 \
     -v $(pwd)/.env:/app/.env \
     -v $(pwd)/public/portraits:/app/public/portraits \
     -v $(pwd)/public/spool:/app/public/spool \
     nanobanana-orchestrator
   ```

---

## 🛠️ Maintenance & Deployment
The Raspberry Pi utilizes a "Smart Update Architecture". 
Whenever the Pi boots (or the `nanobanana-booth` service restarts), `start-booth.sh` automatically fetches the latest commit from `origin/main`. 
*   If `package.json` changed, it safely runs `npm ci`.
*   If new code is detected, it automatically rebuilds the Vite frontend to flush the JSON data cache before launching the Chromium kiosk. 
*   If no changes are detected, it initiates a "Fast Boot" skipping the npm and Vite steps entirely.