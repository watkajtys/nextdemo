import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { exec, spawn } from 'child_process';
import util from 'util';
import { GoogleGenAI } from '@google/genai';
import { jules } from '@google/jules-sdk';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import QRCode from 'qrcode';
import thermal from './print';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import FormData from 'form-data';
import axios from 'axios';

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
    private clients: Set<import('express').Response> = new Set();
    private latestFrame: Buffer | null = null;
    private frameBuffer: Buffer = Buffer.alloc(0);

    startPreview(res?: import('express').Response) {
        if (this.isCapturing && res) {
            res.status(503).send('Camera is busy capturing');
            return;
        }

        if (res) {
            this.clients.add(res);
            res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
        }

        if (!this.previewProcess) {
            console.log('🎥 Spawning singleton MJPEG stream at 1080x1080 (Zero-Shutter-Lag Mode)...');
            // We use ffmpeg at full 1080p resolution and NEVER stop it!
            // This prevents the Pi 5 V4L2 hardware from freezing and ensures AGC/AWB are perfectly converged.
            const ffmpeg = spawn('ffmpeg', [
                '-f', 'v4l2',
                '-input_format', 'mjpeg',
                '-video_size', '1920x1080',
                '-i', '/dev/video0',
                '-vf', 'crop=in_h:in_h,scale=1080:1080',
                '-f', 'mpjpeg',
                '-q:v', '2', // High quality for the captures
                '-boundary_tag', 'frame',
                'pipe:1'
            ]);
            this.previewProcess = ffmpeg;

            ffmpeg.stdout?.on('data', (data) => {
                // Stream to all connected browser clients
                for (const client of this.clients) {
                    client.write(data);
                }

                // Append to our rolling frame buffer
                this.frameBuffer = Buffer.concat([this.frameBuffer, data]);
                
                // Parse the MJPEG stream using boundary tags to avoid extracting embedded EXIF thumbnails!
                // Arducam/V4L2 may inject stale thumbnails, so we MUST extract the entire frame payload.
                let boundaryIdx = this.frameBuffer.indexOf(Buffer.from('--frame'));
                while (boundaryIdx !== -1) {
                    const nextBoundaryIdx = this.frameBuffer.indexOf(Buffer.from('--frame'), boundaryIdx + 7);
                    if (nextBoundaryIdx !== -1) {
                        // Extract everything between the two boundaries
                        const chunk = this.frameBuffer.subarray(boundaryIdx, nextBoundaryIdx);
                        // Find the start of the JPEG data (after the HTTP headers)
                        const jpegStart = chunk.indexOf(Buffer.from([0xFF, 0xD8]));
                        if (jpegStart !== -1) {
                            // Copy the entire true JPEG payload
                            this.latestFrame = Buffer.from(chunk.subarray(jpegStart));
                        }
                        this.frameBuffer = this.frameBuffer.subarray(nextBoundaryIdx);
                        boundaryIdx = this.frameBuffer.indexOf(Buffer.from('--frame'));
                    } else {
                        // Keep the remaining buffer and wait for the next boundary
                        if (boundaryIdx > 0) {
                            this.frameBuffer = Buffer.from(this.frameBuffer.subarray(boundaryIdx));
                        }
                        break;
                    }
                }
                // Safety valve to prevent unbounded memory growth if the stream corrupts
                if (this.frameBuffer.length > 10000000) {
                    this.frameBuffer = Buffer.alloc(0);
                }
            });

            ffmpeg.on('exit', (code) => {
                console.log(`🎥 ffmpeg exited with code ${code}`);
                this.previewProcess = null;
                for (const client of this.clients) {
                    client.end();
                }
                this.clients.clear();
                
                // Auto-restart stream if it crashes, keeping the camera alive!
                setTimeout(() => this.startPreview(), 2000);
            });
        }

        res?.on('close', () => {
            this.clients.delete(res);
            // WE NO LONGER KILL THE PREVIEW STREAM!
            // By leaving it running, we eliminate the 1200ms startup delay, 
            // completely prevent the V4L2 stale-frame freeze bug, 
            // and guarantee instantaneous photo captures.
        });
    }

    async captureImage(filePath: string): Promise<void> {
        if (this.isCapturing) throw new Error('Already capturing');
        this.isCapturing = true;
        
        try {
            console.log(`📸 Arducam Zero-Shutter-Lag Capture...`);
            
            // Clear the previous frame from memory so we guarantee we only capture a fresh, live frame
            // that arrives AFTER the user pressed the button!
            this.latestFrame = null;

            // If the stream isn't running, start it
            if (!this.latestFrame) {
                this.startPreview();
            }

            // Wait up to 5 seconds for a clean frame to arrive in the pipeline
            for (let i = 0; i < 50; i++) {
                if (this.latestFrame) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            if (!this.latestFrame) throw new Error('Camera stream failed to produce a frame');
            
            // Instantly save the exact frame the user just saw on the screen!
            await fs.writeFile(filePath, this.latestFrame!);
            
            const stats = await fs.stat(filePath);
            if (stats.size < 1000) throw new Error('Captured file is too small');
            
            console.log(`✅ Captured fresh 1080x1080 frame (${stats.size} bytes)`);
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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY' });

let db: Database.Database;

async function initStorage() {
    for (const dir of [UPLOADS_DIR, SPOOL_DIR]) {
        try { await fs.access(dir); } catch { await fs.mkdir(dir, { recursive: true }); }
    }
    
    db = new Database(path.join(SPOOL_DIR, 'sync_queue.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS uploads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
    `);
}
initStorage();

async function processSyncQueue() {
    const cloudUrl = process.env.CLOUD_SERVER_URL || 'http://204.168.131.95:3001';
    try {
        const pendingUploads = db.prepare("SELECT * FROM uploads WHERE status = 'pending' ORDER BY created_at ASC").all() as any[];
        
        for (const upload of pendingUploads) {
            const { id, file_path } = upload;
            
            let fileExists = true;
            try { await fs.access(file_path); } catch { fileExists = false; }
            if (!fileExists) {
                db.prepare("UPDATE uploads SET status = 'missing' WHERE id = ?").run(id);
                continue;
            }

            console.log(`☁️ Background worker streaming ${path.basename(file_path)} to cloud orchestrator at ${cloudUrl}...`);
            
            const form = new FormData();
            // Best Practice: Stream the file directly from disk using fsSync.createReadStream
            form.append('image', fsSync.createReadStream(file_path));

            const headers: Record<string, string> = form.getHeaders();
            if (process.env.BOOTH_SECRET) {
                headers['Authorization'] = `Bearer ${process.env.BOOTH_SECRET}`;
            }

            try {
                const res = await axios.post(`${cloudUrl}/api/process`, form, { headers });
                if (res.status === 200) {
                    console.log(`✅ Background sync successful for ${path.basename(file_path)}. Marking as done.`);
                    db.prepare("UPDATE uploads SET status = 'done' WHERE id = ?").run(id);
                    
                    // We can safely try to delete the local queue copy, but if it fails, it's fine! 
                    // The DB state prevents infinite loops.
                    try { await fs.unlink(file_path); } catch(e) {}
                }
            } catch (err: any) {
                console.log(`⚠️ Background sync failed for ${path.basename(file_path)} (HTTP ${err.response?.status || err.message}). Will retry later.`);
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
        const queuePath = path.join(SPOOL_DIR, `raw-${portraitId}.jpg`);
        try {
            await fs.writeFile(queuePath, imageBuffer);
            db.prepare("INSERT INTO uploads (file_path, status, created_at) VALUES (?, 'pending', ?)").run(queuePath, Date.now());
        } catch (e) {
            console.error('❌ Failed to queue image:', (e as Error).message);
        }
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
