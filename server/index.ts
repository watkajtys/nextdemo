import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { exec } from 'child_process';
import util from 'util';
import { GoogleGenAI } from '@google/genai';

const execPromise = util.promisify(exec);
import { jules } from '@google/jules-sdk';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import QRCode from 'qrcode';
import thermal from './print';
import 'dotenv/config';

// Register the same fonts jules.ink uses so labels render correctly on Pi headless
const fontsDir = path.join(process.cwd(), 'jules.ink', 'assets', 'fonts');
try {
    GlobalFonts.registerFromPath(path.join(fontsDir, 'Inter-Bold.ttf'), 'LabelSans');
    GlobalFonts.registerFromPath(path.join(fontsDir, 'JetBrainsMono-Regular.ttf'), 'LabelMono');
    console.log('✅ Registered thermal label fonts from jules.ink/assets');
} catch (e) {
    console.warn('⚠️ Could not register label fonts, falling back to system defaults:', e);
}

const printerHardware = thermal();

const app = express();

// Security & Middleware
app.use(helmet({ crossOriginResourcePolicy: false })); // Allows images to be loaded safely across ports
app.use(cors());
app.use('/portraits', express.static(path.join(process.cwd(), 'public', 'portraits')));

// We need raw body for GitHub Webhook signature verification, so we conditionally parse JSON
app.use(express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf;
    }
}));

// Constants & Config
const PORT = process.env.PORT || 3001;
const UPLOADS_DIR = path.join(process.cwd(), 'public', 'portraits');
const SPOOL_DIR = path.join(process.cwd(), 'public', 'spool');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB limit to prevent memory DoS

// Rate Limiting (Protects APIs & Cloud Bill from spam-clicks)
const processLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 10, // Limit each IP to 10 photos per minute
    message: { error: 'Too many photos taken from this booth. Please wait a minute.' },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Set up Multer with strict limits for memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE }
});

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY' });

// Ensure upload directory exists asynchronously on startup
async function initStorage() {
    try {
        await fs.access(UPLOADS_DIR);
    } catch {
        await fs.mkdir(UPLOADS_DIR, { recursive: true });
        console.log(`📁 Created storage directory at ${UPLOADS_DIR}`);
    }
    
    try {
        await fs.access(SPOOL_DIR);
    } catch {
        await fs.mkdir(SPOOL_DIR, { recursive: true });
        console.log(`🖨️  Created print spool directory at ${SPOOL_DIR}`);
    }
}
initStorage();

/**
 * Endpoint: /api/capture
 * Triggers the hardware camera (Arducam) and saves the raw asset.
 */
app.post('/api/capture', async (req: Request, res: Response): Promise<void> => {
    try {
        const uniqueId = `raw-${Date.now()}`;
        const rawFileName = `${uniqueId}.jpg`;
        const rawFilePath = path.join(UPLOADS_DIR, rawFileName);

        console.log('📸 Triggering hardware Arducam...');

        // Runs standard Raspberry Pi camera command.
        // We use || true so it doesn't crash the Node server if run on a Mac/Windows machine for local dev
        await execPromise(`libcamera-still -o "${rawFilePath}" --timeout 500 --width 1920 --height 1080 --nopreview || true`);

        // Fallback for Mac local dev: if the file wasn't created because libcamera-still failed, create a dummy file
        try {
            await fs.access(rawFilePath);
        } catch {
            await fs.writeFile(rawFilePath, 'simulated-image-data');
        }

        console.log(`📸 Arducam capture complete: ${rawFileName}`);

        res.status(200).json({ success: true, imageUrl: `/portraits/${rawFileName}`, rawFileName });
    } catch (error) {
        console.error('❌ Error triggering Arducam:', error);
        res.status(500).json({ error: 'Failed to access hardware camera.' });
    }
});

/**
 * Endpoint: /api/process-local
 * Processes an image that was already captured and saved locally by /api/capture.
 */
app.post('/api/process-local', processLimiter, async (req: Request, res: Response): Promise<void> => {
    try {
        const { fileName } = req.body;
        if (!fileName) {
            res.status(400).json({ error: 'Missing fileName in request body.' });
            return;
        }

        const uniqueId = `portrait-${Date.now()}`;
        const safeFileName = path.basename(fileName);
        console.log(`✨ Processing local file ${safeFileName} as ${uniqueId}...`);

        const rawFilePath = path.join(UPLOADS_DIR, safeFileName);
        let stylizedImageBuffer = await fs.readFile(rawFilePath);

        if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MISSING_KEY') {
            console.log('🎨 Calling Gemini to apply Nanobanana stylization...');
            try {
                // Example integration for Gemini
                console.log('🎨 Gemini stylization successful (Simulated).');
            } catch (geminiError) {
                console.error('⚠️ Gemini stylization failed.', geminiError);
            }
        }

        const imageFileName = `${uniqueId}.jpg`;
        const imagePath = path.join(UPLOADS_DIR, imageFileName);
        await fs.writeFile(imagePath, stylizedImageBuffer);
        const publicImageUrl = `/portraits/${imageFileName}`;

        console.log(`☁️ Image saved to local/cloud storage: ${publicImageUrl}`);

        const host = req.get('host');
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const absoluteImageUrl = `${protocol}://${host}${publicImageUrl}`;

        let julesSessionId: string | undefined;
        if (process.env.JULES_API_KEY) {
            console.log(`🤖 Dispatching task to Jules Agent...`);
            try {
                const session = await jules.session({
                    prompt: `1. A new portrait was taken! The image is publicly hosted at:
![portrait](${absoluteImageUrl})

2. Analyze the colors and composition.
3. Decide where it fits best in our Quadtree mosaic.
4. Create a new JSON file at src/data/portraits/${uniqueId}.json.`,
                    source: { github: process.env.GITHUB_REPO || 'watkajtys/nextdemo', baseBranch: 'main' },
                    autoPr: true,
                });
                julesSessionId = session.id;
            } catch(e) {
                console.error('❌ Failed to start Jules:', e);
            }
        }

        res.status(200).json({
            status: 'success',
            printData: { imageUrl: publicImageUrl, portraitId: uniqueId, julesSessionId }
        });

    } catch (error) {
        console.error('❌ Error processing local image:', error);
        res.status(500).json({ error: 'Internal server error processing image.' });
    }
});

/**
 * Endpoint: /api/save-for-print
 * Triggered by the Photobooth UI to explicitly save a cloud image to the Pi's hardware disk for thermal printing.
 */
app.post('/api/save-for-print', async (req: Request, res: Response): Promise<void> => {
    try {
        let { imageUrl, portraitId, julesSessionId } = req.body;
        if (!imageUrl || !portraitId) {
            res.status(400).json({ error: 'Missing imageUrl or portraitId' });
            return;
        }

        // Sanitize to prevent path traversal
        portraitId = path.basename(portraitId);

        console.log(`🖨️  Receiving print asset from cloud: ${portraitId}`);
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch cloud image: ${response.statusText}`);
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        const fileExtension = imageUrl.split('.').pop()?.split('?')[0] || 'jpg';
        const imagePath = path.join(SPOOL_DIR, `${portraitId}.${fileExtension}`);
        
        await fs.writeFile(imagePath, buffer);
        console.log(`💾 Saved to Pi spool perfectly for printing: ${imagePath}`);
        
        // Optionally save the metadata/julesSessionId for the queue script
        const jsonPath = path.join(SPOOL_DIR, `${portraitId}.json`);
        await fs.writeFile(jsonPath, JSON.stringify({ portraitId, julesSessionId, imageUrl, printed: false }, null, 2));

        // Generate the 4x6 Label Composite
        try {
            console.log(`🖼️  Generating physical thermal label layout...`);
            const labelWidth = 1200;
            const labelHeight = 1800; // 4x6 ratio
            const canvas = createCanvas(labelWidth, labelHeight);
            const ctx = canvas.getContext('2d');

            // Fill white background (thermal paper is white)
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, labelWidth, labelHeight);

            // Draw large portrait with cover-crop (handles non-square source images)
            const portraitImg = await loadImage(buffer);
            const srcW = portraitImg.width;
            const srcH = portraitImg.height;
            const cropSize = Math.min(srcW, srcH);
            const sx = (srcW - cropSize) / 2;
            const sy = (srcH - cropSize) / 2;
            ctx.drawImage(portraitImg, sx, sy, cropSize, cropSize, 0, 0, labelWidth, labelWidth);

            // Generate QR Code (Bottom Left)
            const mosaicUrl = `https://watkajtys.github.io/nextdemo/?portrait=${portraitId}`;
            const qrBuffer = await QRCode.toBuffer(mosaicUrl, {
                margin: 1,
                scale: 10,
                errorCorrectionLevel: 'M',
                color: { dark: '#000000', light: '#FFFFFF' }
            });
            const qrImg = await loadImage(qrBuffer);

            const qrSize = 500;
            const qrX = 50;
            // Center the QR code vertically in the remaining strip below the portrait
            const qrY = labelWidth + ((labelHeight - labelWidth - qrSize) / 2);
            ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);

            // Add Branding (using registered fonts, with system fallback)
            ctx.fillStyle = 'black';
            ctx.font = 'bold 80px "LabelSans", "Inter", sans-serif';
            ctx.fillText('NANO BANANA', qrX + qrSize + 50, qrY + 150);
            ctx.font = 'bold 50px "LabelMono", "Courier New", monospace';
            ctx.fillText('JULES AT NEXT', qrX + qrSize + 50, qrY + 250);
            if (julesSessionId) {
                ctx.fillText(`SESSION: ${String(julesSessionId).substring(0, 8)}`, qrX + qrSize + 50, qrY + 330);
            }

            const labelBuffer = canvas.toBuffer('image/png');
            const labelPath = path.join(SPOOL_DIR, `${portraitId}-label.png`);
            await fs.writeFile(labelPath, labelBuffer);
            console.log(`✨ Label layout saved to ${labelPath}`);

            // Non-blocking print: dispatch to CUPS *after* we respond to the frontend
            setImmediate(async () => {
                try {
                    const printer = await printerHardware.find();
                    if (printer) {
                        console.log(`🖨️  Sending to CUPS printer ${printer.name}...`);
                        await printerHardware.fix(printer.name);
                        const jobId = await printerHardware.print(printer.name, labelBuffer, {
                            fit: true,
                            media: 'w288h432'
                        });
                        console.log(`✅ Print Job ID: ${jobId}`);
                        await fs.writeFile(jsonPath, JSON.stringify({ portraitId, julesSessionId, imageUrl, printed: true }, null, 2));
                    } else {
                        console.warn(`⚠️ No thermal printer found. Label saved to disk only.`);
                    }
                } catch (e) {
                    console.error('❌ CUPS print dispatch failed:', e);
                }
            });

        } catch (printErr) {
            console.error('❌ Formatting/Printing Error:', printErr);
        }

        res.status(200).json({ success: true, localPath: imagePath });
    } catch (error) {
        console.error('❌ Failed to save for print:', error);
        res.status(500).json({ error: 'Could not save print asset.' });
    }
});

/**
 * Endpoint: /api/process
 * Receives the raw 1080p photo from the Pi, stylizes it, and dispatches to Jules.
 */
app.post('/api/process', processLimiter, upload.single('image'), async (req: Request, res: Response): Promise<void> => {
    try {
        console.log('📸 Received raw photo from Raspberry Pi Photobooth!');

        if (!req.file) {
            res.status(400).json({ error: 'No image uploaded or file exceeds size limit.' });
            return;
        }

        const uniqueId = `portrait-${Date.now()}`;
        console.log(`✨ Processing ${uniqueId}...`);

        // 1. STYLIZE VIA GEMINI
        let stylizedImageBuffer = req.file.buffer;
        let fileExtension = 'jpg';

        if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MISSING_KEY') {
            console.log('🎨 Calling Gemini to apply Nanobanana stylization...');
            try {
                // Force image output while allowing model to reason about the input photo
                const response = await ai.models.generateContent({
                    model: 'gemini-3.1-flash-image-preview',
                    config: {
                        responseModalities: ['TEXT', 'IMAGE'],
                    },
                    contents: [
                        { text: "CRITICAL INSTRUCTION: You are optimizing an image for a low-resolution thermal receipt printer. Completely REDRAW the subject from scratch as a highly simplified 1990s cyberpunk anime character. You MUST use extreme 1-bit high contrast. ABSOLUTELY NO SHADING OF ANY KIND. NO GRAY. NO STIPPLING. NO CROSS-HATCHING. NO FINE DETAILS. Use ONLY thick, solid black outlines and massive, flat shapes of pure black ink against a pure white background. The geometry must be sharp and exaggerated, but the rendering must be as simple and bold as a stencil or linocut. Abandon all photographic realism. ABSOLUTELY NO TEXT. NO WATERMARKS. NO SIGNATURES." },
                        { inlineData: { mimeType: req.file.mimetype || 'image/jpeg', data: req.file.buffer.toString('base64') } }
                    ]
                });

                // Extract the generated image from the response
                for (const part of response.candidates?.[0]?.content?.parts || []) {
                    if ((part as any).inlineData) {
                        const imageData = (part as any).inlineData.data;
                        stylizedImageBuffer = Buffer.from(imageData, 'base64');
                        fileExtension = 'png';
                        console.log(`🎨 Nano Banana 2 stylization successful (${stylizedImageBuffer.length} bytes).`);
                        break;
                    } else if ((part as any).text) {
                        console.log('📝 Nano Banana 2 returned text instead of image:', (part as any).text.substring(0, 100));
                    }
                }

                if (fileExtension === 'jpg') {
                    console.warn('⚠️ Nano Banana 2 did not return an image. Falling back to raw capture.');
                }
            } catch (geminiError) {
                console.error('⚠️ Nano Banana 2 stylization failed. Falling back to raw image.', geminiError);
            }
        }

        // 2. NON-BLOCKING FILE SAVE (Simulating Firebase Storage)
        const imageFileName = `${uniqueId}.${fileExtension}`;
        const imagePath = path.join(UPLOADS_DIR, imageFileName);

        // Use async writeFile to avoid blocking the Node event loop
        await fs.writeFile(imagePath, stylizedImageBuffer);
        const publicImageUrl = `/portraits/${imageFileName}`;

        console.log(`☁️ Image saved to local/cloud storage: ${publicImageUrl}`);

        const host = req.get('host');
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const absoluteImageUrl = `${protocol}://${host}${publicImageUrl}`;

        // 3. DISPATCH TO JULES (Fire and Forget)
        let julesSessionId: string | undefined;
        if (process.env.JULES_API_KEY) {
            console.log(`🤖 Dispatching task to Jules Agent...`);

            try {
                const session = await jules.session({
                    prompt: `
                        1. We have captured a new 1-bit high-contrast portrait. The image is publicly hosted at:
                        
                        ![portrait](${absoluteImageUrl})
                        
                        2. Choose a vibrant, random cyberpunk color (e.g., neon pink, cyan, electric yellow). Generate its Hex code.
                        3. Write a script to download the image from the URL provided above and process it: replace all the solid WHITE pixels with your chosen cyberpunk color, leaving the BLACK pixels intact as black.
                        4. Save the resulting dyed image permanently to public/portraits/${imageFileName} in the repository.
                        5. Decide where the block fits best in our Quadtree mosaic.
                        6. Create a new JSON file at src/data/portraits/${uniqueId}.json. The JSON should include:
                           - The base color hex code you chose.
                           - The grid coordinates in the quadtree where this block resides.
                           - The path to the newly dyed image.
                           - A 'storyPanel' field containing a short, highly creative cyberpunk backstory or flavor text inspired by the character/pose in the image.
                           - A 'julesThoughtProcess' field explaining why you chose this color and position.
                        
                        Note: The mosaic block will initially render as a solid square using this hex color, and the image itself will only be revealed when the user interacts with the block.
                        
                        CRITICAL CONSTRAINTS:
                        - Do NOT update any dependencies.
                        - Do NOT refactor existing code.
                        - Do NOT do anything clever or make assumptions outside this scope.
                        - STICK STRICTLY TO THE TASK ABOVE.
                    `,
                    source: {
                        github: process.env.GITHUB_REPO || 'watkajtys/nextdemo',
                        baseBranch: 'main'
                    },
                    requireApproval: false,
                    autoPr: true,
                });
                julesSessionId = session.id;
                console.log(`🤖 Jules Session Started! ID: ${session.id}`);
            } catch(e) {
                console.error('❌ Failed to start Jules session:', e);
            }
        } else {
            console.log(`⚠️ JULES_API_KEY missing. Skipping AI Developer orchestration.`);
        }

        // 4. RESPOND IMMEDIATELY TO UNBLOCK PI
        res.status(200).json({
            status: 'success',
            message: 'Image processed and Jules task dispatched.',
            printData: {
                imageUrl: publicImageUrl,
                qrCodeUrl: `https://watkajtys.github.io/nextdemo/?portrait=${uniqueId}`,
                portraitId: uniqueId,
                julesSessionId
            }
        });

    } catch (error) {
        console.error('❌ Error processing photobooth request:', error);
        res.status(500).json({ error: 'Internal server error processing image.' });
    }
});

/**
 * Helper: Verify GitHub Webhook Signature
 */
function verifyGitHubSignature(req: any, res: Response, next: NextFunction) {
    const signature = req.headers['x-hub-signature-256'];
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (!secret) {
        console.warn('⚠️ GITHUB_WEBHOOK_SECRET not set. Skipping signature verification.');
        return next();
    }

    if (!signature || !req.rawBody) {
        return res.status(401).send('Missing signature or body');
    }

    const hmac = crypto.createHmac('sha256', secret);
    const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

    if (signature !== digest) {
        console.error('🚨 GitHub Webhook signature mismatch!');
        return res.status(401).send('Invalid signature');
    }

    next();
}

/**
 * Endpoint: /api/webhook/github
 */
app.post('/api/webhook/github', verifyGitHubSignature, (req: Request, res: Response) => {
    const event = req.headers['x-github-event'];

    if (event === 'push' && req.body.ref === 'refs/heads/main') {
        console.log('🔔 GitHub Webhook verified: Jules merged a new portrait!');

        // Acknowledge immediately
        res.status(200).send('OK');

        // Trigger Firebase Firestore sync or local cache invalidation here
        console.log('🔄 Syncing changes to real-time database...');
    } else if (event === 'ping') {
        res.status(200).send('Pong');
    } else {
        res.status(200).send('Event ignored');
    }
});

// Global Error Handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error('🚨 Unhandled Exception:', err.stack);
    res.status(500).send('Something broke!');
});

// Server Initialization & Graceful Shutdown
const server = app.listen(PORT, () => {
    console.log(`☁️ Nanobanana Cloud Orchestrator running on port ${PORT}`);
});

// Graceful Shutdown Handlers (Crucial for Cloud Run / VPS)
const shutdown = () => {
    console.log('🛑 Received shutdown signal, closing server gracefully...');
    server.close(() => {
        console.log('💤 Server closed.');
        process.exit(0);
    });

    // Force close after 10s
    setTimeout(() => {
        console.error('🚨 Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
