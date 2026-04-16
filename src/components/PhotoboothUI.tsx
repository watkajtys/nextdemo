import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMosaicStore } from '../store/useMosaicStore';
import { Cell, MAX_DEPTH, subdivideCell, getRandomNeonColor } from '../utils/mosaic';

interface PhotoboothUIProps {
    onTriggerAnimation: (targetCell: Cell, siblings: Cell[]) => void;
    isAnimating: boolean;
}

export const PhotoboothUI: React.FC<PhotoboothUIProps> = ({ onTriggerAnimation, isAnimating }) => {
    const { userCount, activeCells, popEmptyBaseCell } = useMosaicStore();
    const [flash, setFlash] = useState(false);
    const [countdown, setCountdown] = useState<number | null>(null);
    
    // WebRTC references
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [streamActive, setStreamActive] = useState(false);

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

    const finishCaptureAndAnimate = (customHash?: string, customImageUrl?: string) => {
        const hash = customHash || Math.random().toString(16).substring(2, 9);
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const newColor = getRandomNeonColor();

        const emptyCell = popEmptyBaseCell();
        if (emptyCell) {
            // Base Grid Fill
            onTriggerAnimation(
                { ...emptyCell, color: newColor, hash, time, imageUrl: customImageUrl }, 
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
            
            const tempHash = Math.random().toString(16).substring(2, 9);
            let tempImageUrl = undefined;
            if (blobToUpload) {
                tempImageUrl = URL.createObjectURL(blobToUpload);
            }
            
            // Instantly trigger the native Canvas polaroid animation sequence (the existing one!)
            finishCaptureAndAnimate(tempHash, tempImageUrl);
            
            // Upload the Blob to the Node.js backend for standard Gemini stylization silently
            if (blobToUpload) {
                const formData = new FormData();
                formData.append('image', blobToUpload, 'capture.jpg');
                fetch('http://localhost:3001/api/process', {
                    method: 'POST',
                    body: formData
                }).catch(console.error);
            }
        }, 400);
    };

    const startCountdown = () => {
        if (isAnimating || countdown !== null || flash) return;
        
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
            if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
                e.preventDefault(); // Prevent page scroll
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
            <div className={`pointer-events-none fixed inset-0 flex items-center justify-center bg-black/90 backdrop-blur-xl transition-all duration-500 ease-out ${
                    (countdown !== null || flash) ? 'opacity-100 z-30' : 'opacity-0 pointer-events-none -z-10'
                }`}>
                <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="aspect-square h-[75vh] w-[75vh] max-h-[800px] max-w-[800px] scale-x-[-1] rounded-3xl border-8 border-white/10 object-cover shadow-[0_0_80px_rgba(255,255,255,0.05)]"
                />
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

            {/* Stats Overlay */}
            <div className="absolute top-6 left-6 z-20 flex gap-4 font-mono text-sm text-gray-200">
                <span className="rounded-lg border border-white/10 bg-[#1a1a1d]/80 px-4 py-2 shadow-lg backdrop-blur-md">
                    Users: {userCount}
                </span>
                <span className="rounded-lg border border-white/10 bg-[#1a1a1d]/80 px-4 py-2 shadow-lg backdrop-blur-md">
                    Max Depth: {MAX_DEPTH}
                </span>
            </div>

            {/* Prototype Controls */}
            <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 gap-3">
                <button
                    disabled={isAnimating || countdown !== null || flash}
                    onClick={startCountdown}
                    className="flex h-8 w-[120px] items-center justify-center rounded-md border border-white/10 bg-blue-500/90 text-[11px] font-semibold uppercase tracking-wide text-white shadow-xl backdrop-blur-md transition-all hover:-translate-y-0.5 hover:bg-blue-600 disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-gray-700/80 disabled:text-gray-400"
                >
                    {isAnimating ? 'Pending...' : countdown !== null ? 'Capturing...' : flash ? 'Processing...' : 'Add User'}
                </button>
                <button
                    disabled={isAnimating || countdown !== null || flash}
                    onClick={triggerBulkCapture}
                    className="flex h-8 w-[120px] items-center justify-center rounded-md border border-white/10 bg-blue-500/90 text-[11px] font-semibold uppercase tracking-wide text-white shadow-xl backdrop-blur-md transition-all hover:-translate-y-0.5 hover:bg-blue-600 disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-gray-700/80 disabled:text-gray-400"
                >
                    Add 20 Users
                </button>
            </div>
        </>
    );
};
