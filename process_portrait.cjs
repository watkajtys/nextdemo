const fs = require('fs');
const { createCanvas, loadImage, Image } = require('@napi-rs/canvas');

async function processImage() {
  const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQMAAABmvDolAAACs0lEQVR42u3csa2rMBTG8X/FvNfSDB0N01iBKVhBswojZAEoGKKNPU68O3fP/xN0gDwnv49EAgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALBfrwVf9nO1X0wz2K8nC77s6Xo7mGYw02O+7Of6P9X+bJvBTAf95P6s2n8N0wzm+h37U38H52UGA21Xn0B/6u/gpMxgqH+xP/V3cE5mMNR32B9PqjW1WQwV6k/8HZyzGAxV6s/7HZy1GAx1Q38M+HcwZjDU1P4wOq0Gg8GexwQGA72OCQx2PiYw2P+YwGAAAwMDAxgYGAAAAAAAAAAAAAAAAAAAAAAA/sD2Yc+H/dzrF1MMzD4s59zZ//31iikGZj8E72nF/7nZJ6YYmH1Yc2cv+4spBmY/7Pmwn3v9YooBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sX2Yc+H/dzrF1MMzD4s59zZ//31iikGZj8E72nF/7nZJ6YYmH1Yc2cv+4spBmY/7Pmwn3v9YooBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwE/rNeHLfq72i0kG+3Wv8GU/19vRJMOMj/myT9f/qfZnmwzmeuwn92fV/muZZDDXd+xP/R0c1yQDXVefQH/q7+C4Jhnouv7F/tTfwXFNMtB1fcf+eFKtqc0y0FWoP/F3cNySZKDrUv15v4PjliQDXTc0R70/GIclSUbX1N/BGU2S0fV9TGAy2HxMYDKYz8cEJgMYGBgYwMDAwAAAAAAAAAAAAAAAAAAAAAAAsF+vBV/2c7VfTDPYrycLvuzpejuYZjDTY77s5/o/1f5sm8FMB/3k/qzafw3TDOb6HftTfAfnZQYDbVefQH8q7uCkzGCoX+xP8R2ckxkM9Rv2J5NqzWwWQ4X6U3EH5ywGQ5X6U38HZy0GQ93QH/07GLMYamp/7n1Wg8Fgz2MCg4FexwQGOx8TGOx/TGAwgIGBgQEMDAwMAAAAAAAAAAAAAAAAAAAAAAAAwC/7C0j8e1/1A52+AAAAAElFTkSuQmCC";

  const image = await loadImage(`data:image/png;base64,${base64Data}`);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;

  // Replace white pixels with electric yellow #FFEA00
  // R=255, G=234, B=0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) {
      data[i] = 255;
      data[i + 1] = 234;
      data[i + 2] = 0;
    }
  }

  ctx.putImageData(imgData, 0, 0);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync('public/portraits/portrait-1776464894866.png', buffer);
  console.log('Saved to public/portraits/portrait-1776464894866.png');
}

processImage().catch(console.error);
