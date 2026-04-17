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
    useEffect(() => {
        navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                advanced: [{ focusMode: "continuous" } as any]
            }
        })
            .then(stream => {
                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                    setStreamActive(true);
                }
            })
            .catch(err => console.error("WebRTC Arducam Error:", err));
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

        let blobToUpload: Blob | null = null;

        // Draw the exact video frame to the hidden canvas the millisecond the flash happens
        if (videoRef.current && canvasRef.current && streamActive) {
            const context = canvasRef.current.getContext('2d');
            if (context) {
                const videoW = videoRef.current.videoWidth || 1920;
                const videoH = videoRef.current.videoHeight || 1080;

                // Calculate square crop from the center of the video feed
                const size = Math.min(videoW, videoH);
                const sx = (videoW - size) / 2;
                const sy = (videoH - size) / 2;

                // Set the exact square dimensions on the canvas
                canvasRef.current.width = size;
                canvasRef.current.height = size;

                // "Snap" the photo using the precise source crop
                context.drawImage(videoRef.current, sx, sy, size, size, 0, 0, size, size);

                // Convert that square canvas frame into a raw JPEG Blob
                blobToUpload = await new Promise<Blob | null>(resolve =>
                    canvasRef.current!.toBlob(b => resolve(b), 'image/jpeg', 0.95)
                );
            }
        }

        // Wait for flash cascade
        setTimeout(() => {
            setFlash(false);
            setProcessing(true);

            const tempHash = Math.random().toString(16).substring(2, 9);

            // Upload the Blob to the Cloud Server for Nano Banana 2 stylization
            if (blobToUpload) {
                const formData = new FormData();
                formData.append('image', blobToUpload, 'capture.jpg');

                const cloudServerUrl = import.meta.env.VITE_API_URL || 'http://204.168.131.95:3001';

                fetch(`${cloudServerUrl}/api/process`, {
                    method: 'POST',
                    body: formData
                })
                    .then(res => res.json())
                    .then(async (data) => {
                        let finalCloudUrl: string | undefined;
                        if (data?.printData?.imageUrl) {
                            finalCloudUrl = `${cloudServerUrl}${data.printData.imageUrl}`;
                        }

                        // Pre-load the image into the browser and inject into Zustand cache
                        // BEFORE dismissing the generating screen. This guarantees the canvas
                        // renderer finds the cached image on the very first animation frame.
                        if (finalCloudUrl) {
                            try {
                                const img = await preloadImage(finalCloudUrl);
                                // Inject directly into the Zustand image cache
                                useMosaicStore.setState((state) => ({
                                    imageCache: { ...state.imageCache, [tempHash]: img }
                                }));
                                
                                // Fire-and-forget saving to the local Pi for thermal printing queue!
                                const localServerUrl = window.location.origin.replace(':3000', ':3001');
                                fetch(`${localServerUrl}/api/save-for-print`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        imageUrl: finalCloudUrl,
                                        portraitId: data?.printData?.portraitId,
                                        julesSessionId: data?.printData?.julesSessionId
                                    })
                                }).catch(e => console.error('Failed to notify local pi printer daemon:', e));

                            } catch (e) {
                                console.error('Failed to preload stylized image:', e);
                            }
                        }

                        // NOW release the wait screen and trigger the grid animation
                        setProcessing(false);
                        finishCaptureAndAnimate(tempHash, finalCloudUrl, data?.printData?.julesSessionId);
                    })
                    .catch((err) => {
                        console.error(err);
                        setProcessing(false);
                        // Fallback: use the raw camera frame
                        finishCaptureAndAnimate(tempHash, URL.createObjectURL(blobToUpload!));
                    });
            } else {
                setProcessing(false);
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
                if (!isAnimating && countdown === null && !flash && !processing) {
                    startCountdown();
                }
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
