import React, { useState, useEffect } from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { useMosaicStore } from './store/useMosaicStore';
import { getInitialBaseCells, Cell } from './utils/mosaic';
import { MosaicCanvas } from './components/MosaicCanvas';
import { PhotoboothUI } from './components/PhotoboothUI';
import { getLivePortraits } from './data/portraits';

function PortraitPendingView({ portraitId, onReady }: { portraitId: string, onReady: () => void }) {
    const [status, setStatus] = useState<'pending' | 'ready'>('pending');

    useEffect(() => {
        const checkGitHub = async () => {
            try {
                // Poll the raw github content to see if Jules merged the PR
                const res = await fetch(`https://raw.githubusercontent.com/watkajtys/nextdemo/main/src/data/portraits/${portraitId}.json`, { cache: 'no-store' });
                if (res.ok) {
                    setStatus('ready');
                    setTimeout(onReady, 2000);
                }
            } catch (e) {}
        };
        const interval = setInterval(checkGitHub, 5000);
        checkGitHub();
        return () => clearInterval(interval);
    }, [portraitId, onReady]);

    return (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0f0f11] text-white z-50 font-mono p-8 text-center">
            {status === 'pending' ? (
                <>
                    <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-white mb-8"></div>
                    <h1 className="text-3xl font-bold mb-4">Uplink Established...</h1>
                    <p className="text-xl text-gray-400">Transmitting your portrait to the mainframe.</p>
                    <p className="text-xl text-gray-400 mt-2">Our AI is analyzing the data and writing your story.</p>
                    <p className="text-sm text-gray-500 mt-8">(This usually takes 1-2 minutes. Stay on this page.)</p>
                </>
            ) : (
                <>
                    <h1 className="text-4xl font-bold text-green-400 mb-4">Transmission Complete!</h1>
                    <p className="text-2xl text-white">Welcome to the Cloud Mosaic.</p>
                </>
            )}
        </div>
    );
}

function MainLayout() {
    const { setInitialCells, addActiveCell, incrementUserCount, addBulkActiveCells } = useMosaicStore();
    const [animState, setAnimState] = useState<{ targetCell: Cell, startTime: number } | null>(null);
    const [portraitId, setPortraitId] = useState<string | null>(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setPortraitId(params.get('portrait'));
    }, []);

    // Initialize the hit map and base cells on mount
    useEffect(() => {
        const initialCells = getInitialBaseCells();
        const livePortraits = getLivePortraits();
        
        const activeToRestore: Cell[] = [];
        for (let i = 0; i < livePortraits.length; i++) {
             let payload = livePortraits[i];
             payload = { ...payload, hash: payload.julesSessionId || payload.imageUrl || (payload as any).id } as Partial<Cell>;
             
             if (payload.x !== undefined && payload.y !== undefined) {
                 activeToRestore.push(payload as Cell);
             } else {
                 const empty = initialCells.shift();
                 if (empty) {
                     activeToRestore.push({ ...empty, ...payload, flash: 0.8 } as Cell);
                 }
             }
        }

        setInitialCells(initialCells);
        if (activeToRestore.length > 0) {
            useMosaicStore.getState().syncFromCloud(activeToRestore);
        }
    }, [setInitialCells]);

    const handleTriggerAnimation = (targetCell: Cell, siblings: Cell[]) => {
        if (siblings.length > 0) addBulkActiveCells(siblings);
        setAnimState({ targetCell, startTime: performance.now() });
    };

    const handleAnimationComplete = (cell: Cell) => {
        addActiveCell({ ...cell, flash: 0.8 });
        incrementUserCount();
        setAnimState(null);
    };

    // If a user scans a QR code, they shouldn't see the camera UI.
    const isCameraRole = !portraitId && (window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.'));

    if (portraitId && !ready) {
        return <PortraitPendingView portraitId={portraitId} onReady={() => setReady(true)} />;
    }

    return (
        <div className="relative w-screen h-screen overflow-hidden bg-[#0f0f11] text-white">
            {isCameraRole && (
                <PhotoboothUI 
                    onTriggerAnimation={handleTriggerAnimation} 
                    isAnimating={animState !== null} 
                />
            )}
            <MosaicCanvas 
                animState={animState} 
                onAnimationComplete={handleAnimationComplete} 
            />
        </div>
    );
}

export default function App() {
    return (
        <Router>
            <Routes>
                <Route path="*" element={<MainLayout />} />
            </Routes>
        </Router>
    );
}
