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
        let isMounted = true;
        let transitionTimeout: NodeJS.Timeout;

        const checkStatus = async () => {
            if (!isMounted) return;
            
            let isReady = false;
            try {
                let apiBaseUrl = window.location.port === '3000' ? window.location.origin.replace(':3000', ':3001') : window.location.origin;
                if (typeof window !== 'undefined' && window.location.hostname.includes('github.io')) {
                    apiBaseUrl = import.meta.env.VITE_VPS_DOMAIN || 'https://ubuntu-8gb-hel1-1.tail050dfe.ts.net';
                }

                // Check status just once
                const statusRes = await fetch(`${apiBaseUrl}/api/portrait-status/${portraitId}`);
                if (statusRes.ok) {
                    const data = await statusRes.json();
                    if (data.status === 'completed' || data.status === 'failed') {
                        isReady = true;
                    }
                } else if (statusRes.status === 404) {
                    const ghRes = await fetch(`https://raw.githubusercontent.com/watkajtys/nextdemo/main/src/data/portraits/${portraitId}.json?t=${Date.now()}`, { cache: 'no-store' });
                    if (ghRes.ok) isReady = true;
                }
            } catch (e) {}

            if (!isMounted) return;

            if (isReady) {
                setStatus('ready');
                transitionTimeout = setTimeout(onReady, 2000);
            } else {
                // If it's not ready, give them time to read the message then enter the mosaic
                transitionTimeout = setTimeout(onReady, 6000);
            }
        };
        
        checkStatus();
        return () => {
            isMounted = false;
            if (transitionTimeout) clearTimeout(transitionTimeout);
        };
    }, [portraitId, onReady]);

    return (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0f0f11] text-white z-50 font-mono p-8 text-center">
            {status === 'pending' ? (
                <>
                    <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-white mb-8"></div>
                    <h1 className="text-3xl font-bold mb-4">Something is coming soon...</h1>
                    <p className="text-2xl font-semibold mt-4">Hi! We're Jules</p>
                    <p className="text-xl text-gray-400 mt-2">The Home of Continuous AI at NEXT</p>
                    <p className="text-md text-gray-500 mt-8 italic">We're still working on your portrait, but in the meantime check out the art so far</p>
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
        const seenIds = new Set<string>();

        const processPayload = (payload: any) => {
             const id = payload.portraitId || payload.id;
             if (id && seenIds.has(id)) return;
             if (id) seenIds.add(id);

             payload = { ...payload, hash: payload.julesSessionId || payload.imageUrl || id } as Partial<Cell>;
             
             if (payload.x !== undefined && payload.y !== undefined) {
                 activeToRestore.push(payload as Cell);
             } else {
                 const empty = initialCells.shift();
                 if (empty) {
                     activeToRestore.push({ ...empty, ...payload, flash: 0.8 } as Cell);
                 }
             }
        };

        for (let i = 0; i < livePortraits.length; i++) {
             processPayload(livePortraits[i]);
        }

        setInitialCells([...initialCells]); // Clone to ensure state updates properly if we pop later
        if (activeToRestore.length > 0) {
            useMosaicStore.getState().syncFromCloud([...activeToRestore]);
        }

        // Fast Local Kiosk Fallback: Fetch any offline un-synced photos sitting in the local spool
        // This ensures photos appear on the Pi mosaic instantly after reboot even if the GitHub PR hasn't merged yet.
        let apiBaseUrl = window.location.port === '3000' ? window.location.origin.replace(':3000', ':3001') : window.location.origin;
        if (typeof window !== 'undefined' && window.location.hostname.includes('github.io')) {
            apiBaseUrl = import.meta.env.VITE_VPS_DOMAIN || 'https://ubuntu-8gb-hel1-1.tail050dfe.ts.net';
        }
        fetch(`${apiBaseUrl}/api/local-portraits`)
            .then(res => res.ok ? res.json() : [])
            .then((localOfflinePortraits: any[]) => {
                const newLocalCells: Cell[] = [];
                for (const p of localOfflinePortraits) {
                    const id = p.portraitId || p.id;
                    if (id && !seenIds.has(id)) {
                        seenIds.add(id);
                        const empty = initialCells.shift();
                        if (empty) {
                            newLocalCells.push({ ...empty, ...p, hash: p.julesSessionId || p.imageUrl || id, flash: 0.8 } as Cell);
                        }
                    }
                }
                if (newLocalCells.length > 0) {
                    setInitialCells([...initialCells]);
                    useMosaicStore.getState().addBulkActiveCells(newLocalCells);
                }
            })
            .catch(() => {}); // Ignore network errors if this is just a static Github pages load without an API

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
    const isCameraRole = !portraitId && window.location.hostname === 'localhost';

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
