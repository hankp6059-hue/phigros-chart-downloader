/// <reference types="vite/client" />
// official Phigros music is 44.1 kHz stereo Ogg Vorbis, and that is what chart players handle best,
// so custom songs are exported the same way. encoding runs locally in WebAssembly (libvorbis).

import { createEncoder } from 'wasm-media-encoders';
import oggWasmUrl from 'wasm-media-encoders/wasm/ogg?url';

const SAMPLE_RATE = 44100;
// Vorbis quality 5 is about 160 kbit/s
const QUALITY = 5;

export const encodeOgg = async (buffer: AudioBuffer, onProgress?: (fraction: number) => void): Promise<Blob> => {
    // resample (and upmix mono) to 44.1 kHz stereo
    const length = Math.ceil(buffer.duration * SAMPLE_RATE);
    const offline = new OfflineAudioContext(2, length, SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    const stereo = await offline.startRendering();

    const encoder = await createEncoder('audio/ogg', oggWasmUrl);
    encoder.configure({ channels: 2, sampleRate: SAMPLE_RATE, vbrQuality: QUALITY });
    const left = stereo.getChannelData(0);
    const right = stereo.getChannelData(1);
    const chunks: BlobPart[] = [];
    const step = SAMPLE_RATE * 5;
    for (let i = 0; i < length; i += step) {
        // the encoder owns its output buffer, so each chunk is copied
        chunks.push(new Uint8Array(encoder.encode([left.subarray(i, i + step), right.subarray(i, i + step)])));
        onProgress?.(i / length);
        // let the page repaint between chunks
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    chunks.push(new Uint8Array(encoder.finalize()));
    onProgress?.(1);
    return new Blob(chunks, { type: 'audio/ogg' });
};
