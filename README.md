# 🍌 Nanobanana Photobooth (Jules at NEXT 2026)

An industry-standard, hardware-accelerated, and completely offline-resilient photobooth kiosk built for a massive 1,500-person tech conference. 

This project demonstrates a robust **Edge vs. Cloud** split architecture, leveraging local hardware for zero-latency capture and physical printing, while asynchronously orchestrating heavy AI storytelling via a cloud VPS and GitHub pull requests.

---

## 🏗️ High-Level Architecture

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

## 🛡️ Enterprise Kiosk Hardening

The physical kiosk represents a "Top 1%" zero-touch deployment strategy for conference floors. It is designed to self-heal, self-update, and resist physical tampering.

### Zero-Touch Auto-Boot & Self-Healing
*   **Systemd Orchestration:** The entire stack is managed by `nanobanana-booth.service`, ensuring the kiosk boots immediately into the UI when plugged into the wall.
*   **Process Monitor (wait -n):** The `start-booth.sh` script monitors the Node.js backend, the Kiosk UI (Chromium), and the Python Camera Microservice simultaneously. If *any* of them crash, the entire kiosk intentionally restarts within 5 seconds.
*   **Hardware Watchdog:** The Raspberry Pi's Broadcom BCM2835 hardware watchdog is enabled via the Linux kernel. If the OS experiences a total freeze (e.g., kernel panic, thermal lockup), the chip physically cuts power and cold-reboots the Pi.
*   **Nightly Hardware Reboots:** A root cron job (`0 4 * * * /sbin/reboot`) forces a complete hardware reboot at 4:00 AM every night to clear GPU memory leaks and refresh network tunnels.

### Zero-Trust Networking (Tailscale)
*   **NAT Traversal:** The Pi uses Tailscale (WireGuard) to punch through restrictive conference firewalls (Captive Portals, UDP blocking) and communicate securely with the VPS.
*   **VPS Lockdown (Docker Bypass Fix):** The VPS firewall explicitly drops all traffic to port `3001` on the public internet interface (`eth0`) via a custom `iptables DOCKER-USER` rule. The orchestrator API only accepts traffic from the encrypted `tailscale0` interface.
*   **Captive Portal Fallback:** `pi-doctor.sh` attempts to bypass conference Wi-Fi limits. If it hits a Captive Portal, it automatically launches a temporary touchscreen GUI (Network Manager, Onboard Keyboard, and Chromium pointing to `neverssl.com`) to allow staff to accept terms before seamlessly resuming the zero-touch boot sequence.

### Physical Security & UI Lockdown
*   **X11 Lockdown:** The X11 display server is configured to ignore `Ctrl+Alt+F1` (TTY Switch) and `Ctrl+Alt+Backspace` (Server Kill). Malicious "BadUSB" devices cannot drop the kiosk into a root terminal.
*   **Pironman OLED Privacy Patch:** The Pironman 5 case's front OLED screen driver was manually patched (`scripts/patch-oled.sh`) to hide the internal Tailscale IP address from attendees, displaying a clean "jules @ NEXT" brand graphic instead.
*   **Scrollbar Suppression:** Chromium is launched with `--hide-scrollbars` to ensure no desktop UI elements bleed into the kiosk experience if the screen is dragged.

### Over-The-Air (OTA) Updates
*   **Smart Update Architecture:** On boot, the Pi gently fetches metadata from `origin/main`. If an update is found, it presents a `zenity` visual indicator to staff, safely forces a `git reset --hard`, and runs `npm ci` and `npm run build` only if dependencies or source code changed.

---

## 🚀 Setup & Installation

### Prerequisites
*   **Hardware:** Raspberry Pi 5 (NVMe SSD), Arducam 4K HDR Camera, Phomemo USB Thermal Printer, Pironman 5 Case.
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
5. *(Optional)* Patch the Pironman OLED driver for privacy: `bash scripts/patch-oled.sh`

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