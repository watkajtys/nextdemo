import React, { useState, useEffect } from 'react';
import { useMosaicStore } from './store/useMosaicStore';
import { getInitialBaseCells, Cell } from './utils/mosaic';
import { MosaicCanvas } from './components/MosaicCanvas';
import { PhotoboothUI } from './components/PhotoboothUI';

export default function App() {
    const { setInitialCells, addActiveCell, incrementUserCount, addBulkActiveCells } = useMosaicStore();
    const [animState, setAnimState] = useState<{ targetCell: Cell, startTime: number } | null>(null);

    // Initialize the hit map and base cells on mount
    useEffect(() => {
        const initialCells = getInitialBaseCells();
        setInitialCells(initialCells);
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
    );
}
