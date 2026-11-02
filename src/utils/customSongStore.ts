// custom songs saved in this browser (IndexedDB): the imported audio and cover with everything set in the
// dialog, so a song can be reopened, played and exported later. charts are not stored: they are generated
// again on opening (the generator is deterministic for the same song and settings).

import type { FingeringStyle, GeneratorDifficulty } from './chartGenerator';

export interface SavedSong {
    id: string;
    name: string;
    composer: string;
    charter: string;
    difficulty: GeneratorDifficulty;
    /** null: automatic rating */
    levelOverride: string | null;
    bpm: string;
    offsetMs: string;
    lineMotion: boolean;
    speedChanges: boolean;
    fingering: FingeringStyle;
    /** which staging of the judgment-line performances was picked (missing in songs saved before: 0) */
    stagingSeed?: number;
    audio: Blob;
    audioName: string;
    cover: Blob | null;
    coverName: string | null;
    savedAt: number;
}

/** a saved song without its (large) audio and cover, for listing */
export type SavedSongSummary = Omit<SavedSong, 'audio' | 'cover'> & { audioSize: number };

const DB_NAME = 'phigrosDownloader_customSongs';
const STORE = 'songs';

const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    try {
        return await new Promise<T>((resolve, reject) => {
            const request = action(db.transaction(STORE, mode).objectStore(STORE));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
};

export const listSavedSongs = async (): Promise<SavedSongSummary[]> => {
    const songs = await run<SavedSong[]>('readonly', store => store.getAll());
    return songs
        .map(song => {
            const summary: SavedSongSummary & { audio?: Blob; cover?: Blob | null } = { ...song, audioSize: song.audio.size };
            delete summary.audio;
            delete summary.cover;
            return summary as SavedSongSummary;
        })
        .sort((a, b) => b.savedAt - a.savedAt);
};

export const loadSavedSong = (id: string) => run<SavedSong | undefined>('readonly', store => store.get(id));

export const saveSong = async (song: SavedSong) => {
    // ask the browser not to clear saved songs when space runs low (it may decline; songs are kept either way)
    navigator.storage?.persist?.().catch(() => undefined);
    await run('readwrite', store => store.put(song));
};

export const deleteSavedSong = (id: string) => run('readwrite', store => store.delete(id));

export const newSongId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
