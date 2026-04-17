import { createCanvas, loadImage } from '@napi-rs/canvas';
import { promises as fs } from 'fs';
import path from 'path';

async function main() {
    const inputPath = process.argv[2];
    const hexColor = process.argv[3];
    const outputPath = process.argv[4];

    if (!inputPath || !hexColor || !outputPath) {
        console.error('Usage: tsx dye.ts <input_image> <hex_color> <output_image>');
        process.exit(1);
    }

    try {
        const image = await loadImage(inputPath);
        const canvas = createCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d');

        ctx.drawImage(image, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        const rTarget = parseInt(hexColor.slice(1, 3), 16);
        const gTarget = parseInt(hexColor.slice(3, 5), 16);
        const bTarget = parseInt(hexColor.slice(5, 7), 16);

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const brightness = (r + g + b) / 3;

            if (brightness > 128) {
               data[i] = rTarget;
               data[i+1] = gTarget;
               data[i+2] = bTarget;
            } else {
               data[i] = 0;
               data[i+1] = 0;
               data[i+2] = 0;
            }
        }

        ctx.putImageData(imageData, 0, 0);

        const buffer = canvas.toBuffer('image/jpeg');
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, buffer);
        console.log(`Successfully dyed image and saved to ${outputPath}`);
    } catch (e) {
        console.error("Error applying dye:", e);
    }
}

main();
