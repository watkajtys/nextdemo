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
    const [showPreview, setShowPreview] = useState(false);
    const [capturedImageUrl, setCapturedImageUrl] = useState<string | null>(null);

    // Calculate Max Depth for UI display
    const currentMaxDepth = activeCells.reduce((max, cell) => Math.max(max, cell.depth), 0);

    const finishCaptureAndAnimate = () => {
        const hash = Math.random().toString(16).substring(2, 9);
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const newColor = getRandomNeonColor();

        const emptyCell = popEmptyBaseCell();
        if (emptyCell) {
            // Base Grid Fill
            onTriggerAnimation(
                { ...emptyCell, color: newColor, hash, time }, 
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
            
            // Siblings get a flash effect
            const flashingSiblings = siblings.map(s => ({ ...s, flash: 0.5 }));
            
            onTriggerAnimation(targetCell, flashingSiblings);
        }
    };

    const triggerCaptureSequence = async () => {
        setFlash(true);
        
        try {
            // Hit the Express backend to trigger Arducam instantly
            const res = await fetch('http://localhost:3001/api/capture', { method: 'POST' });
            const data = await res.json();
            
            setFlash(false);
            
            if (data.success) {
                // Point the UI to the newly captured static public asset
                setCapturedImageUrl(`http://localhost:3001${data.imageUrl}`);
                setShowPreview(true);
                
                // Keep the preview up for 2 seconds
                setTimeout(() => {
                    setShowPreview(false);
                    // Tell the frontend Grid to update visually
                    finishCaptureAndAnimate();
                    
                    // Dispatch the background Gemini & Jules processing for this specific photo
                    fetch('http://localhost:3001/api/process-local', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fileName: data.rawFileName })
                    }).catch(err => console.error("Process local failed:", err));
                    
                }, 2000);
            }
        } catch (error) {
            console.error("Camera failed:", error);
            setFlash(false);
            
            // Fallback if camera is completely offline or we are testing locally
            setShowPreview(true);
            setTimeout(() => { 
                setShowPreview(false); 
                finishCaptureAndAnimate(); 
            }, 2000);
        }
    };

    const startCountdown = () => {
        if (isAnimating || countdown !== null || showPreview) return;
        
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
        if (isAnimating || countdown !== null || showPreview) return;
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

    // Listen for physical button (e.g. Spacebar)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.code === 'Space') {
                e.preventDefault(); // Prevent page scroll
                startCountdownRef.current();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    return (
        <>
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
                        className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm"
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

            {/* Raw Image Preview */}
            <AnimatePresence>
                {showPreview && (
                    <motion.div
                        initial={{ opacity: 0, y: 50, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, scale: 1.05 }}
                        transition={{ duration: 0.4, ease: "easeOut" }}
                        className="pointer-events-none fixed inset-0 z-40 flex flex-col items-center justify-center bg-black/60 backdrop-blur-md"
                    >
                        <div className="relative overflow-hidden rounded-xl border-4 border-white/20 bg-gray-900 shadow-2xl shadow-black/50">
                            {capturedImageUrl ? (
                                <img 
                                    src={capturedImageUrl} 
                                    alt="Arducam Capture" 
                                    className="flex h-[60vh] w-[80vw] max-w-[800px] object-cover bg-gray-800" 
                                />
                            ) : (
                                /* Fallback Placeholder */
                                <div className="flex h-[60vh] w-[80vw] max-w-[800px] flex-col items-center justify-center bg-gradient-to-br from-gray-800 to-black text-gray-500">
                                    <span className="mb-4 text-4xl">📸</span>
                                    <p className="font-mono text-lg tracking-widest text-gray-400">RAW CAPTURE PREVIEW</p>
                                </div>
                            )}
                            
                            {/* Loading Badge */}
                            <div className="absolute top-4 right-4 flex items-center gap-3 rounded-full border border-white/20 bg-black/80 px-4 py-2 font-mono text-xs text-white backdrop-blur-sm">
                                <div className="h-2 w-2 animate-pulse rounded-full bg-blue-500"></div>
                                Sending to Jules for processing...
                            </div>
                        </div>
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
                    disabled={isAnimating || countdown !== null || showPreview}
                    onClick={startCountdown}
                    className="flex h-8 w-[120px] items-center justify-center rounded-md border border-white/10 bg-blue-500/90 text-[11px] font-semibold uppercase tracking-wide text-white shadow-xl backdrop-blur-md transition-all hover:-translate-y-0.5 hover:bg-blue-600 disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-gray-700/80 disabled:text-gray-400"
                >
                    {isAnimating ? 'Pending...' : countdown !== null ? 'Capturing...' : showPreview ? 'Processing...' : 'Add User'}
                </button>
                <button
                    disabled={isAnimating || countdown !== null || showPreview}
                    onClick={triggerBulkCapture}
                    className="flex h-8 w-[120px] items-center justify-center rounded-md border border-white/10 bg-blue-500/90 text-[11px] font-semibold uppercase tracking-wide text-white shadow-xl backdrop-blur-md transition-all hover:-translate-y-0.5 hover:bg-blue-600 disabled:translate-y-0 disabled:cursor-not-allowed disabled:bg-gray-700/80 disabled:text-gray-400"
                >
                    Add 20 Users
                </button>
            </div>
        </>
    );
};
