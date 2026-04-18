import { loadImage } from '@napi-rs/canvas';
import fs from 'fs/promises';
import path from 'path';

async function check_image_contrast(imagePath: string) {
    try {
        console.log(`🔍 Checking contrast of: ${imagePath}`);
        const image = await loadImage(imagePath);
        const canvas = { width: image.width, height: image.height };
        const { createCanvas } = await import('@napi-rs/canvas');
        const offCanvas = createCanvas(canvas.width, canvas.height);
        const ctx = offCanvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

        let grayscaleCount = 0;
        let blackCount = 0;
        let whiteCount = 0;
        let totalPixels = imageData.length / 4;

        for (let i = 0; i < imageData.length; i += 4) {
            const r = imageData[i];
            const g = imageData[i + 1];
            const b = imageData[i + 2];
            
            if (r === 0 && g === 0 && b === 0) {
                blackCount++;
            } else if (r === 255 && g === 255 && b === 255) {
                whiteCount++;
            } else {
                grayscaleCount++;
            }
        }

        console.log(`📊 Statistics for ${imagePath}:`);
        console.log(`   - Black pixels: ${blackCount} (${((blackCount/totalPixels)*100).toFixed(2)}%)`);
        console.log(`   - White pixels: ${whiteCount} (${((whiteCount/totalPixels)*100).toFixed(2)}%)`);
        console.log(`   - Non-B&W pixels: ${grayscaleCount} (${((grayscaleCount/totalPixels)*100).toFixed(2)}%)`);

        if (grayscaleCount === 0) {
            console.log("✅ Perfect 1-bit image!");
        } else {
            console.log("⚠️ Image contains shades of gray or anti-aliasing.");
        }
    } catch (e) {
        console.error("❌ Failed to check image:", (e as Error).message);
    }
}

// Find the latest portrait in test_output
async function run() {
    const portraitsDir = 'test_output/portraits';
    const spoolDir = 'test_output/spool';
    
    try {
        const pFiles = await fs.readdir(portraitsDir);
        const pPngs = pFiles.filter(f => f.endsWith('.png')).sort().reverse();
        if (pPngs.length > 0) {
            await check_image_contrast(path.join(portraitsDir, pPngs[0]));
        } else {
            console.log("No test portraits found.");
        }

        const sFiles = await fs.readdir(spoolDir);
        const sPngs = sFiles.filter(f => f.endsWith('.png')).sort().reverse();
        if (sPngs.length > 0) {
            await check_image_contrast(path.join(spoolDir, sPngs[0]));
        } else {
            console.log("No test labels found in spool.");
        }
    } catch (e) {
        console.error("Failed to run check:", (e as Error).message);
    }
}

run();
