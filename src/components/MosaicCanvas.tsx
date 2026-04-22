import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMosaicStore } from '../store/useMosaicStore';
import {
    GRID_WORLD_SIZE,
    SVG_WORLD_W,
    SVG_WORLD_H,
    Cell,
    drawGraphicNovelAvatar,
    easeOutCubic,
    easeOutExpo
} from '../utils/mosaic';

interface Camera {
    x: number;
    y: number;
    zoom: number;
}

interface AnimState {
    targetCell: Cell;
    startTime: number;
}

interface MosaicCanvasProps {
    animState: AnimState | null;
    onAnimationComplete: (cell: Cell) => void;
}

export const calculateCardDimensions = (viewportW: number, viewportH: number) => {
    const isMobile = viewportW < 600;
    const STRIP_HEIGHT = isMobile ? 150 : 200;
    let screenBigW = isMobile ? (viewportW * 0.95) : Math.min(800, viewportW * 0.9);
    let screenBigH = screenBigW * 0.95 + STRIP_HEIGHT;

    // Ensure the card doesn't exceed the viewport height (handling landscape/short screens)
    if (screenBigH > viewportH * 0.92) {
        screenBigH = viewportH * 0.92;
        screenBigW = (screenBigH - STRIP_HEIGHT) / 0.95;
    }

    return { width: screenBigW, height: screenBigH };
};

export const MosaicCanvas: React.FC<MosaicCanvasProps> = ({ animState, onAnimationComplete }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [openedCell, setOpenedCell] = useState<Cell | null>(null);
    const [windowSize, setWindowSize] = useState({ w: typeof window !== 'undefined' ? window.innerWidth : 800, h: typeof window !== 'undefined' ? window.innerHeight : 600 });
    
    // High-frequency mutable state kept in refs to avoid React re-renders
    const cameraRef = useRef<Camera>({ x: GRID_WORLD_SIZE / 2, y: GRID_WORLD_SIZE / 2, zoom: 1 });
    const mouseRef = useRef({ x: -1000, y: -1000 });
    const clickedCellRef = useRef<Cell | null>(null);
    const viewportRef = useRef({ w: typeof window !== 'undefined' ? window.innerWidth : 800, h: typeof window !== 'undefined' ? window.innerHeight : 600 });
    
    // Interaction state
    const interactionRef = useRef({
        isPointerDown: false,
        pointerMoved: false,
        dragStart: { x: 0, y: 0 },
        cameraStart: { x: 0, y: 0 },
        downTime: 0,
        lastOpenedTime: 0,
        activePointers: new Map<number, { x: number, y: number }>(),
        initialPinchDistance: null as number | null,
        initialPinchZoom: 1
    });

    // We get state from Zustand, but we need to be careful with the draw loop.
    // The draw loop runs every frame, so it should read the latest state.
    // We can use Zustand's subscribe or just read directly from the store in the loop.
    // Reading directly from useMosaicStore.getState() is best for requestAnimationFrame.
    
    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let animationFrameId: number;

        const resizeCanvas = () => {
            const width = window.innerWidth;
            const height = window.innerHeight;
            const dpr = window.devicePixelRatio || 1;

            viewportRef.current = { w: width, h: height };
            setWindowSize({ w: width, h: height });

            // Physical canvas resolution
            canvas.width = width * dpr;
            canvas.height = height * dpr;

            // CSS canvas display size
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;

            const minZoomX = width / (SVG_WORLD_W * 1.1);
            const minZoomY = height / (SVG_WORLD_H * 1.1);
            const initialZoom = Math.min(minZoomX, minZoomY);

            const state = useMosaicStore.getState();
            if (cameraRef.current.zoom === 1 && state.userCount === 0) {
                cameraRef.current.zoom = initialZoom;
            }
            constrainCamera();
        };

        const constrainCamera = () => {
            const camera = cameraRef.current;
            const viewport = viewportRef.current;
            const visibleW = viewport.w / camera.zoom;
            const visibleH = viewport.h / camera.zoom;

            const paddingX = SVG_WORLD_W * 0.1;
            const paddingY = SVG_WORLD_H * 0.1;
            const boundsMinX = (GRID_WORLD_SIZE - SVG_WORLD_W) / 2 - paddingX;
            const boundsMaxX = (GRID_WORLD_SIZE + SVG_WORLD_W) / 2 + paddingX;
            const boundsMinY = (GRID_WORLD_SIZE - SVG_WORLD_H) / 2 - paddingY;
            const boundsMaxY = (GRID_WORLD_SIZE + SVG_WORLD_H) / 2 + paddingY;

            const boundsW = boundsMaxX - boundsMinX;
            const boundsH = boundsMaxY - boundsMinY;

            if (visibleW > boundsW) {
                camera.x = GRID_WORLD_SIZE / 2;
            } else {
                const minX = boundsMinX + visibleW / 2;
                const maxX = boundsMaxX - visibleW / 2;
                camera.x = Math.max(minX, Math.min(camera.x, maxX));
            }

            if (visibleH > boundsH) {
                camera.y = GRID_WORLD_SIZE / 2;
            } else {
                const minY = boundsMinY + visibleH / 2;
                const maxY = boundsMaxY - visibleH / 2;
                camera.y = Math.max(minY, Math.min(camera.y, maxY));
            }
        };

        const draw = (timestamp: number) => {
            const state = useMosaicStore.getState();
            const { activeCells, emptyBaseCells } = state;
            const camera = cameraRef.current;
            const viewport = viewportRef.current;
            const mouseX = mouseRef.current.x;
            const mouseY = mouseRef.current.y;
            let clickedCell = clickedCellRef.current;

            const dpr = window.devicePixelRatio || 1;

            // Reset matrix and apply DPR scale directly without needing an extra save/restore stack
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            ctx.fillStyle = '#0f0f11';
            ctx.fillRect(0, 0, viewport.w, viewport.h);

            ctx.save();
            ctx.translate(viewport.w / 2, viewport.h / 2);
            ctx.scale(camera.zoom, camera.zoom);
            ctx.translate(-camera.x, -camera.y);

            const { width: screenBigW, height: screenBigH } = calculateCardDimensions(viewport.w, viewport.h);

            const bigW = screenBigW / camera.zoom;
            const bigH = screenBigH / camera.zoom;
            const bigX = camera.x - bigW / 2;
            const bigY = camera.y - bigH / 2;

            let currentlyHovered = clickedCell;
            const normalCells: Cell[] = [];
            const animatingCells: Cell[] = [];

            for (const cell of activeCells) {
                if (cell === currentlyHovered) {
                    cell.hoverProgress = Math.min((cell.hoverProgress || 0) + 0.08, 1);
                } else {
                    cell.hoverProgress = Math.max((cell.hoverProgress || 0) - 0.05, 0);
                }

                if (cell.hoverProgress > 0) {
                    animatingCells.push(cell);
                } else {
                    normalCells.push(cell);
                }
            }

            let hoveredCell = null;
            if (!animState && !clickedCell) {
                for (let i = activeCells.length - 1; i >= 0; i--) {
                    const cell = activeCells[i];
                    if (mouseX >= cell.x && mouseX <= cell.x + cell.w &&
                        mouseY >= cell.y && mouseY <= cell.y + cell.h) {
                        hoveredCell = cell;
                        break;
                    }
                }
            }

            for (const cell of normalCells) {
                const cachedImg = state.imageCache[cell.hash || ''];
                
                if (cachedImg) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(cell.x, cell.y, cell.w, cell.h);
                    ctx.clip();
                    
                    const aspectRatio = cachedImg.width / cachedImg.height;
                    let drawW = cell.w;
                    let drawH = cell.h;
                    let drawX = cell.x;
                    let drawY = cell.y;

                    if (aspectRatio > 1) {
                        drawW = cell.h * aspectRatio;
                        drawX = cell.x - (drawW - cell.w) / 2;
                    } else if (aspectRatio < 1) {
                        drawH = cell.w / aspectRatio;
                        drawY = cell.y - (drawH - cell.h) / 2;
                    }
                    ctx.drawImage(cachedImg, drawX, drawY, drawW, drawH);
                    ctx.restore();
                } else {
                    ctx.fillStyle = cell.color || '#fff';
                    ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
                }

                if (cell.flash && cell.flash > 0) {
                    ctx.fillStyle = `rgba(255, 255, 255, ${cell.flash})`;
                    ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
                    cell.flash -= 0.03;
                }

                if (cell === hoveredCell) {
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
                    ctx.fillRect(cell.x, cell.y, cell.w, cell.h);

                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 2 / camera.zoom;
                    const offset = 1 / camera.zoom;
                    ctx.strokeRect(cell.x + offset, cell.y + offset, cell.w - offset * 2, cell.h - offset * 2);
                } else {
                    ctx.strokeStyle = '#0f0f11';
                    ctx.lineWidth = 1 / camera.zoom;
                    ctx.strokeRect(cell.x, cell.y, cell.w, cell.h);
                }
            }

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
            ctx.lineWidth = 1 / camera.zoom;
            for (const cell of emptyBaseCells) {
                ctx.strokeRect(cell.x, cell.y, cell.w, cell.h);
            }

            // Draw a cinematic dimming overlay if a cell is being opened
            const openingCell = animatingCells.find(c => c === clickedCell);
            if (openingCell && openingCell.hoverProgress) {
                ctx.save();
                // Reset transform to screen space (accounting for DPR) for the full-screen fade
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.fillStyle = `rgba(0, 0, 0, ${openingCell.hoverProgress * 0.5})`;
                ctx.fillRect(0, 0, viewport.w, viewport.h);
                ctx.restore();
            }

            for (const cell of animatingCells) {
                const eased = easeOutCubic(cell.hoverProgress || 0);

                const currX = cell.x + (bigX - cell.x) * eased;
                const currY = cell.y + (bigY - cell.y) * eased;
                const currW = cell.w + (bigW - cell.w) * eased;
                const currH = cell.h + (bigH - cell.h) * eased;

                ctx.fillStyle = cell.color || '#fff';
                ctx.shadowColor = cell.color || '#fff';
                ctx.shadowBlur = 30 * eased;
                ctx.fillRect(currX, currY, currW, currH);
                ctx.shadowBlur = 0;

                ctx.fillStyle = `rgba(245, 245, 245, ${eased})`;
                ctx.fillRect(currX, currY, currW, currH);

                const border = (bigW * 0.05) * eased;
                const photoX = currX + border;
                const photoY = currY + border;
                const photoW = currW - border * 2;
                const photoH = currW - border * 2;

                ctx.fillStyle = cell.color || '#fff';
                ctx.fillRect(photoX, photoY, photoW, photoH);

                if (cell.flash && cell.flash > 0) {
                    ctx.fillStyle = `rgba(255, 255, 255, ${cell.flash})`;
                    ctx.fillRect(photoX, photoY, photoW, photoH);
                    cell.flash -= 0.03;
                }

                ctx.save();
                ctx.beginPath();
                ctx.rect(photoX, photoY, photoW, photoH);
                ctx.clip();

                const cachedImg = state.imageCache[cell.hash || ''];
                if (cachedImg) {
                    ctx.globalAlpha = eased;
                    // Center crop the image if it's not perfectly square
                    const aspectRatio = cachedImg.width / cachedImg.height;
                    let drawW = photoW;
                    let drawH = photoH;
                    let drawX = photoX;
                    let drawY = photoY;

                    if (aspectRatio > 1) {
                        // Image is wider
                        drawW = photoH * aspectRatio;
                        drawX = photoX - (drawW - photoW) / 2;
                    } else if (aspectRatio < 1) {
                        // Image is taller
                        drawH = photoW / aspectRatio;
                        drawY = photoY - (drawH - photoH) / 2;
                    }
                    ctx.drawImage(cachedImg, drawX, drawY, drawW, drawH);
                } else if (photoW > 10) {
                    // No image cached yet — just show the cell background color (no vector placeholder)
                    ctx.globalAlpha = eased;
                }
                ctx.restore();

                if (eased > 0.3) {
                    ctx.globalAlpha = 1.0;
                }

                ctx.strokeStyle = `rgba(255, 255, 255, ${0.8 * eased})`;
                ctx.lineWidth = Math.max(1, currW * 0.005);
                ctx.strokeRect(currX, currY, currW, currH);
            }

            if (animState) {
                const elapsed = timestamp - animState.startTime;
                const { targetCell } = animState;

                let currentX, currentY, currentW, currentH;
                let fadeProgress = 0;

                if (elapsed < 1500) {
                    currentW = bigW;
                    currentH = bigH;
                    currentX = bigX;
                    currentY = bigY;
                    fadeProgress = Math.min(Math.max((elapsed - 200) / 1000, 0), 1);
                } else if (elapsed < 2500) {
                    fadeProgress = 1;
                    const progress = Math.min((elapsed - 1500) / 1000, 1.0);
                    const eased = easeOutExpo(progress);

                    currentX = bigX + (targetCell.x - bigX) * eased;
                    currentY = bigY + (targetCell.y - bigY) * eased;
                    currentW = bigW + (targetCell.w - bigW) * eased;
                    currentH = bigH + (targetCell.h - bigH) * eased;
                } else {
                    onAnimationComplete(targetCell);
                    return; // Prevent drawing anim state after complete
                }

                ctx.fillStyle = `rgba(245, 245, 245, 1)`;
                ctx.fillRect(currentX, currentY, currentW, currentH);

                const border = (bigW * 0.05) * (currentW / bigW);
                const photoX = currentX + border;
                const photoY = currentY + border;
                const photoW = currentW - border * 2;
                const photoH = currentW - border * 2;

                ctx.fillStyle = '#2a2a35';
                ctx.fillRect(photoX, photoY, photoW, photoH);

                if (fadeProgress > 0) {
                    ctx.save();
                    const easedFade = fadeProgress * fadeProgress;
                    ctx.globalAlpha = easedFade;
                    ctx.fillStyle = targetCell.color || '#fff';
                    ctx.shadowColor = targetCell.color || '#fff';
                    ctx.shadowBlur = 20 * easedFade;

                    ctx.fillRect(photoX, photoY, photoW, photoH);
                    ctx.restore();
                }

                ctx.save();
                ctx.beginPath();
                ctx.rect(photoX, photoY, photoW, photoH);
                ctx.clip();

                const cachedImg = state.imageCache[targetCell.hash || ''];
                if (cachedImg) {
                    ctx.globalAlpha = fadeProgress;
                    const aspectRatio = cachedImg.width / cachedImg.height;
                    let drawW = photoW;
                    let drawH = photoH;
                    let drawX = photoX;
                    let drawY = photoY;

                    if (aspectRatio > 1) {
                        drawW = photoH * aspectRatio;
                        drawX = photoX - (drawW - photoW) / 2;
                    } else if (aspectRatio < 1) {
                        drawH = photoW / aspectRatio;
                        drawY = photoY - (drawH - photoH) / 2;
                    }
                    ctx.drawImage(cachedImg, drawX, drawY, drawW, drawH);
                } else if (photoW > 10) {
                    // No image cached yet — just show the cell background color (no vector placeholder)
                    ctx.globalAlpha = fadeProgress;
                }
                ctx.restore();

                if (currentW > bigW * 0.3) {
                    ctx.globalAlpha = 1.0;
                }

                ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
                ctx.lineWidth = Math.max(1, currentW * 0.005);
                ctx.strokeRect(currentX, currentY, currentW, currentH);
            }

            ctx.restore();
            animationFrameId = requestAnimationFrame(draw);
        };

        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();
        animationFrameId = requestAnimationFrame(draw);

        return () => {
            window.removeEventListener('resize', resizeCanvas);
            cancelAnimationFrame(animationFrameId);
        };
    }, [animState, onAnimationComplete]);

    const getMousePos = (clientX: number, clientY: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;

        const rect = canvas.getBoundingClientRect();
        
        const screenX = clientX - rect.left;
        const screenY = clientY - rect.top;

        const camera = cameraRef.current;
        const viewport = viewportRef.current;
        const worldX = (screenX - viewport.w / 2) / camera.zoom + camera.x;
        const worldY = (screenY - viewport.h / 2) / camera.zoom + camera.y;

        return { screenX, screenY, worldX, worldY };
    };

    const handleWheel = (e: React.WheelEvent) => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const zoomSensitivity = 0.001;
        const delta = -e.deltaY * zoomSensitivity;

        const viewport = viewportRef.current;
        const minZoomX = viewport.w / (SVG_WORLD_W * 1.1);
        const minZoomY = viewport.h / (SVG_WORLD_H * 1.1);
        const minZoom = Math.min(minZoomX, minZoomY);

        const newZoom = Math.max(minZoom, Math.min(cameraRef.current.zoom * (1 + delta), 50));

        const pos = getMousePos(e.clientX, e.clientY);
        if (!pos) return;
        cameraRef.current.x = pos.worldX - (pos.screenX - viewport.w / 2) / newZoom;
        cameraRef.current.y = pos.worldY - (pos.screenY - viewport.h / 2) / newZoom;
        cameraRef.current.zoom = newZoom;
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        // Prevent default to stop browser from attempting native scrolling/zooming gestures
        // and triggering the synthetic mouse event fallback pipeline on mobile.
        // NOTE: e.preventDefault() in pointerdown can break native click events, but we are capturing the pointer.
        
        // Track all pointers for multi-touch
        interactionRef.current.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        
        if (canvasRef.current) {
            canvasRef.current.setPointerCapture(e.pointerId);
        }

        // Prevent panning the background while a portrait is open
        if (openedCell) return;

        const pos = getMousePos(e.clientX, e.clientY);
        if (!pos) return;

        if (interactionRef.current.activePointers.size === 1) {
            interactionRef.current.isPointerDown = true;
            interactionRef.current.pointerMoved = false;
            interactionRef.current.downTime = Date.now();
            interactionRef.current.dragStart = { x: pos.screenX, y: pos.screenY };
            interactionRef.current.cameraStart = { x: cameraRef.current.x, y: cameraRef.current.y };
        } else if (interactionRef.current.activePointers.size === 2) {
            // Switch from panning to pinch zoom
            interactionRef.current.isPointerDown = false;
            const pointers = Array.from(interactionRef.current.activePointers.values()) as {x: number, y: number}[];
            const dx = pointers[0].x - pointers[1].x;
            const dy = pointers[0].y - pointers[1].y;
            interactionRef.current.initialPinchDistance = Math.sqrt(dx * dx + dy * dy);
            interactionRef.current.initialPinchZoom = cameraRef.current.zoom;
        }
    };

    const handlePointerCancel = (e: React.PointerEvent) => {

        interactionRef.current.activePointers.delete(e.pointerId);
        if (canvasRef.current && canvasRef.current.hasPointerCapture(e.pointerId)) {
             canvasRef.current.releasePointerCapture(e.pointerId);
        }
        interactionRef.current.isPointerDown = false;
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        // Ignore spurious 0,0 pointermove events from Android Chrome on quick taps
        if (e.clientX === 0 && e.clientY === 0) return;

        if (interactionRef.current.activePointers.has(e.pointerId)) {
            interactionRef.current.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }

        // Handle multi-touch pinch zoom
        if (interactionRef.current.activePointers.size === 2 && interactionRef.current.initialPinchDistance) {
            const canvas = canvasRef.current;
            if (!canvas) return;

            const pointers = Array.from(interactionRef.current.activePointers.values()) as {x: number, y: number}[];
            const dx = pointers[0].x - pointers[1].x;
            const dy = pointers[0].y - pointers[1].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const zoomFactor = dist / interactionRef.current.initialPinchDistance;

            const cx = (pointers[0].x + pointers[1].x) / 2;
            const cy = (pointers[0].y + pointers[1].y) / 2;

            const rect = canvas.getBoundingClientRect();
            const screenX = cx - rect.left;
            const screenY = cy - rect.top;

            const viewport = viewportRef.current;
            const worldX = (screenX - viewport.w / 2) / cameraRef.current.zoom + cameraRef.current.x;
            const worldY = (screenY - viewport.h / 2) / cameraRef.current.zoom + cameraRef.current.y;

            const minZoomX = viewport.w / (SVG_WORLD_W * 1.1);
            const minZoomY = viewport.h / (SVG_WORLD_H * 1.1);
            const minZoom = Math.min(minZoomX, minZoomY);

            const newZoom = Math.max(minZoom, Math.min(interactionRef.current.initialPinchZoom * zoomFactor, 50));

            cameraRef.current.x = worldX - (screenX - viewport.w / 2) / newZoom;
            cameraRef.current.y = worldY - (screenY - viewport.h / 2) / newZoom;
            cameraRef.current.zoom = newZoom;
            return;
        }

        const pos = getMousePos(e.clientX, e.clientY);
        if (!pos) return;

        // Hover tracking for mouse
        if (e.pointerType === 'mouse' && !interactionRef.current.isPointerDown) {
            mouseRef.current.x = pos.worldX;
            mouseRef.current.y = pos.worldY;
        }

        // Single-touch panning
        if (interactionRef.current.isPointerDown && !openedCell && interactionRef.current.activePointers.size === 1) {
            const dx = pos.screenX - interactionRef.current.dragStart.x;
            const dy = pos.screenY - interactionRef.current.dragStart.y;

            // Strict slop radius threshold (15px) for high-DPI screens
            if (!interactionRef.current.pointerMoved && Math.hypot(dx, dy) > 15) {

                interactionRef.current.pointerMoved = true;
            }

            if (interactionRef.current.pointerMoved) {
                cameraRef.current.x = interactionRef.current.cameraStart.x - dx / cameraRef.current.zoom;
                cameraRef.current.y = interactionRef.current.cameraStart.y - dy / cameraRef.current.zoom;
            }
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        interactionRef.current.activePointers.delete(e.pointerId);

        if (canvasRef.current && canvasRef.current.hasPointerCapture(e.pointerId)) {
             canvasRef.current.releasePointerCapture(e.pointerId);
        }

        // If finishing a pinch, don't trigger tap
        if (interactionRef.current.activePointers.size > 0) {
            return;
        }

        const wasPointerDown = interactionRef.current.isPointerDown;
        interactionRef.current.isPointerDown = false;

        // If gesture wasn't a valid primary pointer sequence, abort
        if (!wasPointerDown) {

            return;
        }

        // Let the HTML overlay handle closing if something is open
        if (openedCell) return; 

        // If they dragged their finger past the slop radius, it's a pan
        if (interactionRef.current.pointerMoved) {

            return;
        }

        // Enforce time threshold to distinguish tap from drag-and-hold
        const timeElapsed = Date.now() - interactionRef.current.downTime;
        if (timeElapsed > 750) {

            return;
        }

        const canvas = canvasRef.current;
        if (!canvas) return;

        // Use strictly captured coordinates to avoid missing pointers
        const screenX = interactionRef.current.dragStart.x;
        const screenY = interactionRef.current.dragStart.y;

        const viewport = viewportRef.current;
        const worldX = (screenX - viewport.w / 2) / cameraRef.current.zoom + cameraRef.current.x;
        const worldY = (screenY - viewport.h / 2) / cameraRef.current.zoom + cameraRef.current.y;

        const { activeCells } = useMosaicStore.getState();

        let clickedCell: Cell | null = null;
        for (let i = activeCells.length - 1; i >= 0; i--) {
            const cell = activeCells[i];
            if (worldX >= cell.x && worldX <= cell.x + cell.w &&
                worldY >= cell.y && worldY <= cell.y + cell.h) {
                clickedCell = cell;
                break;
            }
        }

        if (clickedCell) {
            if (navigator.vibrate) navigator.vibrate(10);
            interactionRef.current.lastOpenedTime = Date.now();
            clickedCellRef.current = clickedCell;
            setOpenedCell(clickedCell);
        } else {

        }
    };

    const handleClose = (e?: React.MouseEvent | KeyboardEvent) => {
        if (e && 'stopPropagation' in e) e.stopPropagation();

        // Prevent "ghost clicks" from instantly closing the modal on mobile
        if (Date.now() - interactionRef.current.lastOpenedTime < 400) return;

        if (navigator.vibrate) navigator.vibrate(20);
        clickedCellRef.current = null;
        setOpenedCell(null);
    };
    // Add Escape key support for accessibility and UX best practices
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && openedCell) {
                handleClose(e);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [openedCell]);

    const handlePointerLeave = (e: React.PointerEvent) => {
        handlePointerUp(e);
        mouseRef.current.x = -1000;
        mouseRef.current.y = -1000;
    };

    return (
        <div ref={containerRef} className="absolute top-0 left-0 w-full h-full z-10 overflow-hidden">
            <canvas
                ref={canvasRef}
                className="w-full h-full bg-[#0f0f11] touch-none cursor-pointer"
                style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'none' }}
                onClick={(e) => {
                    // Dummy handler to ensure iOS Safari treats the canvas as "clickable"
                    // and generates standard pointer events for short taps.
                }}
                onWheel={handleWheel}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onPointerLeave={handlePointerLeave}
            />
            {/* Story Panel HTML Overlay perfectly mapped to canvas active card space */}
            <AnimatePresence>
                 {openedCell && (
                     <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="absolute z-20 pointer-events-auto flex items-center justify-center"
                        style={{
                            width: windowSize.w,
                            height: windowSize.h,
                            top: 0,
                            left: 0
                        }}
                        onClick={() => handleClose()}
                     >
                         <motion.div 
                            initial={{ scale: 0.9, y: 20 }}
                            animate={{ scale: 1, y: 0 }}
                            exit={{ scale: 0.9, y: 20 }}
                            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                            className="relative text-[#111] pointer-events-auto flex flex-col justify-end shadow-[0_0_100px_rgba(0,0,0,0.5)] cursor-pointer bg-transparent" 
                            onClick={(e) => handleClose(e)}
                            style={{ 
                                width: calculateCardDimensions(windowSize.w, windowSize.h).width, 
                                height: calculateCardDimensions(windowSize.w, windowSize.h).height
                            }}
                         >
                             {/* Close Button Top-Right Corner of the Image Area */}
                             <div 
                                className="absolute top-3 right-3 sm:top-4 sm:right-4 h-9 w-9 sm:h-10 sm:w-10 rounded-full bg-white/20 backdrop-blur-md border border-white/40 flex items-center justify-center cursor-pointer hover:bg-white/40 transition-all z-30 group before:absolute before:-inset-3 before:content-['']"
                                onClick={(e) => handleClose(e)}
                             >
                                <div className="w-4 sm:w-5 h-[3px] bg-white rotate-45 absolute group-hover:scale-110" />
                                <div className="w-4 sm:w-5 h-[3px] bg-white -rotate-45 absolute group-hover:scale-110" />
                             </div>

                             <div className="w-full h-[150px] sm:h-[200px] p-5 sm:p-8 flex flex-col justify-start bg-white/95 backdrop-blur-xl cursor-default border-t border-gray-200" onClick={(e) => e.stopPropagation()}>
                                  <div className="overflow-y-auto pr-2 custom-scrollbar flex-1">
                                      <p className="font-sans text-base sm:text-lg text-gray-800 leading-relaxed font-medium">
                                          {openedCell.storyPanel || 'Processing neural scan... establishing connection with Jules mainframe. Narrative artifacts incoming.'}
                                      </p>
                                  </div>
                             </div>
                         </motion.div>
                     </motion.div>
                 )}
            </AnimatePresence>
        </div>
    );
};
