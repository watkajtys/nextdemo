import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import util from 'util';
import { GoogleGenAI } from '@google/genai';
import { jules } from '@google/jules-sdk';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import QRCode from 'qrcode';
import thermal from './print';

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
            console.log('🎥 Stopping singleton preview for capture...');
            const proc = this.previewProcess;
            this.previewProcess = null;
            proc.kill('SIGKILL');
            // Give the OS a moment to release the device handle
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
    }

    startPreview(res: Response) {
        if (this.isCapturing) {
            res.status(503).send('Camera is busy capturing');
            return;
        }

        this.clients.add(res);
        res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');

        if (!this.previewProcess) {
            console.log('🎥 Spawning singleton MJPEG preview stream...');
            const ffmpeg = exec(`ffmpeg -f v4l2 -input_format mjpeg -video_size 640x480 -i /dev/video0 -vf "crop=in_h:in_h" -f mpjpeg -q:v 8 -boundary_tag frame pipe:1`);
            this.previewProcess = ffmpeg;

            ffmpeg.stdout?.on('data', (data) => {
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
                    const captureCmd = `ffmpeg -f v4l2 -input_format mjpeg -video_size 1920x1080 -i /dev/video0 -vf "crop=in_h:in_h" -frames:v 1 "${filePath}" -y`;
                    
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

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors());
app.use('/portraits', express.static(path.join(process.cwd(), 'public', 'portraits')));
app.use(express.json());

const PORT = process.env.PORT || 3001;
const UPLOADS_DIR = path.join(process.cwd(), 'public', 'portraits');
const SPOOL_DIR = path.join(process.cwd(), 'public', 'spool');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY' });

async function initStorage() {
    [UPLOADS_DIR, SPOOL_DIR].forEach(async dir => {
        try { await fs.access(dir); } catch { await fs.mkdir(dir, { recursive: true }); }
    });
}
initStorage();

async function syncToCloud(imageBuffer: Buffer) {
    const cloudUrl = process.env.CLOUD_SERVER_URL || 'http://204.168.131.95:3001';
    try {
        console.log(`☁️ Syncing to cloud orchestrator at ${cloudUrl}...`);
        const formData = new FormData();
        const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
        formData.append('image', blob, 'capture.jpg');

        const res = await fetch(`${cloudUrl}/api/process`, {
            method: 'POST',
            body: formData
        });
        
        if (res.ok) {
            const data = await res.json();
            return data.printData;
        }
    } catch (e) {
        console.error('☁️ Cloud sync error:', (e as Error).message);
    }
    return null;
}

async function triggerPrint(imageUrl: string, portraitId: string, julesSessionId?: string) {
    const apiBaseUrl = `http://localhost:${PORT}`;
    try {
        console.log(`🖨️ [AutoPrint] Triggering local print for ${portraitId}...`);
        await fetch(`${apiBaseUrl}/api/save-for-print`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageUrl, portraitId, julesSessionId })
        });
    } catch (e) {
        console.error('❌ [AutoPrint] Failed to trigger print:', (e as Error).message);
    }
}

async function processImage(imageBuffer: Buffer, existingPortraitId?: string) {
    const portraitId = existingPortraitId || `portrait-${Date.now()}`;
    let stylizedBuffer = imageBuffer;
    let fileExt = 'jpg';

    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MISSING_KEY') {
        try {
            console.log('🎨 Starting local Gemini stylization...');
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
                const rawStylized = Buffer.from((part as any).inlineData.data, 'base64');
                
                // --- MANDATORY 1-BIT THRESHOLDING FOR THERMAL PRINTER ---
                const img = await loadImage(rawStylized);
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
                console.log('🎨 Gemini stylization + Thresholding successful');
            }
        } catch (e) { console.error('🎨 Gemini failed:', (e as Error).message); }
    }

    const imageFileName = `${portraitId}.${fileExt}`;
    const imagePath = path.join(UPLOADS_DIR, imageFileName);
    await fs.writeFile(imagePath, stylizedBuffer);
    const publicUrl = `/portraits/${imageFileName}`;

    syncToCloud(imageBuffer).catch(err => console.error('Background cloud sync failed:', err));

    let julesSessionId: string | undefined;
    if (process.env.JULES_API_KEY) {
        try {
            const session = await jules.session({
                prompt: `A new 1-bit high-contrast portrait was captured! Storytelling required.`,
                source: { github: process.env.GITHUB_REPO || 'watkajtys/nextdemo', baseBranch: 'main' },
                autoPr: true,
            });
            julesSessionId = session.id;
        } catch(e) { console.error('🤖 Jules failed:', (e as Error).message); }
    }

    triggerPrint(publicUrl, portraitId, julesSessionId).catch(console.error);

    return { publicUrl, imageUrl: publicUrl, portraitId, julesSessionId };
}

app.get('/api/preview', (req, res) => cameraManager.startPreview(res));

const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/process', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    try {
        const result = await processImage(req.file.buffer);
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

app.post('/api/capture', async (req, res) => {
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

app.post('/api/save-for-print', async (req, res) => {
    try {
        let { imageUrl, portraitId, julesSessionId } = req.body;
        if (!imageUrl || !portraitId) return res.status(400).json({ error: 'Missing data' });
        
        portraitId = path.basename(portraitId);
        let fetchUrl = imageUrl.startsWith('/') ? `http://localhost:${PORT}${imageUrl}` : imageUrl;

        const response = await fetch(fetchUrl);
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
