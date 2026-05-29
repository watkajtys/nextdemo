import {create} from 'zustand';
import {Cell} from '../utils/mosaic';

interface MosaicState {
    emptyBaseCells: Cell[];
    activeCells: Cell[];
    userCount: number;
    imageCache: Record<string, HTMLImageElement>;
    
    setInitialCells: (cells: Cell[]) => void;
    addActiveCell: (cell: Cell) => void;
    removeActiveCell: (cell) => void;
    removeActiveCellByHash: (hash: string) => void;
    popEmptyBaseCell: () => Cell | undefined;
    incrementUserCount: () => void;
    addBulkActiveCells: (cells: Cell[]) => void;
    
    // Cloud Sync & Caching
    syncFromCloud: (cells: Cell[]) => void;
    loadImage: (id: string, url: string) => Promise<void>;
    updateActiveCellImage: (hash: string, url: string) => void;
}

export const useMosaicStore = create<MosaicState>((set, get) => ({
    emptyBaseCells: [],
    activeCells: [],
    userCount: 0,
    imageCache: {},

    setInitialCells: (cells) => set({ emptyBaseCells: cells }),
    
    addActiveCell: (cell) => {
        set((state) => ({ 
            activeCells: [...state.activeCells, cell],
            userCount: state.userCount + 1
        }));
        // If the cell has an image URL but isn't cached yet, start loading it
        if (cell.imageUrl && !get().imageCache[cell.hash || '']) {
             get().loadImage(cell.hash || '', cell.imageUrl);
        }
    },
    
    removeActiveCell: (cellToRemove) => set((state) => ({
        activeCells: state.activeCells.filter(cell => cell !== cellToRemove)
    })),

    removeActiveCellByHash: (hash) => set((state) => {
        const cellToRemove = state.activeCells.find(c => c.hash === hash);
        if (!cellToRemove) return state;
        
        return {
            activeCells: state.activeCells.filter(c => c.hash !== hash),
            emptyBaseCells: [...state.emptyBaseCells, cellToRemove],
            userCount: Math.max(0, state.userCount - 1)
        };
    }),
    
    popEmptyBaseCell: () => {
        const { emptyBaseCells } = get();
        if (emptyBaseCells.length === 0) return undefined;
        
        const newEmptyCells = [...emptyBaseCells];
        const cell = newEmptyCells.pop();
        set({ emptyBaseCells: newEmptyCells });
        return cell;
    },

    incrementUserCount: () => set((state) => ({ userCount: state.userCount + 1 })),
    
    addBulkActiveCells: (cells) => {
        set((state) => ({
            activeCells: [...state.activeCells, ...cells],
            userCount: state.userCount + cells.length
        }));
        
        // Eagerly load images for the new cells
        cells.forEach(cell => {
             if (cell.imageUrl && !get().imageCache[cell.hash || '']) {
                 get().loadImage(cell.hash || '', cell.imageUrl);
             }
        });
    },

    syncFromCloud: (cloudCells) => {
        set({ 
            activeCells: cloudCells,
            userCount: cloudCells.length
        });
        
        // Eagerly load any missing images from the cloud state
        cloudCells.forEach(cell => {
             if (cell.imageUrl && !get().imageCache[cell.hash || '']) {
                 get().loadImage(cell.hash || '', cell.imageUrl);
             }
        });
    },

    updateActiveCellImage: (hash, newImageUrl) => {
        set((state) => {
            const nextCache = { ...state.imageCache };
            delete nextCache[hash]; // Invalidate cache to force a reload from the cloud
            return {
                imageCache: nextCache,
                activeCells: state.activeCells.map(c => 
                    c.hash === hash ? { ...c, imageUrl: newImageUrl } : c
                )
            };
        });
        get().loadImage(hash, newImageUrl);
    },

    loadImage: async (id: string, url: string) => {
        // Prevent duplicate concurrent requests for the same image
        if (get().imageCache[id]) return;

        try {
            const img = new Image();
            img.crossOrigin = "anonymous"; // Important for canvas drawing from external URLs (like Firebase)

            // Fix absolute path mapping for GitHub Pages subpath hosting vs localhost root
            let safeUrl = url;
            if (url.startsWith('/') && !url.startsWith('//')) {
                if (typeof window !== 'undefined' && window.location.hostname.includes('github.io')) {
                    // On the public live site, fetch images from GitHub Raw (faster/more reliable than the VPS tunnel for static assets)
                    const githubBase = 'https://raw.githubusercontent.com/watkajtys/nextdemo/main/public';
                    safeUrl = `${githubBase}${url}`;
                } else {
                    // On the local Pi (or local dev), fetch images instantly from the local disk via Express
                    safeUrl = import.meta.env.BASE_URL + url.slice(1);
                }
            }

            await new Promise((resolve, reject) => {
                const githubBase = 'https://raw.githubusercontent.com/watkajtys/nextdemo/main/public';

                img.onload = resolve;
                img.onerror = () => {
                    // Fallback Tier 1: If local/default fails, try GitHub Raw
                    if (!img.src.startsWith(githubBase)) {
                        console.warn(`[Mosaic] Image missing locally (${id}). Trying GitHub Raw...`);
                        img.src = `${githubBase}${url}`;
                    } 
                    else {
                        // If it fails on GitHub too, and we lost the VPS, we MUST remove this card
                        console.error(`[Mosaic] Image ${id} not found locally or on GitHub. Removing card.`);
                        get().removeActiveCellByHash(id);
                        reject(new Error('Image failed to load from all available sources.'));
                    }
                };
                img.src = safeUrl;
            });

            set((state) => ({
                imageCache: {
                    ...state.imageCache,
                    [id]: img
                }
            }));
        } catch (error) {
            console.error(`Failed to load image for cell ${id} from ${url}`, error);
        }
    }
}));
