import {create} from 'zustand';
import {Cell} from '../utils/mosaic';

interface MosaicState {
    emptyBaseCells: Cell[];
    activeCells: Cell[];
    userCount: number;
    imageCache: Record<string, HTMLImageElement>;
    
    setInitialCells: (cells: Cell[]) => void;
    addActiveCell: (cell: Cell) => void;
    removeActiveCell: (cell: Cell) => void;
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
                    // On the public live site, fetch images securely from the Cloud VPS Tailscale Funnel
                    const vpsDomain = import.meta.env.VITE_VPS_DOMAIN || 'https://ubuntu-8gb-hel1-1.tail050dfe.ts.net';
                    safeUrl = `${vpsDomain}${url}`;
                } else {
                    // On the local Pi (or local dev), fetch images instantly from the local disk via Express
                    safeUrl = import.meta.env.BASE_URL + url.slice(1);
                }
            }

            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = () => {
                    // Fallback: If a local Pi 404s (e.g., trying to load a photo taken by a *different* booth that exists in the Git JSON but not locally),
                    // dynamically rewrite the URL to fetch it securely from the Cloud VPS Tailscale Funnel instead!
                    const vpsDomain = import.meta.env.VITE_VPS_DOMAIN || 'https://ubuntu-8gb-hel1-1.tail050dfe.ts.net';
                    if (!img.src.startsWith(vpsDomain)) {
                        console.warn(`[Mosaic] Local image missing (${id}). Falling back to Cloud VPS tunnel...`);
                        img.src = `${vpsDomain}${url}`;
                    } else {
                        reject(new Error('Image failed to load from both local and cloud.'));
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
