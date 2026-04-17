import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFileSync } from 'fs';

async function dyeImage(inputPath: string, hexColor: string, outputPath: string) {
  const image = await loadImage(inputPath);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(image, 0, 0);

  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = hexColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const buffer = canvas.toBuffer('image/png');
  writeFileSync(outputPath, buffer);
}

const args = process.argv.slice(2);
if (args.length !== 3) {
  console.error('Usage: tsx dye.ts <input_path> <hex_color> <output_path>');
  process.exit(1);
}

dyeImage(args[0], args[1], args[2])
  .then(() => console.log('Image dyed successfully!'))
  .catch((err) => {
    console.error('Failed to dye image:', err);
    process.exit(1);
  });
