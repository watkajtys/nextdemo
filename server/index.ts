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
import 'dotenv/config';

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
        console.log(`✨ Processing local file ${fileName} as ${uniqueId}...`);

        const rawFilePath = path.join(UPLOADS_DIR, fileName);
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

        if (process.env.JULES_API_KEY) {
            console.log(`🤖 Dispatching task to Jules Agent...`);
            jules.session({
                prompt: `1. A new portrait was taken: ${publicImageUrl}
2. Analyze the colors and composition.
3. Decide where it fits best in our Quadtree mosaic.
4. Create a new JSON file at src/data/portraits/${uniqueId}.json.`,
                source: { github: process.env.GITHUB_REPO || 'your-org/nanobanana-mosaic', baseBranch: 'main' },
                autoPr: true,
            }).catch(e => console.error('❌ Failed to start Jules:', e));
        }

        res.status(200).json({
            status: 'success',
            printData: { imageUrl: publicImageUrl, portraitId: uniqueId }
        });

    } catch (error) {
        console.error('❌ Error processing local image:', error);
        res.status(500).json({ error: 'Internal server error processing image.' });
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
                        { inlineData: { mimeType: req.file.mimetype || 'image/jpeg', data: req.file.buffer.toString('base64') } },
                        { text: "Edit the attached photo. Redraw the person in the photo as a high-contrast 1990s cyberpunk manga illustration in pure black and white ink. Keep the same face structure and pose from the photo but completely reconstruct it using sharp, angular manga-style features. Drop all realism. Use stark black ink shapes for shading. Pure white background. No text. No signatures. No cross-hatching or gradients. Pure black or pure white only." }
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

        // 3. DISPATCH TO JULES (Fire and Forget)
        if (process.env.JULES_API_KEY) {
            console.log(`🤖 Dispatching task to Jules Agent...`);

            jules.session({
                prompt: `
                    1. A new portrait was taken: ${publicImageUrl}
                    2. Analyze the colors and composition.
                    3. Decide where it fits best in our Quadtree mosaic.
                    4. Create a new JSON file at src/data/portraits/${uniqueId}.json.
                    5. Include grid coordinates, image path, and a 'julesThoughtProcess' field.
                `,
                source: {
                    github: process.env.GITHUB_REPO || 'your-org/nanobanana-mosaic',
                    baseBranch: 'main'
                },
                autoPr: true,
            }).then(session => {
                console.log(`🤖 Jules Session Started! ID: ${session.id}`);
            }).catch(e => {
                console.error('❌ Failed to start Jules session:', e);
            });
        } else {
            console.log(`⚠️ JULES_API_KEY missing. Skipping AI Developer orchestration.`);
        }

        // 4. RESPOND IMMEDIATELY TO UNBLOCK PI
        res.status(200).json({
            status: 'success',
            message: 'Image processed and Jules task dispatched.',
            printData: {
                imageUrl: publicImageUrl,
                qrCodeUrl: `https://nanobanana-mosaic.web.app/?portrait=${uniqueId}`,
                portraitId: uniqueId
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
