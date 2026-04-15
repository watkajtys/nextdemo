export const GRID_WORLD_SIZE = 2000;
export const GRID_SIZE = 20;
export const CELL_SIZE = GRID_WORLD_SIZE / GRID_SIZE;
export const MAX_DEPTH = 4;

export const NEON_COLORS = [
    '#ff0055', '#00ffaa', '#00ddff', '#ffea00',
    '#bf00ff', '#ff6600', '#39ff14'
];

export interface Cell {
    x: number;
    y: number;
    w: number;
    h: number;
    depth: number;
    color?: string;
    hash?: string;
    time?: string;
    flash?: number;
    hoverProgress?: number;
    imageUrl?: string;
    julesThoughtProcess?: string;
}

export const SVG_SCALE = (620 / 134) * (GRID_WORLD_SIZE / 800);
export const SVG_WORLD_W = 124.6 * SVG_SCALE;
export const SVG_WORLD_H = 134 * SVG_SCALE;

// We export a pure function to initialize the grid instead of using global state
export function getInitialBaseCells(): Cell[] {
    const emptyBaseCells: Cell[] = [];
    
    // Safely check for document/canvas to avoid server-side rendering crashes
    if (typeof document === 'undefined') return [];
    
    const offCanvas = document.createElement('canvas');
    offCanvas.width = GRID_WORLD_SIZE;
    offCanvas.height = GRID_WORLD_SIZE;
    const offCtx = offCanvas.getContext('2d');
    if (!offCtx) return [];

    offCtx.fillStyle = 'black';
    offCtx.fillRect(0, 0, GRID_WORLD_SIZE, GRID_WORLD_SIZE);
    
    offCtx.fillStyle = 'white';
    
    // GitHub Icon Path
    const githubIconPath = new Path2D("M111.7 101.4c-3.1 0-5.5 2.5-5.5 5.5 0 3.1-2.5 5.5-5.5 5.5S95 110 95 107V78.8c.7-1.4 1.1-2.9 1.1-4.6V41.9c0-19.2-15.6-34.8-34.7-34.8S26.6 22.7 26.6 41.9v32.3c0 2.2.7 4.3 1.9 6V107c0 3.1-2.5 5.5-5.6 5.5s-5.5-2.5-5.5-5.5-2.5-5.5-5.5-5.5c-3.1 0-5.5 2.5-5.5 5.5 0 8.8 6.9 15.9 15.5 16.5.4.1.7.1 1.1.1s.8 0 1.1-.1c8.6-.6 15.5-7.7 15.5-16.5V84.8s-.3-4.7 3.7-4.7 3.7 4.7 3.7 4.7v22c0 3.1 2.5 5.5 5.5 5.5s5.5-2.5 5.5-5.5v-22s-.8-4.7 3.7-4.7 3.7 4.7 3.7 4.7v22c0 3.1 2.5 5.5 5.5 5.5 3.1 0 5.5-2.5 5.5-5.5v-22s-.3-4.7 3.7-4.7 3.7 4.7 3.7 4.7V107c0 8.8 6.9 15.9 15.5 16.5.4.1.7.1 1.1.1s.8 0 1.1-.1c8.7-.6 15.5-7.7 15.5-16.5.2-3.1-2.3-5.6-5.3-5.6M43.2 70c-3.1 0-5.5-3.1-5.5-6.9s2.5-6.9 5.5-6.9 5.5 3.1 5.5 6.9c.1 3.8-2.4 6.9-5.5 6.9m37 0c-3.1 0-5.5-3.1-5.5-6.9s2.5-6.9 5.5-6.9 5.5 3.1 5.5 6.9c.1 3.8-2.4 6.9-5.5 6.9");

    const scale = (620 / 134) * (GRID_WORLD_SIZE / 800); 
    const scaledW = 124.6 * scale;
    const scaledH = 134 * scale;
    const offsetX = (GRID_WORLD_SIZE - scaledW) / 2;
    const offsetY = (GRID_WORLD_SIZE - scaledH) / 2;
    
    offCtx.save();
    offCtx.translate(offsetX, offsetY);
    offCtx.scale(scale, scale);
    offCtx.fill(githubIconPath);
    
    // Fill in the eyes
    offCtx.fillStyle = 'white';
    offCtx.beginPath();
    offCtx.arc(43.2, 63.1, 10, 0, Math.PI * 2);
    offCtx.arc(80.2, 63.1, 10, 0, Math.PI * 2);
    offCtx.fill();
    offCtx.restore();

    const imageData = offCtx.getImageData(0, 0, GRID_WORLD_SIZE, GRID_WORLD_SIZE).data;

    // Evaluate valid Hit Map cells
    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE / 2; x++) {
            if (x === 7 && (y === 8 || y === 9)) {
                continue; // Force hole for left eye
            }

            const cx = Math.floor(x * CELL_SIZE + CELL_SIZE / 2);
            const cy = Math.floor(y * CELL_SIZE + CELL_SIZE / 2);
            const index = (cy * GRID_WORLD_SIZE + cx) * 4;
            
            if (imageData[index] > 128) {
                emptyBaseCells.push({ x: x * CELL_SIZE, y: y * CELL_SIZE, w: CELL_SIZE, h: CELL_SIZE, depth: 0 });
                const mirroredX = GRID_SIZE - 1 - x;
                emptyBaseCells.push({ x: mirroredX * CELL_SIZE, y: y * CELL_SIZE, w: CELL_SIZE, h: CELL_SIZE, depth: 0 });
            }
        }
    }
    
    // Shuffle cells to randomize appearance
    emptyBaseCells.sort(() => Math.random() - 0.5);
    return emptyBaseCells;
}

export function drawGraphicNovelAvatar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, seedString: string, highlightColor: string) {
    let seed = 0;
    for(let i=0; i<seedString.length; i++) {
        seed = ((seed << 5) - seed) + seedString.charCodeAt(i);
        seed |= 0;
    }
    const rand = () => {
        const sx = Math.sin(seed++) * 10000;
        return sx - Math.floor(sx);
    };

    ctx.save();
    ctx.translate(x, y);
    const scale = w / 100;
    ctx.scale(scale, scale);

    // Base silhouette
    ctx.fillStyle = '#0f0f11';
    
    const shoulderWidth = 35 + rand() * 15;
    const shoulderHeight = 75 + rand() * 10;
    ctx.beginPath();
    ctx.moveTo(50 - shoulderWidth, 100);
    ctx.lineTo(50 - shoulderWidth + 10, shoulderHeight);
    ctx.lineTo(50, shoulderHeight + 5); 
    ctx.lineTo(50 + shoulderWidth - 10, shoulderHeight);
    ctx.lineTo(50 + shoulderWidth, 100);
    ctx.fill();

    ctx.fillRect(40, 60, 20, 20);

    const headW = 16 + rand() * 8;
    const jawY = 70 + rand() * 12;
    const cheekY = 50 + rand() * 10;
    ctx.beginPath();
    ctx.moveTo(50 - headW, 20);
    ctx.lineTo(50 + headW, 20);
    ctx.lineTo(50 + headW, cheekY);
    ctx.lineTo(50 + headW - 6, jawY - 10);
    ctx.lineTo(50, jawY);
    ctx.lineTo(50 - headW + 6, jawY - 10);
    ctx.lineTo(50 - headW, cheekY);
    ctx.fill();

    const hairStyle = Math.floor(rand() * 4);
    ctx.beginPath();
    if (hairStyle === 0) {
        ctx.moveTo(50 - headW - 5, 35);
        for(let i=0; i<=5; i++) {
            ctx.lineTo(50 - headW + (i * headW * 2 / 5), 5 + rand() * 15);
            if(i < 5) ctx.lineTo(50 - headW + (i * headW * 2 / 5) + 5, 20 + rand()*5);
        }
        ctx.lineTo(50 + headW + 5, 35);
    } else if (hairStyle === 1) {
        ctx.moveTo(50 - headW - 2, 35);
        ctx.lineTo(50 - headW + 5, 5);
        ctx.lineTo(50 + headW + 5, 10);
        ctx.lineTo(50 + headW + 2, 35);
        ctx.lineTo(50, 20); 
    } else if (hairStyle === 2) {
        ctx.moveTo(50 - headW - 10, 60);
        ctx.lineTo(50 - headW, 10);
        ctx.lineTo(50 + headW, 10);
        ctx.lineTo(50 + headW + 10, 60);
        ctx.lineTo(50 + headW, 25);
        ctx.lineTo(50 - headW, 25);
    } else {
        ctx.moveTo(50 - headW, 20);
        ctx.lineTo(50 - headW + 5, 12);
        ctx.lineTo(50 + headW - 5, 12);
        ctx.lineTo(50 + headW, 20);
    }
    ctx.fill();

    // Highlights
    ctx.fillStyle = highlightColor;
    
    const lightDir = rand() > 0.5 ? 1 : -1; 

    ctx.beginPath();
    if (lightDir === 1) {
        ctx.moveTo(50, 20);
        ctx.lineTo(50 + headW - 2, 20);
        ctx.lineTo(50 + headW - 2, cheekY);
        ctx.lineTo(50 + headW - 7, jawY - 11);
        ctx.lineTo(50, jawY - 2);
        ctx.lineTo(50 + 6, 60);
        ctx.lineTo(50 - 3, 50);
        ctx.lineTo(50 + 5, 40);
        ctx.lineTo(50 - 2, 30);
    } else {
        ctx.moveTo(50, 20);
        ctx.lineTo(50 - headW + 2, 20);
        ctx.lineTo(50 - headW + 2, cheekY);
        ctx.lineTo(50 - headW + 7, jawY - 11);
        ctx.lineTo(50, jawY - 2);
        ctx.lineTo(50 - 6, 60);
        ctx.lineTo(50 + 3, 50);
        ctx.lineTo(50 - 5, 40);
        ctx.lineTo(50 + 2, 30);
    }
    ctx.fill();

    ctx.beginPath();
    if (lightDir === 1) {
        ctx.moveTo(50 + 8, shoulderHeight + 5);
        ctx.lineTo(50 + shoulderWidth - 12, shoulderHeight + 5);
        ctx.lineTo(50 + shoulderWidth - 5, 100);
        ctx.lineTo(50 + 15, 100);
    } else {
        ctx.moveTo(50 - 8, shoulderHeight + 5);
        ctx.lineTo(50 - shoulderWidth + 12, shoulderHeight + 5);
        ctx.lineTo(50 - shoulderWidth + 5, 100);
        ctx.lineTo(50 - 15, 100);
    }
    ctx.fill();

    const eyeY = 42 + rand() * 6;
    const eyeW = 6 + rand() * 4;
    const eyeH = 2 + rand() * 3;
    const angry = rand() > 0.3;

    ctx.fillStyle = lightDir === -1 ? '#0f0f11' : highlightColor;
    ctx.beginPath();
    ctx.moveTo(50 - 6, eyeY);
    ctx.lineTo(50 - 6 - eyeW, eyeY - (angry ? eyeH : -eyeH));
    ctx.lineTo(50 - 6 - eyeW/2, eyeY + eyeH);
    ctx.fill();

    ctx.fillStyle = lightDir === 1 ? '#0f0f11' : highlightColor;
    ctx.beginPath();
    ctx.moveTo(50 + 6, eyeY);
    ctx.lineTo(50 + 6 + eyeW, eyeY - (angry ? eyeH : -eyeH));
    ctx.lineTo(50 + 6 + eyeW/2, eyeY + eyeH);
    ctx.fill();

    ctx.fillStyle = highlightColor;
    ctx.beginPath();
    if (lightDir === 1) {
        ctx.moveTo(50, 50);
        ctx.lineTo(50 - 4, 58);
        ctx.lineTo(50, 58);
    } else {
        ctx.moveTo(50, 50);
        ctx.lineTo(50 + 4, 58);
        ctx.lineTo(50, 58);
    }
    ctx.fill();

    const mouthY = jawY - 12;
    const mouthW = 5 + rand() * 5;
    
    ctx.fillStyle = '#0f0f11';
    ctx.beginPath();
    ctx.moveTo(50 - mouthW, mouthY);
    ctx.lineTo(50 + mouthW, mouthY + (rand() > 0.5 ? 2 : -2));
    ctx.lineTo(50, mouthY + 2);
    ctx.fill();
    
    ctx.fillStyle = highlightColor;
    ctx.beginPath();
    if (lightDir === 1) {
        ctx.moveTo(50, mouthY);
        ctx.lineTo(50 - mouthW, mouthY + (rand() > 0.5 ? 2 : -2));
        ctx.lineTo(50, mouthY + 2);
    } else {
        ctx.moveTo(50, mouthY);
        ctx.lineTo(50 + mouthW, mouthY + (rand() > 0.5 ? 2 : -2));
        ctx.lineTo(50, mouthY + 2);
    }
    ctx.fill();

    ctx.fillStyle = '#0f0f11';
    ctx.beginPath();
    ctx.moveTo(50 - mouthW + 2, mouthY + 6);
    ctx.lineTo(50 + mouthW - 2, mouthY + 6);
    ctx.lineTo(50, mouthY + 10);
    ctx.fill();

    ctx.fillStyle = '#0f0f11';
    ctx.beginPath();
    if (lightDir === 1) {
        ctx.moveTo(40, 60);
        ctx.lineTo(50, 80);
        ctx.lineTo(40, 80);
    } else {
        ctx.moveTo(60, 60);
        ctx.lineTo(50, 80);
        ctx.lineTo(60, 80);
    }
    ctx.fill();

    ctx.restore();
}

export function getRandomNeonColor(): string {
    return NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
}

export function easeOutExpo(t: number): number {
    return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

export function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

// Pure function to handle Quadtree subdivision math
export function subdivideCell(parent: Cell, targetHash: string, targetTime: string, targetColor: string): { targetCell: Cell, siblings: Cell[] } {
    const hw = parent.w / 2;
    const hh = parent.h / 2;
    const nextDepth = parent.depth + 1;
    
    const quadrants: Cell[] = [
        { x: parent.x,      y: parent.y,      w: hw, h: hh, depth: nextDepth, color: parent.color, hash: targetHash, time: targetTime },
        { x: parent.x + hw, y: parent.y,      w: hw, h: hh, depth: nextDepth, color: parent.color, hash: targetHash, time: targetTime },
        { x: parent.x,      y: parent.y + hh, w: hw, h: hh, depth: nextDepth, color: parent.color, hash: targetHash, time: targetTime },
        { x: parent.x + hw, y: parent.y + hh, w: hw, h: hh, depth: nextDepth, color: parent.color, hash: targetHash, time: targetTime }
    ];

    const newUserIndex = Math.floor(Math.random() * 4);
    const targetCell = quadrants[newUserIndex];
    targetCell.color = targetColor;

    const siblings: Cell[] = [];
    for (let i = 0; i < 4; i++) {
        if (i !== newUserIndex) {
            siblings.push(quadrants[i]);
        }
    }

    return { targetCell, siblings };
}
