import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import fs from 'fs/promises';
import path from 'path';
import QRCode from 'qrcode';

const PORT = process.env.PORT || 3001;
const UPLOADS_DIR = path.join(process.cwd(), 'test_output', 'portraits');
const SPOOL_DIR = path.join(process.cwd(), 'test_output', 'spool');
const TEST_IMAGE_PATH = '/home/jules/test_1080.jpg';

async function initStorage() {
    [UPLOADS_DIR, SPOOL_DIR].forEach(async dir => {
        try { await fs.access(dir); } catch { await fs.mkdir(dir, { recursive: true }); }
    });
}

async function test_image_handling() {
    await initStorage();
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
    
    console.log(`📖 Loading test image: ${TEST_IMAGE_PATH}`);
    const imageBuffer = await fs.readFile(TEST_IMAGE_PATH);
    const portraitId = `test-portrait-${Date.now()}`;

    console.log('🎨 Starting local Gemini stylization...');
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-image-preview',
            config: { responseModalities: ['TEXT', 'IMAGE'] },
            contents: [
                { text: "CRITICAL INSTRUCTION: You are optimizing an image for a low-resolution thermal receipt printer. Completely REDRAW the subject from scratch as a highly simplified 1990s cyberpunk anime character. You MUST use extreme 1-bit high contrast. ABSOLUTELY NO SHADING OF ANY KIND. NO GRAY. NO STIPPLING. NO CROSS-HATCHING. NO FINE DETAILS. Use ONLY thick, solid black outlines and massive, flat shapes of pure black ink against a pure white background. The geometry must be sharp and exaggerated, but the rendering must be as simple and bold as a stencil or linocut. Abandon all photographic realism. ABSOLUTELY NO TEXT. NO WATERMARKS. NO SIGNATURES." },
                { inlineData: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } }
            ]
        });

        const part = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
        if (part && (part as any).inlineData) {
            const stylizedBuffer = Buffer.from((part as any).inlineData.data, 'base64');
            const imagePath = path.join(UPLOADS_DIR, `${portraitId}.png`);
            await fs.writeFile(imagePath, stylizedBuffer);
            console.log(`✅ Gemini stylization successful: ${imagePath}`);

            // Test canvas drawing for label
            console.log('🖨️ Generating test label canvas...');
            const canvas = createCanvas(1200, 1800);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, 1200, 1800);

            const portraitImg = await loadImage(stylizedBuffer);
            ctx.drawImage(portraitImg, 0, 0, 1200, 1200);

            const qrBuffer = await QRCode.toBuffer(`https://watkajtys.github.io/nextdemo/?portrait=${portraitId}`);
            const qrImg = await loadImage(qrBuffer);
            ctx.drawImage(qrImg, 50, 1250, 500, 500);

            ctx.fillStyle = 'black';
            ctx.font = 'bold 80px sans-serif';
            ctx.fillText('NANO BANANA', 600, 1400);

            const labelBuffer = canvas.toBuffer('image/png');
            const labelPath = path.join(SPOOL_DIR, `${portraitId}-label.png`);
            await fs.writeFile(labelPath, labelBuffer);
            console.log(`✅ Label generation successful: ${labelPath}`);
        } else {
            console.error('❌ Gemini response did not contain an image part');
            console.log('Response content:', JSON.stringify(response.candidates?.[0]?.content, null, 2));
        }
    } catch (e) {
        console.error('❌ Gemini stylization failed:', (e as Error).message);
    }
}

test_image_handling();
