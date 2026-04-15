import React, { useEffect, useRef } from 'react';
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

export const MosaicCanvas: React.FC<MosaicCanvasProps> = ({ animState, onAnimationComplete }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    
    // High-frequency mutable state kept in refs to avoid React re-renders
    const cameraRef = useRef<Camera>({ x: GRID_WORLD_SIZE / 2, y: GRID_WORLD_SIZE / 2, zoom: 1 });
    const mouseRef = useRef({ x: -1000, y: -1000 });
    const clickedCellRef = useRef<Cell | null>(null);
    
    // Interaction state
    const interactionRef = useRef({
        isPointerDown: false,
        pointerMoved: false,
        dragStart: { x: 0, y: 0 },
        cameraStart: { x: 0, y: 0 },
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
            canvas.width = width;
            canvas.height = height;

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
            const visibleW = canvas.width / camera.zoom;
            const visibleH = canvas.height / camera.zoom;

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
            const mouseX = mouseRef.current.x;
            const mouseY = mouseRef.current.y;
            let clickedCell = clickedCellRef.current;

            ctx.fillStyle = '#0f0f11';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.save();
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.scale(camera.zoom, camera.zoom);
            ctx.translate(-camera.x, -camera.y);

            const STRIP_HEIGHT = 120;
            let screenBigW = Math.min(800, canvas.width * 0.9);
            let screenBigH = screenBigW * 0.95 + STRIP_HEIGHT;

            if (screenBigH > canvas.height * 0.9) {
                screenBigH = canvas.height * 0.9;
                screenBigW = (screenBigH - STRIP_HEIGHT) / 0.95;
            }

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
                ctx.fillStyle = cell.color || '#fff';
                ctx.fillRect(cell.x, cell.y, cell.w, cell.h);

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
                    ctx.globalAlpha = eased;
                    drawGraphicNovelAvatar(ctx, photoX, photoY, photoW, photoH, cell.hash || 'default', cell.color || '#fff');
                }
                ctx.restore();

                if (eased > 0.3) {
                    const textAlpha = (eased - 0.3) * 1.4;
                    ctx.globalAlpha = Math.min(1, Math.max(0, textAlpha));

                    const bottomY = photoY + photoH;
                    const bottomH = currH - (border + photoH);

                    const scale = (eased * 1.2) / camera.zoom;

                    const iconX = currX + 50 * scale;
                    const iconY = bottomY + bottomH / 2;

                    ctx.strokeStyle = '#888';
                    ctx.lineWidth = 3 * scale;
                    ctx.beginPath();
                    ctx.arc(iconX, iconY, 10 * scale, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(iconX, iconY - 25 * scale);
                    ctx.lineTo(iconX, iconY - 10 * scale);
                    ctx.moveTo(iconX, iconY + 10 * scale);
                    ctx.lineTo(iconX, iconY + 25 * scale);
                    ctx.stroke();

                    ctx.fillStyle = '#111';
                    ctx.font = `bold ${22 * scale}px monospace`;
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(cell.hash || 'a1b2c3d', iconX + 30 * scale, iconY - 12 * scale);

                    ctx.fillStyle = '#666';
                    ctx.font = `${16 * scale}px sans-serif`;
                    ctx.fillText(cell.time || '12:00 PM', iconX + 30 * scale, iconY + 12 * scale);

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

                ctx.fillStyle = '#2a2a35';
                ctx.fillRect(currentX, currentY, currentW, currentH);

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
                    ctx.globalAlpha = fadeProgress;
                    drawGraphicNovelAvatar(ctx, photoX, photoY, photoW, photoH, targetCell.hash || 'default', targetCell.color || '#fff');
                }
                ctx.restore();

                if (currentW > bigW * 0.3) {
                    const textAlpha = Math.min(1, (currentW - bigW * 0.3) / (bigW * 0.3));
                    ctx.globalAlpha = textAlpha;

                    const bottomY = photoY + photoH;
                    const bottomH = currentH - (border + photoH);

                    const scale = ((currentW / bigW) * 1.2) / camera.zoom;

                    const iconX = currentX + 50 * scale;
                    const iconY = bottomY + bottomH / 2;

                    ctx.strokeStyle = '#888';
                    ctx.lineWidth = 3 * scale;
                    ctx.beginPath();
                    ctx.arc(iconX, iconY, 10 * scale, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(iconX, iconY - 25 * scale);
                    ctx.lineTo(iconX, iconY - 10 * scale);
                    ctx.moveTo(iconX, iconY + 10 * scale);
                    ctx.lineTo(iconX, iconY + 25 * scale);
                    ctx.stroke();

                    ctx.fillStyle = '#111';
                    ctx.font = `bold ${22 * scale}px monospace`;
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(targetCell.hash || 'a1b2c3d', iconX + 30 * scale, iconY - 12 * scale);

                    ctx.fillStyle = '#666';
                    ctx.font = `${16 * scale}px sans-serif`;
                    ctx.fillText(targetCell.time || '12:00 PM', iconX + 30 * scale, iconY + 12 * scale);

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

    // Input handlers
    const getMousePos = (e: React.MouseEvent | MouseEvent | React.TouchEvent | TouchEvent | React.PointerEvent | PointerEvent) => {
        const canvas = canvasRef.current;
        if (!canvas) return { screenX: 0, screenY: 0, worldX: 0, worldY: 0 };
        
        const rect = canvas.getBoundingClientRect();
        let clientX = 0, clientY = 0;

        if ('touches' in e && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else if ('changedTouches' in e && e.changedTouches && e.changedTouches.length > 0) {
            clientX = e.changedTouches[0].clientX;
            clientY = e.changedTouches[0].clientY;
        } else if ('clientX' in e) {
            clientX = (e as MouseEvent).clientX;
            clientY = (e as MouseEvent).clientY;
        }

        const screenX = clientX - rect.left;
        const screenY = clientY - rect.top;

        const camera = cameraRef.current;
        const worldX = (screenX - canvas.width / 2) / camera.zoom + camera.x;
        const worldY = (screenY - canvas.height / 2) / camera.zoom + camera.y;

        return { screenX, screenY, worldX, worldY };
    };

    const handleWheel = (e: React.WheelEvent) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        
        const zoomSensitivity = 0.001;
        const delta = -e.deltaY * zoomSensitivity;

        const minZoomX = canvas.width / (SVG_WORLD_W * 1.1);
        const minZoomY = canvas.height / (SVG_WORLD_H * 1.1);
        const minZoom = Math.min(minZoomX, minZoomY);

        const newZoom = Math.max(minZoom, Math.min(cameraRef.current.zoom * (1 + delta), 50));

        const pos = getMousePos(e);
        cameraRef.current.x = pos.worldX - (pos.screenX - canvas.width / 2) / newZoom;
        cameraRef.current.y = pos.worldY - (pos.screenY - canvas.height / 2) / newZoom;
        cameraRef.current.zoom = newZoom;
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        interactionRef.current.isPointerDown = true;
        interactionRef.current.pointerMoved = false;
        const pos = getMousePos(e);
        interactionRef.current.dragStart = { x: pos.screenX, y: pos.screenY };
        interactionRef.current.cameraStart = { x: cameraRef.current.x, y: cameraRef.current.y };
        
        if (canvasRef.current) {
             canvasRef.current.setPointerCapture(e.pointerId);
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        const pos = getMousePos(e);

        if (interactionRef.current.isPointerDown) {
            const dx = pos.screenX - interactionRef.current.dragStart.x;
            const dy = pos.screenY - interactionRef.current.dragStart.y;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) interactionRef.current.pointerMoved = true;

            cameraRef.current.x = interactionRef.current.cameraStart.x - dx / cameraRef.current.zoom;
            cameraRef.current.y = interactionRef.current.cameraStart.y - dy / cameraRef.current.zoom;
        } else if (e.pointerType === 'mouse') {
            mouseRef.current.x = pos.worldX;
            mouseRef.current.y = pos.worldY;
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        interactionRef.current.isPointerDown = false;
        if (!interactionRef.current.pointerMoved) {
            if (clickedCellRef.current) {
                clickedCellRef.current = null;
                return;
            }
            const pos = getMousePos(e);
            const { activeCells } = useMosaicStore.getState();
            for (let i = activeCells.length - 1; i >= 0; i--) {
                const cell = activeCells[i];
                if (pos.worldX >= cell.x && pos.worldX <= cell.x + cell.w &&
                    pos.worldY >= cell.y && pos.worldY <= cell.y + cell.h) {
                    clickedCellRef.current = cell;
                    break;
                }
            }
        }
    };

    const handlePointerLeave = () => {
        interactionRef.current.isPointerDown = false;
        clickedCellRef.current = null;
        mouseRef.current.x = -1000;
        mouseRef.current.y = -1000;
    };

    const handleTouchStart = (e: React.TouchEvent) => {
        mouseRef.current.x = -1000;
        mouseRef.current.y = -1000;
        if (e.touches.length === 2) {
            interactionRef.current.isPointerDown = false;
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            interactionRef.current.initialPinchDistance = Math.sqrt(dx * dx + dy * dy);
            interactionRef.current.initialPinchZoom = cameraRef.current.zoom;
        }
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (e.touches.length === 2 && interactionRef.current.initialPinchDistance) {
            const canvas = canvasRef.current;
            if (!canvas) return;

            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const zoomFactor = dist / interactionRef.current.initialPinchDistance;

            const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;

            const rect = canvas.getBoundingClientRect();
            const screenX = cx - rect.left;
            const screenY = cy - rect.top;

            const worldX = (screenX - canvas.width / 2) / cameraRef.current.zoom + cameraRef.current.x;
            const worldY = (screenY - canvas.height / 2) / cameraRef.current.zoom + cameraRef.current.y;

            const minZoomX = canvas.width / (SVG_WORLD_W * 1.1);
            const minZoomY = canvas.height / (SVG_WORLD_H * 1.1);
            const minZoom = Math.min(minZoomX, minZoomY);

            const newZoom = Math.max(minZoom, Math.min(interactionRef.current.initialPinchZoom * zoomFactor, 50));

            cameraRef.current.x = worldX - (screenX - canvas.width / 2) / newZoom;
            cameraRef.current.y = worldY - (screenY - canvas.height / 2) / newZoom;
            cameraRef.current.zoom = newZoom;
        }
    };

    return (
        <div ref={containerRef} className="absolute top-0 left-0 w-full h-full z-10">
            <canvas
                ref={canvasRef}
                className="w-full h-full bg-[#0f0f11] touch-none"
                style={{ WebkitTapHighlightColor: 'transparent' }}
                onWheel={handleWheel}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerLeave}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
            />
        </div>
    );
};
