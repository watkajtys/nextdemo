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
            
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = url;
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
