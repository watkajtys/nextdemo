import React, { useState, useEffect } from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { useMosaicStore } from './store/useMosaicStore';
import { getInitialBaseCells, Cell } from './utils/mosaic';
import { MosaicCanvas } from './components/MosaicCanvas';
import { PhotoboothUI } from './components/PhotoboothUI';
import { getLivePortraits } from './data/portraits';

export default function App() {
    const { setInitialCells, addActiveCell, incrementUserCount, addBulkActiveCells } = useMosaicStore();
    const [animState, setAnimState] = useState<{ targetCell: Cell, startTime: number } | null>(null);

    // Initialize the hit map and base cells on mount
    useEffect(() => {
        const initialCells = getInitialBaseCells();
        const livePortraits = getLivePortraits();
        
        // Restore active cells from JSON metadata
        const activeToRestore: Cell[] = [];
        
        for (let i = 0; i < livePortraits.length; i++) {
             const payload = livePortraits[i];
             // If payload lacks explicit layout, pop an available slot from the hit map
             if (payload.x !== undefined && payload.y !== undefined) {
                 activeToRestore.push(payload as Cell);
             } else {
                 const empty = initialCells.shift(); // shift to fill top-left first
                 if (empty) {
                     activeToRestore.push({ ...empty, ...payload, hash: payload.julesSessionId || payload.imageUrl, flash: 0.8 } as Cell);
                 }
             }
        }

        setInitialCells(initialCells);
        
        if (activeToRestore.length > 0) {
            useMosaicStore.getState().syncFromCloud(activeToRestore);
        }
    }, [setInitialCells]);

    const handleTriggerAnimation = (targetCell: Cell, siblings: Cell[]) => {
        // Add siblings to active cells immediately so they flash and act as background
        if (siblings.length > 0) {
            addBulkActiveCells(siblings);
        }
        
        setAnimState({
            targetCell,
            startTime: performance.now()
        });
    };

    const handleAnimationComplete = (cell: Cell) => {
        // Once the animation lands, add the target cell to the active board
        addActiveCell({ ...cell, flash: 0.8 }); // 0.8 is the initial flash alpha
        incrementUserCount();
        setAnimState(null);
    };

    return (
        <Router>
            <Routes>
                {/* 
                   THE PHYSICAL KIOSK:
                   Runs locally on the Raspberry Pi. This renders the camera (PhotoboothUI)
                   and the live MosaicCanvas in the background for drawing updates.
                */}
                <Route path="/" element={
                    <div className="relative w-screen h-screen overflow-hidden bg-[#0f0f11] text-white">
                        <PhotoboothUI 
                            onTriggerAnimation={handleTriggerAnimation} 
                            isAnimating={animState !== null} 
                        />
                        <MosaicCanvas 
                            animState={animState} 
                            onAnimationComplete={handleAnimationComplete} 
                        />
                    </div>
                } />
                
                {/* 
                   THE PUBLIC GALLERY:
                   Hosted in the cloud for phones. Renders purely the Mosaic without the Camera UI.
                   Eventually, we will fetch the live data JSONs here!
                */}
                <Route path="/gallery" element={
                    <div className="relative w-screen h-screen overflow-x-hidden overflow-y-auto bg-[#0f0f11] text-white">
                        <MosaicCanvas 
                            animState={animState} 
                            onAnimationComplete={handleAnimationComplete} 
                        />
                    </div>
                } />
            </Routes>
        </Router>
    );
}
