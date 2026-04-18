import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { exec, spawn } from 'child_process';
import util from 'util';
import { GoogleGenAI } from '@google/genai';
import { jules } from '@google/jules-sdk';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import QRCode from 'qrcode';
import thermal from './print';
import sharp from 'sharp';

const execPromise = util.promisify(exec);

/**
 * JobStore: Tracks asynchronous tasks (Capture -> Stylize -> Print).
 * Frontend polls this to avoid long-hanging HTTP connections.
 */
type JobStatus = 'snapping' | 'processing' | 'storytelling' | 'completed' | 'failed';
interface Job {
    id: string;
    status: JobStatus;
    error?: string;
    result?: any;
    updatedAt: number;
}
const jobs = new Map<string, Job>();

function updateJob(id: string, update: Partial<Job>) {
    const job = jobs.get(id) || { id, status: 'snapping', updatedAt: Date.now() };
    const updated = { ...job, ...update, updatedAt: Date.now() };
    jobs.set(id, updated);
    console.log(`[Job ${id}] ${updated.status} ${update.error ? '- Error: ' + update.error : ''}`);
}

// Cleanup old jobs every 5 minutes to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
        if (now - job.updatedAt > 5 * 60 * 1000) { // 5 minutes
            jobs.delete(id);
        }
    }
}, 5 * 60 * 1000);

/**
 * CameraManager: Coordinates hardware access to /dev/video0.
 * Simplified: Preview is handled by the browser (WebRTC). 
 * This class ONLY handles high-res capture.
 */
class CameraManager {
    private isCapturing = false;
    private previewProcess: import('child_process').ChildProcess | null = null;
    private clients: Set<Response> = new Set();

    async stopPreview() {
        if (this.previewProcess) {
            // CRITICAL: We must stop the preview to release the /dev/video0 hardware lock.
            // Arducam/libcamera cannot be shared by multiple processes on the Pi.
            console.log('🎥 Stopping singleton preview for capture...');
            const proc = this.previewProcess;
            this.previewProcess = null;
            proc.kill('SIGKILL');
            // Give the OS/V4L2 driver a moment to fully release the device handle.
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
    }

    startPreview(res: Response) {
        if (this.isCapturing) {
            res.status(503).send('Camera is busy capturing');
            return;
        }

        this.clients.add(res);
        // MJPEG Stream: Browser treats this as a single image that constantly refreshes.
        res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');

        if (!this.previewProcess) {
            console.log('🎥 Spawning singleton MJPEG preview stream...');
            // CRITICAL FIX: We use 'spawn' instead of 'exec'. 
            // 'exec' attempts to buffer and decode stdout as UTF-8 string, which corrupts binary JPEG bytes.
            // 'spawn' provides a raw stream, allowing us to pipe pure binary chunks to the client.
            const ffmpeg = spawn('ffmpeg', [
                '-f', 'v4l2',
                '-input_format', 'mjpeg',
                '-video_size', '640x480',
                '-i', '/dev/video0',
                '-vf', 'crop=in_h:in_h',
                '-f', 'mpjpeg',
                '-q:v', '8',
                '-boundary_tag', 'frame',
                'pipe:1'
            ]);
            this.previewProcess = ffmpeg;

            ffmpeg.stdout?.on('data', (data) => {
                // 'data' is a Buffer; we write it directly to the socket to preserve binary integrity.
                for (const client of this.clients) {
                    client.write(data);
                }
            });

            ffmpeg.on('exit', (code) => {
                console.log(`🎥 ffmpeg exited with code ${code}`);
                this.previewProcess = null;
                for (const client of this.clients) {
                    client.end();
                }
                this.clients.clear();
            });
        }

        res.on('close', () => {
            this.clients.delete(res);
            if (this.clients.size === 0 && this.previewProcess) {
                console.log('🎥 No more clients, killing preview stream.');
                this.previewProcess.kill('SIGKILL');
                this.previewProcess = null;
            }
        });
    }

    async captureImage(filePath: string, retries = 3): Promise<void> {
        if (this.isCapturing) throw new Error('Already capturing');
        this.isCapturing = true;
        
        try {
            await this.stopPreview();
            for (let attempt = 1; attempt <= retries; attempt++) {
                try {
                    console.log(`📸 Arducam Capture Attempt ${attempt}/${retries}...`);
                    
                    try {
                        await fs.access('/dev/video0');
                    } catch {
                        throw new Error('Camera device /dev/video0 not found');
                    }

                    // Use explicit v4l2 input with mjpeg format for Pi 5 compatibility
                    // crop=in_h:in_h ensures a perfect square
                    // We capture 15 frames and overwrite to completely flush the stale hardware ring-buffer
                    const captureCmd = `ffmpeg -f v4l2 -input_format mjpeg -video_size 1920x1080 -i /dev/video0 -vframes 15 -update 1 -vf "crop=in_h:in_h" "${filePath}" -y`;
                    
                    await new Promise<void>((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error('FFmpeg timeout')), 15000);
                        exec(captureCmd, (error, stdout, stderr) => {
                            clearTimeout(timeout);
                            if (error) {
                                console.error(`FFmpeg Error (Attempt ${attempt}):`, stderr);
                                reject(error);
                            } else {
                                resolve();
                            }
                        });
                    });

                    const stats = await fs.stat(filePath);
                    if (stats.size < 1000) throw new Error('Captured file is too small');
                    
                    return; 
                } catch (err) {
                    console.error(`⚠️ Attempt ${attempt} failed:`, (err as Error).message);
                    if (attempt === retries) throw err;
                    // Wait for device to settle on USB
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        } finally {
            this.isCapturing = false;
        }
    }
}

const cameraManager = new CameraManager();
const printerHardware = thermal();
const app = express();

const fontsDir = path.join(process.cwd(), 'jules.ink', 'assets', 'fonts');
try {
    GlobalFonts.registerFromPath(path.join(fontsDir, 'Inter-Bold.ttf'), 'LabelSans');
    GlobalFonts.registerFromPath(path.join(fontsDir, 'JetBrainsMono-Regular.ttf'), 'LabelMono');
} catch (e) {}

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(cors());
app.use('/portraits', express.static(path.join(process.cwd(), 'public', 'portraits')));
app.use(express.static(path.join(process.cwd(), 'dist')));
app.use(express.json());

// SPA Catch-all: If a request doesn't match an API or static file, serve index.html
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3001;
const UPLOADS_DIR = path.join(process.cwd(), 'public', 'portraits');
const SPOOL_DIR = path.join(process.cwd(), 'public', 'spool');
const QUEUE_DIR = path.join(SPOOL_DIR, 'sync_queue');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY' });

async function initStorage() {
    [UPLOADS_DIR, SPOOL_DIR, QUEUE_DIR].forEach(async dir => {
        try { await fs.access(dir); } catch { await fs.mkdir(dir, { recursive: true }); }
    });
}
initStorage();

async function processSyncQueue() {
    const cloudUrl = process.env.CLOUD_SERVER_URL || 'http://204.168.131.95:3001';
    try {
        const files = await fs.readdir(QUEUE_DIR);
        const now = Date.now();
        for (const file of files) {
            if (!file.endsWith('.jpg') && !file.endsWith('.png')) continue;
            
            const filePath = path.join(QUEUE_DIR, file);
            const stats = await fs.stat(filePath);
            
            // Clear out any old ghost files stuck in the queue from this morning!
            if (now - stats.mtimeMs > 60 * 60 * 1000) {
                console.log(`🧹 Deleting old stuck file from queue: ${file}`);
                await fs.unlink(filePath).catch(() => {});
                continue;
            }

            const imageBuffer = await fs.readFile(filePath);
            
            console.log(`☁️ Background worker syncing ${file} to cloud orchestrator at ${cloudUrl}...`);
            const formData = new FormData();
            // Convert Node Buffer to an ArrayBuffer so native fetch/FormData polyfills serialize it correctly
            const arrayBuffer = new Uint8Array(imageBuffer).buffer;
            const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });
            formData.append('image', blob, 'capture.jpg');

            const headers: Record<string, string> = {};
            if (process.env.BOOTH_SECRET) {
                headers['Authorization'] = `Bearer ${process.env.BOOTH_SECRET}`;
            }

            const res = await fetch(`${cloudUrl}/api/process`, {
                method: 'POST',
                headers,
                body: formData
            });
            
            if (res.ok) {
                console.log(`✅ Background sync successful for ${file}. Removing from queue.`);
                await fs.unlink(filePath);
            } else {
                console.log(`⚠️ Background sync failed for ${file} (HTTP ${res.status}). Will retry later.`);
            }
        }
    } catch (e) {
        // Silent fail on network errors for background worker
    } finally {
        setTimeout(processSyncQueue, 15000); // Check queue every 15 seconds
    }
}
// Start the worker
setTimeout(processSyncQueue, 5000);

async function triggerPrint(imageUrl: string, portraitId: string, julesSessionId?: string) {
    const apiBaseUrl = `http://localhost:${PORT}`;
    try {
        console.log(`🖨️ [AutoPrint] Triggering local print for ${portraitId}...`);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (process.env.BOOTH_SECRET) {
            headers['Authorization'] = `Bearer ${process.env.BOOTH_SECRET}`;
        }
        
        const response = await fetch(`${apiBaseUrl}/api/save-for-print`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ imageUrl, portraitId, julesSessionId })
        });
        
        if (!response.ok) {
            throw new Error(`Print API returned HTTP ${response.status}`);
        }
    } catch (e) {
        console.error('❌ [AutoPrint] Failed to trigger print:', (e as Error).message);
    }
}

async function processImage(imageBuffer: Buffer, existingPortraitId?: string, skipSync: boolean = false) {
    const portraitId = existingPortraitId || `portrait-${Date.now()}`;
    let stylizedBuffer = imageBuffer;
    let fileExt = 'jpg';

    let finalImageToThreshold = imageBuffer;

    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MISSING_KEY') {
        try {
            console.log('🎨 Starting local edge Gemini stylization...');
            
            // --- EDGE COMPRESSION ---
            const compressedBuffer = await sharp(imageBuffer)
                .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();

            const response = await ai.models.generateContent({
                model: 'gemini-3.1-flash-image-preview',
                config: { responseModalities: ['TEXT', 'IMAGE'] },
                contents: [
                    { text: "CRITICAL INSTRUCTION: You are optimizing an image for a low-resolution thermal receipt printer. REDRAW the provided image using a highly simplified 1990s cyberpunk anime aesthetic. You MUST use extreme 1-bit high contrast. ABSOLUTELY NO SHADING OF ANY KIND. NO GRAY. NO STIPPLING. NO CROSS-HATCHING. NO FINE DETAILS. Use ONLY thick, solid black outlines and massive, flat shapes of pure black ink against a pure white background. The geometry must be sharp and exaggerated, but the rendering must be as simple and bold as a stencil or linocut. Maintain the core layout and framing of the original image. IF A PERSON IS PRESENT, stylize them as a 90s cyberpunk anime character. IF NO PERSON IS PRESENT, stylize the scene's key elements using the same bold aesthetic. DO NOT invent or insert characters if they are not present in the original image. Abandon all photographic realism. ABSOLUTELY NO TEXT. NO WATERMARKS. NO SIGNATURES." },
                    { inlineData: { mimeType: 'image/jpeg', data: compressedBuffer.toString('base64') } }
                ]
            });

            const part = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
            if (part && (part as any).inlineData) {
                finalImageToThreshold = Buffer.from((part as any).inlineData.data, 'base64');
                console.log('🎨 Gemini stylization successful');
            }
        } catch (e) { console.error('🎨 Gemini failed:', (e as Error).message); }
    }

    try {
        // --- MANDATORY 1-BIT THRESHOLDING FOR THERMAL PRINTER ---
        // This runs on either the stylized Gemini output OR the raw camera fallback!
        // This guarantees the thermal printer NEVER receives a grayscale or color JPEG, which crashes it.
        const img = await loadImage(finalImageToThreshold);
        const canvas = createCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
            const brightness = (data[i] + data[i+1] + data[i+2]) / 3;
            const val = brightness > 128 ? 255 : 0;
            data[i] = data[i+1] = data[i+2] = val;
        }
        ctx.putImageData(imageData, 0, 0);
        stylizedBuffer = canvas.toBuffer('image/png');
        fileExt = 'png';
        console.log('🖤 1-Bit Thresholding successful');
    } catch (e) {
        console.error('🖤 Thresholding failed:', (e as Error).message);
    }

    const imageFileName = `${portraitId}.${fileExt}`;
    const imagePath = path.join(UPLOADS_DIR, imageFileName);
    await fs.writeFile(imagePath, stylizedBuffer);
    const publicUrl = `/portraits/${imageFileName}`;

    // Queue raw image for background sync (so Cloud can process it independently for the mosaic)
    if (!skipSync) {
        const queuePath = path.join(QUEUE_DIR, `raw-${portraitId}.jpg`);
        await fs.writeFile(queuePath, imageBuffer).catch(e => console.error('❌ Failed to queue image:', e));
    }

    let julesSessionId: string | undefined;
    if (process.env.JULES_API_KEY) {
        // Fire-and-forget Jules session - never block the critical path
        jules.session({
            prompt: `A new 1-bit high-contrast portrait was captured! Storytelling required.`,
            source: { github: process.env.GITHUB_REPO || 'watkajtys/nextdemo', baseBranch: 'main' },
            autoPr: true,
        }).then(session => {
            console.log('🤖 Jules session started:', session.id);
            // Ideally we'd broadcast this session ID back to the client, but for now we just log it
        }).catch(e => console.error('🤖 Jules failed:', (e as Error).message));
    }

    triggerPrint(publicUrl, portraitId, julesSessionId).catch(console.error);

    return { publicUrl, imageUrl: publicUrl, portraitId, julesSessionId };
}

app.get('/api/preview', (req, res) => cameraManager.startPreview(res));

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const requireSecret = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Bypass secret requirement for local requests
    if (req.ip === '::1' || req.ip === '127.0.0.1' || req.ip === '::ffff:127.0.0.1') {
        return next();
    }

    const authHeader = req.headers.authorization;
    const secret = process.env.BOOTH_SECRET;
    
    if (!secret) {
        console.warn(`⚠️ BOOTH_SECRET is not set. API request from ${req.ip} might be unsecured.`);
        return next();
    }
    
    if (!authHeader || authHeader !== `Bearer ${secret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    next();
};

app.post('/api/process', requireSecret, upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    try {
        const result = await processImage(req.file.buffer, undefined, true);
        res.status(200).json({ printData: result });
    } catch (e) {
        res.status(500).json({ error: (e as Error).message });
    }
});

app.get('/api/job/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.status(200).json(job);
});

app.post('/api/capture', requireSecret, async (req, res) => {
    const jobId = `job-${Date.now()}`;
    updateJob(jobId, { id: jobId, status: 'snapping' });
    res.status(202).json({ jobId });

    (async () => {
        try {
            const rawFileName = `raw-${Date.now()}.jpg`;
            const rawFilePath = path.join(UPLOADS_DIR, rawFileName);

            await cameraManager.captureImage(rawFilePath);
            updateJob(jobId, { status: 'processing' });
            
            const rawBuffer = await fs.readFile(rawFilePath);
            const result = await processImage(rawBuffer);

            updateJob(jobId, { status: 'completed', result });
        } catch (error) {
            updateJob(jobId, { status: 'failed', error: (error as Error).message });
        }
    })();
});

app.post('/api/save-for-print', requireSecret, async (req, res) => {
    try {
        let { imageUrl, portraitId, julesSessionId } = req.body;
        if (!imageUrl || !portraitId) return res.status(400).json({ error: 'Missing data' });
        
        portraitId = path.basename(portraitId);
        
        // SSRF Protection: Only allow local relative paths
        if (!imageUrl.startsWith('/')) {
            return res.status(400).json({ error: 'Invalid imageUrl: Must be a relative path' });
        }
        let fetchUrl = `http://127.0.0.1:${PORT}${imageUrl}`;

        const response = await fetch(fetchUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const fileExtension = imageUrl.split('.').pop()?.split('?')[0] || 'jpg';
        const imagePath = path.join(SPOOL_DIR, `${portraitId}.${fileExtension}`);
        await fs.writeFile(imagePath, buffer);
        const jsonPath = path.join(SPOOL_DIR, `${portraitId}.json`);
        await fs.writeFile(jsonPath, JSON.stringify({ portraitId, julesSessionId, imageUrl, printed: false }, null, 2));

        const canvas = createCanvas(1200, 1800);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, 1200, 1800);
        const portraitImg = await loadImage(buffer);
        ctx.drawImage(portraitImg, 0, 0, 1200, 1200);
        const qrBuffer = await QRCode.toBuffer(`https://watkajtys.github.io/nextdemo/?portrait=${portraitId}`);
        const qrImg = await loadImage(qrBuffer);
        ctx.drawImage(qrImg, 50, 1250, 500, 500);
        ctx.fillStyle = 'black';
        ctx.font = 'bold 80px sans-serif';
        ctx.fillText('NANO BANANA', 600, 1400);

        const labelBuffer = canvas.toBuffer('image/png');
        setImmediate(async () => {
            try {
                const printer = await printerHardware.find();
                if (printer) {
                    await printerHardware.fix(printer.name);
                    await printerHardware.print(printer.name, labelBuffer, { fit: true, media: 'w288h432' });
                    await fs.writeFile(jsonPath, JSON.stringify({ portraitId, julesSessionId, imageUrl, printed: true }, null, 2));
                }
            } catch (e) { console.error('❌ [Hardware] Print failed:', e); }
        });
        res.status(200).json({ success: true });
    } catch (e) { 
        res.status(500).json({ error: (e as Error).message }); 
    }
});

app.listen(PORT, () => console.log(`☁️ Photobooth running on port ${PORT}`));
log(`☁️ Photobooth running on port ${PORT}`));
