import base64
from PIL import Image, ImageFile
import io
import sys
import json

ImageFile.LOAD_TRUNCATED_IMAGES = True

base64_str = sys.argv[1]
if base64_str.startswith("data:image"):
    base64_str = base64_str.split(",")[1]

# pad to multiple of 4
padding = len(base64_str) % 4
if padding != 0:
    base64_str += "=" * (4 - padding)

img_data = base64.b64decode(base64_str)
img = Image.open(io.BytesIO(img_data)).convert("RGBA")

# Vibrant Cyan
target_color = (0, 255, 255, 255) # Cyan #00FFFF
hex_color = "#00FFFF"

pixels = img.load()
for y in range(img.height):
    for x in range(img.width):
        r, g, b, a = pixels[x, y]
        if r > 128 and g > 128 and b > 128:
            pixels[x, y] = target_color
        else:
            pixels[x, y] = (0, 0, 0, 255)

img.save("public/portraits/portrait-1776401874797.png")
print("Saved to public/portraits/portrait-1776401874797.png")

with open("src/data/portraits/portrait-1776401874797.json", "w") as f:
    json.dump({
        "id": "nanobanana-portrait-1776401874797",
        "color": hex_color,
        "julesThoughtProcess": "Cyan represents high-tech and fits the cyberpunk theme perfectly. I chose to not add explicit x, y coordinates so the app automatically assigns it to an empty spot in the quadtree mosaic, creating a dynamic visual.",
        "storyPanel": "A rogue data runner known as 'The Glitch'. Captured mid-sprint through the neon-drenched alleys of Sector 4. Their cyan signature always preceeds a system crash.",
        "imageUrl": "/portraits/portrait-1776401874797.png"
    }, f, indent=2)
print("Saved to src/data/portraits/portrait-1776401874797.json")
