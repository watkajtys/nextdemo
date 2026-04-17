import { Cell } from '../utils/mosaic';

// Vite feature: dynamically imports all JSON files in the portraits directory as modules
const rawPortraits = import.meta.glob('./portraits/*.json', { eager: true });

export const getLivePortraits = (): Partial<Cell>[] => {
    return Object.values(rawPortraits)
        .map((module: any) => module.default || module)
        .filter((portrait: any) => portrait.id !== 'nanobanana-stub') as Partial<Cell>[];
};
