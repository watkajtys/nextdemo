#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "🔧 Patching Pironman 5 OLED Driver to hide IP addresses..."

# Best Practice: Robust path resolution
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
cd "$SCRIPT_DIR"

cat << 'EOF' > /tmp/patch_oled.py
import os

mix_path = '/opt/pironman5/venv/lib/python3.13/site-packages/pm_auto/addons/oled/pages/mix.py'
if os.path.exists(mix_path):
    with open(mix_path, 'r') as f:
        content = f.read()

    # The original unpatched block we want to replace
    old_mix_original = """            interface, ip = next(islice(ips.items(), self.ip_index, self.ip_index + 1))
            if interface.startswith('eth') or interface.startswith('en'):
                oled.draw_icon(ethernet_icon, 0, 0, scale=1, invert=False,  dither=False, threshold=80)
                oled.draw_text(f'{ip}', 22, 0, size=14, font_path=font)
            elif interface.startswith('wlan') or interface.startswith('wl'):
                oled.draw_icon(wifi_icon, 0, 0, scale=1, invert=False, dither=False, threshold=85)
                oled.draw_text(f'{ip}', 22, 0, size=14, font_path=font)"""
                
    # In case it was already partially patched by our previous iteration
    old_mix_partial = """            interface, ip = next(islice(ips.items(), self.ip_index, self.ip_index + 1))
            oled.draw_icon(net_icon, 0, 0, scale=1, invert=False, dither=False, threshold=80)
            oled.draw_text('Jules@ NEXT', 22, 0, size=14, font_path=font)"""

    new_mix = "            oled.draw_text('jules @ NEXT', 10, 0, size=14, font_path=font)"

    if old_mix_original in content:
        content = content.replace(old_mix_original, new_mix)
        with open(mix_path, 'w') as f:
            f.write(content)
        print('mix.py patched successfully from original state')
    elif old_mix_partial in content:
        content = content.replace(old_mix_partial, new_mix)
        with open(mix_path, 'w') as f:
            f.write(content)
        print('mix.py patched successfully from partial state')
    elif new_mix in content:
        print('mix.py is already fully patched.')
    else:
        print('Warning: mix.py string mismatch - driver may have been updated by vendor.')
else:
    print('Warning: mix.py not found. Pironman driver might not be installed.')


ips_path = '/opt/pironman5/venv/lib/python3.13/site-packages/pm_auto/addons/oled/pages/ips.py'
if os.path.exists(ips_path):
    with open(ips_path, 'r') as f:
        content = f.read()

    # The original unpatched block we want to replace
    old_ips_original = """            _iter = islice(ips.items(), self.ip_index, self.ip_index + 3)

            for i in range(3):
                try:
                    interface, ip = next(_iter)
                    if interface.startswith('eth') or interface.startswith('en'):
                        oled.draw_icon(ethernet_icon, 0, i*22, scale=1, invert=False,  dither=False, threshold=80)
                        oled.draw_text(f'{ip}', 22, i * 22, size=14, font_path=font)
                    elif interface.startswith('wlan') or interface.startswith('wl'):
                        oled.draw_icon(wifi_icon, 0, i*22, scale=1, invert=False, dither=False, threshold=85)
                        oled.draw_text(f'{ip}', 22, i * 22, size=14, font_path=font)
                except StopIteration:
                    break"""
                    
    # In case it was already partially patched by our previous iteration
    old_ips_partial = """            _iter = islice(ips.items(), self.ip_index, self.ip_index + 3)

            for i in range(3):
                try:
                    interface, ip = next(_iter)
                    oled.draw_icon(net_icon, 0, i*22, scale=1, invert=False, dither=False, threshold=80)
                    oled.draw_text('Jules@ NEXT', 22, i * 22, size=14, font_path=font)
                except StopIteration:
                    break"""

    new_ips = "            oled.draw_text('jules @ NEXT', 10, 22, size=14, font_path=font)"

    if old_ips_original in content:
        content = content.replace(old_ips_original, new_ips)
        with open(ips_path, 'w') as f:
            f.write(content)
        print('ips.py patched successfully from original state')
    elif old_ips_partial in content:
        content = content.replace(old_ips_partial, new_ips)
        with open(ips_path, 'w') as f:
            f.write(content)
        print('ips.py patched successfully from partial state')
    elif new_ips in content:
        print('ips.py is already fully patched.')
    else:
        print('Warning: ips.py string mismatch - driver may have been updated by vendor.')
else:
    print('Warning: ips.py not found. Pironman driver might not be installed.')
EOF

# Execute the python patch script
sudo python3 /tmp/patch_oled.py

# Restart the OLED service to apply the visual changes instantly
if systemctl is-active --quiet pironman5.service; then
    echo "♻️ Restarting Pironman 5 service..."
    sudo systemctl restart pironman5.service
    echo "✅ OLED successfully patched and restarted!"
else
    echo "⚠️ Pironman 5 service is not currently running."
fi