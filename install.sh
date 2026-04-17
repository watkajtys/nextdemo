#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "🍌 Nanobanana Kiosk Automated Installer 🍌"
echo "This script will configure a brand new Raspberry Pi for zero-touch production kiosk mode."

# 1. Update and install required UI / Scanner packages
echo "📦 Installing required system packages (zbar-tools, zenity, unclutter)..."
sudo apt-get update
sudo apt-get install -y zbar-tools zenity unclutter

# 2. Configure the systemd auto-start service
echo "⚙️ Installing Systemd Kiosk Service..."
if [ -f "nanobanana-booth.service" ]; then
    # Copy the service file to the system directory
    sudo cp nanobanana-booth.service /etc/systemd/system/
    
    # Secure permissions
    sudo chmod 644 /etc/systemd/system/nanobanana-booth.service
    
    # Reload systemd to recognize the new file
    sudo systemctl daemon-reload
    
    # Enable the service so it runs automatically on every boot
    sudo systemctl enable nanobanana-booth.service
    
    echo "✅ Auto-boot service installed and enabled!"
else
    echo "❌ Error: nanobanana-booth.service file missing from current directory!"
    exit 1
fi

echo ""
echo "🎉 Installation Complete!"
echo "Your Raspberry Pi is now fully configured as a Nanobanana Kiosk."
echo "On the next reboot, it will automatically launch the photobooth."
echo ""
echo "To manually start it right now without rebooting, run:"
echo "sudo systemctl start nanobanana-booth.service"
