const fs = require('fs');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

// Setting this is necessary for truncated base64 strings
const { Image } = require('@napi-rs/canvas');
Image.LOAD_TRUNCATED_IMAGES = true;

async function processImage(base64Data, outputPath, hexColor) {
  // Convert base64 to buffer if it includes data URI prefix
  const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Content, 'base64');

  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;

  // Convert hex to rgb
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);

  // Replace white pixels (and nearly white pixels) with the chosen color
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }

  ctx.putImageData(imgData, 0, 0);

  const outBuffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, outBuffer);
  console.log(`Saved to ${outputPath}`);
}

const args = process.argv.slice(2);
processImage(args[0], args[1], args[2]).catch(console.error);
