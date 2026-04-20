#!/bin/bash

# Define colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}  🩺 Nanobanana Pi Doctor 🩺          ${NC}"
echo -e "${BLUE}======================================${NC}"

# Track if any critical checks fail
CRITICAL_ERROR=0

echo -e "\n${YELLOW}1. Network Connectivity checks...${NC}"

# Check Ethernet
if ip link show eth0 2>/dev/null | grep -q "state UP"; then
    ETH_IP=$(ip -4 addr show eth0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1)
    if [ -n "$ETH_IP" ]; then
        echo -e "  [${GREEN}OK${NC}] Ethernet (eth0) is CONNECTED - IP: ${ETH_IP}"
        echo -e "         ${BLUE}Hint: Since Ethernet is active, Wi-Fi is optional!${NC}"
    else
        echo -e "  [${YELLOW}WARN${NC}] Ethernet cable detected but no IP assigned. Check DHCP."
    fi
else
    echo -e "  [${BLUE}INFO${NC}] Ethernet (eth0) is disconnected."
fi

# Check WiFi
if ip link show wlan0 2>/dev/null | grep -q "state UP"; then
    WIFI_IP=$(ip -4 addr show wlan0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1)
    if [ -n "$WIFI_IP" ]; then
        echo -e "  [${GREEN}OK${NC}] WiFi (wlan0) is CONNECTED - IP: ${WIFI_IP}"
    else
        echo -e "  [${YELLOW}WARN${NC}] WiFi is UP but not connected to a network."
    fi
else
    echo -e "  [${BLUE}INFO${NC}] WiFi (wlan0) is not active."
fi

# Check Tailscale
if command -v tailscale &> /dev/null; then
    TS_IP=$(tailscale ip -4 2>/dev/null || echo "")
    if [ -n "$TS_IP" ]; then
        echo -e "  [${GREEN}OK${NC}] Tailscale connected - IP: ${TS_IP}"
    else
        echo -e "  [${YELLOW}WARN${NC}] Tailscale is installed but not connected."
    fi
else
    echo -e "  [${YELLOW}WARN${NC}] Tailscale is NOT installed!"
fi

# Check DNS Health (Common Kiosk Failure Point)
if command -v nslookup &> /dev/null; then
    if nslookup google.com &> /dev/null; then
        echo -e "  [${GREEN}OK${NC}] DNS resolution is working"
    else
        echo -e "  [${RED}FAIL${NC}] DNS resolution FAILED! (Wi-Fi connected but no internet/DNS)"
        CRITICAL_ERROR=1
    fi
fi

# Check Internet Access (Industry Standard Captive Portal Check)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -m 3 http://clients3.google.com/generate_204 || echo "000")
if [ "$STATUS" == "204" ]; then
    echo -e "  [${GREEN}OK${NC}] Internet connection verified (204 No Content / No Captive Portal)"
else
    echo -e "  [${RED}FAIL${NC}] No internet connection detected!"
    
    echo -e "\n  ${YELLOW}🖥️  MANUAL NETWORK SETUP 🖥️${NC}"
    if command -v zenity &> /dev/null; then
        # Robust Display Detection for 2026 (Wayland vs X11)
        if [ -n "$WAYLAND_DISPLAY" ]; then
            echo -e "  [${BLUE}INFO${NC}] Wayland session detected ($WAYLAND_DISPLAY)"
        elif [ -n "$DISPLAY" ]; then
            echo -e "  [${BLUE}INFO${NC}] X11 session detected ($DISPLAY)"
        else
            export DISPLAY=:0
            echo -e "  [${BLUE}INFO${NC}] No display env found, forcing DISPLAY=:0"
        fi
        
        if zenity --question --title="Network Setup" --text="No internet connection detected.\n\nEthernet unplugged? Check cable.\nWiFi disconnected? Use your phone hotspot.\n\nWould you like to open the Network Manager to connect manually?" --timeout=20; then
            echo -e "  ${BLUE}Opening GUI Network Manager and On-Screen Keyboard...${NC}"
            echo -e "  ${BLUE}Hint: For iPhone hotspots, ensure 'Maximize Compatibility' is ON.${NC}"
            
            # Launch tools and track PIDs for surgical cleanup
            nm-connection-editor &
            NM_PID=$!
            
            # On-screen keyboard for the touch screen
            if command -v onboard &> /dev/null; then
                onboard &
                KBD_PID=$!
            elif command -v matchbox-keyboard &> /dev/null; then
                matchbox-keyboard &
                KBD_PID=$!
            fi
            
            # Browser for Captive Portals
            if command -v chromium &> /dev/null; then
                chromium http://neverssl.com &
                BROWSER_PID=$!
            fi

            zenity --info --title="Pro-Tips for Staff" --text="1. Wi-Fi: Look for your phone's hotspot.\n2. Captive Portal: If a login page is required, it will open in the browser.\n3. Keyboard: Tap any text field to use the on-screen keyboard.\n\nClick OK when you are connected." --timeout=20
            
            # Final verification
            STATUS=$(curl -s -o /dev/null -w "%{http_code}" -m 3 http://clients3.google.com/generate_204 || echo "000")
            if [ "$STATUS" == "204" ]; then
                echo -e "  [${GREEN}OK${NC}] Internet connected successfully via manual setup!"
            else
                CRITICAL_ERROR=1
                echo -e "  [${RED}FAIL${NC}] Still no internet connection after manual setup."
            fi
            
            # Surgical Cleanup using PIDs
            kill $NM_PID $KBD_PID $BROWSER_PID 2>/dev/null
            sleep 1
            kill -9 $NM_PID $KBD_PID $BROWSER_PID 2>/dev/null
        else
            CRITICAL_ERROR=1
            echo -e "  [${YELLOW}WARN${NC}] Proceeding without verified internet connection."
        fi
    else
        CRITICAL_ERROR=1
        echo -e "  [${YELLOW}WARN${NC}] Zenity not found. Cannot launch manual setup GUI."
    fi
fi

echo -e "\n${YELLOW}2. Storage & Memory checks...${NC}"

# Check Read/Write access in current directory
TEST_FILE=".doctor_test_file"
if touch "$TEST_FILE" 2>/dev/null; then
    echo -e "  [${GREEN}OK${NC}] Current directory is writable"
    rm -f "$TEST_FILE"
else
    echo -e "  [${RED}FAIL${NC}] Current directory is NOT writable! (SSD might be corrupted/read-only)"
    CRITICAL_ERROR=1
fi

# Check Disk Space (in MB)
FREE_SPACE=$(df -m . | awk 'NR==2 {print $4}')
if [ -n "$FREE_SPACE" ]; then
    if [ "$FREE_SPACE" -lt 1024 ]; then
        echo -e "  [${YELLOW}WARN${NC}] Low disk space! Only ${FREE_SPACE}MB left."
    else
        echo -e "  [${GREEN}OK${NC}] Disk space is healthy (${FREE_SPACE}MB left)"
    fi
else
    echo -e "  [${YELLOW}WARN${NC}] Could not determine free disk space"
fi

# Check Total System RAM
if command -v free &> /dev/null; then
    TOTAL_RAM=$(free -m | awk '/^Mem:/{print $2}')
    FREE_RAM=$(free -m | awk '/^Mem:/{print $7}')
    echo -e "  [${GREEN}OK${NC}] RAM: ${TOTAL_RAM}MB Total (${FREE_RAM}MB Available)"
fi

echo -e "\n${YELLOW}3. Hardware & Peripherals...${NC}"

# Check Camera
if ls /dev/video* &> /dev/null; then
    echo -e "  [${GREEN}OK${NC}] Camera detected (/dev/video found)"
else
    echo -e "  [${RED}FAIL${NC}] No camera detected! (/dev/video not found)"
    CRITICAL_ERROR=1
fi

# Check USB devices
if command -v lsusb &> /dev/null; then
    USB_COUNT=$(lsusb 2>/dev/null | wc -l)
    if [ "$USB_COUNT" -gt 0 ]; then
        echo -e "  [${GREEN}OK${NC}] $USB_COUNT USB device(s) connected."
    else
        echo -e "  [${YELLOW}WARN${NC}] No USB devices detected via lsusb."
    fi
else
    echo -e "  [${YELLOW}WARN${NC}] lsusb command not found, skipping USB check."
fi

# Check CUPS & Printer availability
if command -v lpstat &> /dev/null; then
    echo -e "  [${GREEN}OK${NC}] CUPS Print Server (lpstat) is installed."
    PRINTER_COUNT=$(lpstat -p 2>/dev/null | grep -c "printer")
    if [ "$PRINTER_COUNT" -gt 0 ]; then
        echo -e "  [${GREEN}OK${NC}] $PRINTER_COUNT printer(s) configured in CUPS."
    else
        echo -e "  [${YELLOW}WARN${NC}] CUPS is installed, but no printers are configured. Labels will not print physically!"
    fi
else
    echo -e "  [${RED}FAIL${NC}] CUPS is NOT installed! (Run: sudo apt-get install cups cups-client)"
    CRITICAL_ERROR=1
fi

# Check Pi Power Supply / Undervoltage (Silent Killer of Kiosks)
if command -v vcgencmd &> /dev/null; then
    THROTTLE_HEX=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)
    # 0x0 is completely healthy. 
    # 0x50000 means it occurred in the past (warn). 
    # Anything ending in 1 (e.g. 0x50005) means it is currently undervolting and throttling CPU!
    if [ "$THROTTLE_HEX" == "0x0" ]; then
        echo -e "  [${GREEN}OK${NC}] Power Supply is healthy (No Undervoltage/Throttling detected)"
    elif [[ "$THROTTLE_HEX" == *1 || "$THROTTLE_HEX" == *5 || "$THROTTLE_HEX" == *9 || "$THROTTLE_HEX" == *d ]]; then
         echo -e "  [${RED}FAIL${NC}] ⚡ ACTIVE UNDERVOLTAGE! The Pi is currently throttling CPU speed. Replace your power supply!"
         CRITICAL_ERROR=1
    else
         echo -e "  [${YELLOW}WARN${NC}] Historical undervoltage detected since boot. Your power supply may be inadequate during peak load."
    fi
fi

# Check Hardware Watchdog (Industry Standard for 24/7 Kiosks)
if [ -f "/boot/firmware/config.txt" ]; then
    if grep -q "dtparam=watchdog=on" /boot/firmware/config.txt; then
        echo -e "  [${GREEN}OK${NC}] Hardware Watchdog is enabled in config.txt"
    else
        echo -e "  [${YELLOW}WARN${NC}] Hardware Watchdog is DISABLED. The Pi cannot auto-reboot on a hard freeze."
    fi
fi

echo -e "\n${YELLOW}4. Software Prerequisites...${NC}"

# Check Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    echo -e "  [${GREEN}OK${NC}] Node.js installed ($NODE_VERSION)"
else
    echo -e "  [${RED}FAIL${NC}] Node.js is NOT installed!"
    CRITICAL_ERROR=1
fi

# Check npm
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm -v)
    echo -e "  [${GREEN}OK${NC}] npm installed ($NPM_VERSION)"
else
    echo -e "  [${RED}FAIL${NC}] npm is NOT installed!"
    CRITICAL_ERROR=1
fi

# Check git
if command -v git &> /dev/null; then
    echo -e "  [${GREEN}OK${NC}] git is installed"
else
    echo -e "  [${RED}FAIL${NC}] git is NOT installed!"
    CRITICAL_ERROR=1
fi

echo -e "\n${YELLOW}5. System & Environment Config...${NC}"

# Check System Time (Critical for SSL)
current_year=$(date +%Y)
if [ "$current_year" -lt 2024 ]; then
    echo -e "  [${RED}FAIL${NC}] System clock is incorrect (Year: $current_year)! SSL to Gemini API will fail!"
    echo -e "         ${YELLOW}Attempting automatic time sync via HTTP proxy bypass...${NC}"
    
    # Auto-Fix time by scraping Google's HTTP headers (works often when NTP is blocked)
    # sudo -n: Prevents the boot sequence from completely freezing if a password is required.
    # curl -m 3: Prevents an infinite network hang if packets to Google are blackholed.
    if sudo -n date -s "$(curl -s --head -m 3 http://google.com | grep ^Date: | sed 's/Date: //g')" &> /dev/null; then
        new_year=$(date +%Y)
        if [ "$new_year" -ge 2024 ]; then
            echo -e "  [${GREEN}OK${NC}] 🛠️  Auto-fix successful! Time forcibly synced to: $(date)"
        else
            echo -e "  [${RED}FAIL${NC}] ❌ Auto-fix failed. The Pi has no RTC battery. Please connect to internet."
            CRITICAL_ERROR=1
        fi
    else
        echo -e "  [${RED}FAIL${NC}] ❌ Auto-fix failed (requires sudo/internet). Please connect to internet."
        CRITICAL_ERROR=1
    fi
else
    echo -e "  [${GREEN}OK${NC}] System clock appears synchronized (Year: $current_year)"
fi

# Auto-Fix missing .env file
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp .env.example .env
    echo -e "  [${YELLOW}AUTO-FIX${NC}] Created missing .env file from .env.example"
fi

# Check .env for Gemini Key
if [ -f ".env" ]; then
    if grep -q "GEMINI_API_KEY=" .env && ! grep -q "your_api_key_here" .env; then
        echo -e "  [${GREEN}OK${NC}] Appears to have a valid GEMINI_API_KEY in .env"
    else
        echo -e "  [${RED}FAIL${NC}] GEMINI_API_KEY is missing or looks like the default placeholder in .env!"
        CRITICAL_ERROR=1
    fi
else
    echo -e "  [${RED}FAIL${NC}] .env file is missing and could not be auto-created!"
    CRITICAL_ERROR=1
fi

echo -e "\n${BLUE}======================================${NC}"
if [ "$CRITICAL_ERROR" -eq 0 ]; then
    echo -e "${GREEN}✅ All critical checks passed! Pi is healthy.${NC}"
else
    echo -e "${RED}❌ Some critical checks failed. Please review the output above.${NC}"
    
    # NEW: Display a graphical error if Zenity is available so staff can see it on the physical screen
    if command -v zenity &> /dev/null; then
        export DISPLAY=:0
        
        # Build a clear error summary for the UI
        ERR_MSG="Critical errors detected during boot:\n\n"
        
        # Network checks
        if ! command -v tailscale &> /dev/null || [ -z "$(tailscale ip -4 2>/dev/null)" ]; then
            ERR_MSG="$ERR_MSG • Tailscale is disconnected\n"
        fi
        STATUS=$(curl -s -o /dev/null -w "%{http_code}" -m 3 http://clients3.google.com/generate_204 || echo "000")
        if [ "$STATUS" != "204" ]; then
            ERR_MSG="$ERR_MSG • No internet connection\n"
        fi
        
        # Hardware checks
        if ! ls /dev/video* &> /dev/null; then
            ERR_MSG="$ERR_MSG • Camera unplugged or not detected\n"
        fi
        if ! command -v lpstat &> /dev/null || [ "$(lpstat -p 2>/dev/null | grep -c "printer")" -eq 0 ]; then
            ERR_MSG="$ERR_MSG • Thermal printer not found\n"
        fi
        
        # Config checks
        if [ ! -f ".env" ] || grep -q "your_api_key_here" .env; then
            ERR_MSG="$ERR_MSG • Missing or invalid Gemini API Key\n"
        fi

        zenity --error --title="Kiosk Boot Failure" --text="$ERR_MSG\n\nPlease check connections and restart the booth." --timeout=60 &
    fi

    echo -e "${YELLOW}Waiting 10 seconds before attempting to continue...${NC}"
    sleep 10
fi
echo -e "${BLUE}======================================${NC}\n"
