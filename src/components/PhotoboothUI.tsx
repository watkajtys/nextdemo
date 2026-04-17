import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMosaicStore } from '../store/useMosaicStore';
import { Cell, MAX_DEPTH, subdivideCell, getRandomNeonColor } from '../utils/mosaic';

// Helper: load an image from URL and return the HTMLImageElement once ready
function preloadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}

interface PhotoboothUIProps {
    onTriggerAnimation: (targetCell: Cell, siblings: Cell[]) => void;
    isAnimating: boolean;
}

const WAITING_MESSAGES = [
    "Hi! We're Jules",
    "The Home of Continuous AI at NEXT",
    "We're working on your portrait!",
    "Jules will add it to the mosaic",
    "Run better product loops",
    "Less Noise. More Shipping",
    "Build Verify Repeat",
    "Automate Product Discovery"
];

export const PhotoboothUI: React.FC<PhotoboothUIProps> = ({ onTriggerAnimation, isAnimating }) => {
    const { userCount, activeCells, popEmptyBaseCell, updateActiveCellImage } = useMosaicStore();
    const [flash, setFlash] = useState(false);
    const [countdown, setCountdown] = useState<number | null>(null);
    const [processing, setProcessing] = useState(false);
    const [loadingMessageIdx, setLoadingMessageIdx] = useState(0);

    // WebRTC references
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [streamActive, setStreamActive] = useState(false);

    // Cycle wait screen messages
    useEffect(() => {
        if (!processing) {
            setLoadingMessageIdx(0);
            return;
        }

        const interval = setInterval(() => {
            setLoadingMessageIdx((prev) => (prev + 1) % WAITING_MESSAGES.length);
        }, 2200);

        return () => clearInterval(interval);
    }, [processing]);

    // Initialize the hardware camera instantly on mount so there's no delay when they press the button
    const startCamera = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    advanced: [{ focusMode: "continuous" } as any]
                }
            });
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                setStreamActive(true);
            }
        } catch (err) {
            console.error("WebRTC Arducam Error:", err);
        }
    };

    const stopCamera = () => {
        if (videoRef.current && videoRef.current.srcObject) {
            const stream = videoRef.current.srcObject as MediaStream;
            stream.getTracks().forEach(track => track.stop());
            videoRef.current.srcObject = null;
            setStreamActive(false);
        }
    };

    useEffect(() => {
        startCamera();
        return () => stopCamera();
    }, []);

    // Calculate Max Depth for UI display
    const currentMaxDepth = activeCells.reduce((max, cell) => Math.max(max, cell.depth), 0);

    const finishCaptureAndAnimate = (customHash?: string, customImageUrl?: string, julesSessionId?: string) => {
        const hash = customHash || Math.random().toString(16).substring(2, 9);
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const newColor = getRandomNeonColor();

        const emptyCell = popEmptyBaseCell();
        if (emptyCell) {
            // Base Grid Fill
            onTriggerAnimation(
                { ...emptyCell, color: newColor, hash, time, imageUrl: customImageUrl, julesSessionId },
                []
            );
        } else {
            // Quadtree Subdivision
            const allSubdividable = useMosaicStore.getState().activeCells.filter(c => c.depth < MAX_DEPTH);
            if (allSubdividable.length === 0) return;

            const minDepth = Math.min(...allSubdividable.map(c => c.depth));
            const priorityCells = allSubdividable.filter(c => c.depth === minDepth);
            const parentIndex = Math.floor(Math.random() * priorityCells.length);
            const parent = priorityCells[parentIndex];

            // We must remove the parent cell from active state immediately before animating
            useMosaicStore.getState().removeActiveCell(parent);

            const { targetCell, siblings } = subdivideCell(parent, hash, time, newColor);
            if (customImageUrl) targetCell.imageUrl = customImageUrl;
            if (julesSessionId) targetCell.julesSessionId = julesSessionId;

            // Siblings get a flash effect
            const flashingSiblings = siblings.map(s => ({ ...s, flash: 0.5 }));

            onTriggerAnimation(targetCell, flashingSiblings);
        }
    };

    const triggerCaptureSequence = async () => {
        setFlash(true);

        // Stop the camera to release /dev/video0 for the backend ffmpeg process
        stopCamera();

        const tempHash = Math.random().toString(16).substring(2, 9);
        // Better dynamic detection of the local backend port 3001
        const apiBaseUrl = window.location.origin.replace(':3000', '') + ':3001';
        console.log('📡 Using API Base URL:', apiBaseUrl);

        // Wait for flash peak
        setTimeout(async () => {
            setFlash(false);
            setProcessing(true);

            try {
                // Step 1: Trigger hardware capture on the Pi backend
                console.log('📸 Triggering hardware capture...');
                const captureRes = await fetch(`${apiBaseUrl}/api/capture`, { method: 'POST' });
                const { jobId } = await captureRes.json();

                // Step 2: Poll for completion
                let attempts = 0;
                const poll = async () => {
                    if (attempts > 30) throw new Error('Capture timeout');
                    attempts++;

                    const jobRes = await fetch(`${apiBaseUrl}/api/job/${jobId}`);
                    const job = await jobRes.json();

                    if (job.status === 'completed') {
                        const { publicUrl, portraitId, julesSessionId } = job.result;
                        const finalImageUrl = `${apiBaseUrl}${publicUrl}`;
                        
                        try {
                            const img = await preloadImage(finalImageUrl);
                            useMosaicStore.setState((state) => ({
                                imageCache: { ...state.imageCache, [tempHash]: img }
                            }));
                            
                            // Also save locally for print (though /api/capture might already handle this, 
                            // we do it here for consistency if needed)
                            fetch(`${apiBaseUrl}/api/save-for-print`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ imageUrl: finalImageUrl, portraitId, julesSessionId })
                            }).catch(console.error);

                        } catch (e) {
                            console.error('Failed to preload image:', e);
                        }

                        setProcessing(false);
                        finishCaptureAndAnimate(tempHash, finalImageUrl, julesSessionId);
                        startCamera(); // Restart preview for next user
                    } else if (job.status === 'failed') {
                        throw new Error(job.error || 'Job failed');
                    } else {
                        setTimeout(poll, 1000);
                    }
                };

                poll();
            } catch (err) {
                console.error('Capture failed:', err);
                setProcessing(false);
                startCamera();
                // Fallback: trigger empty animation if hardware fails completely
                finishCaptureAndAnimate(tempHash);
            }
        }, 400);
    };

    const startCountdown = () => {
        if (isAnimating || countdown !== null || flash || processing) return;

        setCountdown(3);
    };

    useEffect(() => {
        if (countdown === null) return;

        if (countdown > 0) {
            const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
            return () => clearTimeout(timer);
        } else if (countdown === 0) {
            setCountdown(null);
            triggerCaptureSequence();
        }
    }, [countdown]);

    const triggerBulkCapture = () => {
        if (isAnimating || countdown !== null || flash) return;
        // Simplified bulk add to avoid breaking anim state, we just add directly for the prototype
        for (let i = 0; i < 20; i++) {
            const hash = Math.random().toString(16).substring(2, 9);
            const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const newColor = getRandomNeonColor();

            const emptyCell = popEmptyBaseCell();
            if (emptyCell) {
                useMosaicStore.getState().addActiveCell({ ...emptyCell, color: newColor, hash, time, flash: 0.8 });
            } else {
                const allSubdividable = useMosaicStore.getState().activeCells.filter(c => c.depth < MAX_DEPTH);
                if (allSubdividable.length === 0) break;

                const minDepth = Math.min(...allSubdividable.map(c => c.depth));
                const priorityCells = allSubdividable.filter(c => c.depth === minDepth);
                const parent = priorityCells[Math.floor(Math.random() * priorityCells.length)];

                useMosaicStore.getState().removeActiveCell(parent);

                const { targetCell, siblings } = subdivideCell(parent, hash, time, newColor);
                targetCell.flash = 0.8;

                useMosaicStore.getState().addBulkActiveCells([...siblings.map(s => ({ ...s, flash: 0.5 })), targetCell]);
            }
            useMosaicStore.getState().incrementUserCount();
        }
    };

    const startCountdownRef = useRef(startCountdown);
    useEffect(() => {
        startCountdownRef.current = startCountdown;
    });

    // Listen for physical button (e.g. Spacebar or Big USB Button mapped to Enter)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Space, Enter, or NumpadEnter binds to Arcade buttons
            if (e.key === ' ' || e.key === 'Enter' || e.code === 'NumpadEnter') {
                e.preventDefault();
                startCountdownRef.current();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    return (
        <>
            {/* Live WebRTC Camera Stream Layer */}
            {/* The mirror stays until the flash completes, then vanishes so the native canvas animation handles it */}
            <div className={`pointer-events-none fixed inset-0 flex items-center justify-center bg-black/95 backdrop-blur-3xl transition-all duration-500 ease-out ${(countdown !== null || flash || processing) ? 'opacity-100 z-30' : 'opacity-0 pointer-events-none -z-10'
                }`}>
                {/* Polaroid Frame container (Upright) */}
                <div className={`relative flex flex-col items-center bg-[#f8f8f8] p-4 pb-20 shadow-[0_40px_80px_rgba(0,0,0,0.9)] transition-all duration-300 ease-in-out ${processing ? 'opacity-0 scale-90 blur-md' : 'opacity-100 scale-100 blur-0'}`}>
                    <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="aspect-square h-[65vh] w-[65vh] max-h-[700px] max-w-[700px] scale-x-[-1] bg-black object-cover shadow-inner"
                    />
                    <div className="absolute bottom-6 font-mono text-2xl font-bold tracking-widest text-[#2a2a2a] opacity-80">
                        JULES AT NEXT 2026
                    </div>
                </div>

                {/* AI Generative Wait Screen overlay */}
                <AnimatePresence>
                    {processing && (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 1.1 }}
                            transition={{ duration: 0.5, ease: "easeOut" }}
                            className="absolute inset-0 z-50 flex flex-col items-center justify-center"
                        >
                            <motion.div
                                animate={{ rotate: 360 }}
                                transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                                className="h-20 w-20 rounded-full border-t-8 border-b-8 border-[#fbbc05]"
                            ></motion.div>
                            <p className="mt-10 font-mono text-5xl font-extrabold tracking-[0.3em] text-[#fbbc05] drop-shadow-[0_0_20px_rgba(251,188,5,0.4)] animate-pulse">
                                GENERATING...
                            </p>
                            <div className="relative mt-6 h-12 w-full flex items-center justify-center">
                                <AnimatePresence>
                                    <motion.p
                                        key={loadingMessageIdx}
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -10 }}
                                        transition={{ duration: 0.3 }}
                                        className="absolute font-mono text-2xl font-semibold tracking-widest text-[#e5e2e1] drop-shadow-md text-center max-w-2xl uppercase w-full"
                                    >
                                        {WAITING_MESSAGES[loadingMessageIdx]}
                                    </motion.p>
                                </AnimatePresence>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
            {/* Hidden canvas purely for extracting the still frame */}
            <canvas ref={canvasRef} className="hidden" />

            {/* Cinematic Camera Flash */}
            <AnimatePresence>
                {flash && (
                    <motion.div
                        initial={{ opacity: 1 }}
                        animate={{ opacity: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.4, ease: "easeOut" }}
                        className="pointer-events-none fixed inset-0 z-50 bg-white"
                    />
                )}
            </AnimatePresence>

            {/* Countdown Overlay */}
            <AnimatePresence>
                {countdown !== null && countdown > 0 && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center"
                    >
                        <AnimatePresence>
                            <motion.span
                                key={countdown}
                                initial={{ opacity: 0, scale: 0.5 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 2 }}
                                transition={{ duration: 0.6, ease: "easeOut" }}
                                className="absolute text-[25vw] font-black text-white drop-shadow-[0_0_60px_rgba(255,255,255,0.6)]"
                            >
                                {countdown}
                            </motion.span>
                        </AnimatePresence>
                    </motion.div>
                )}
            </AnimatePresence>



        </>
    );
};
