// 16-bit PCM WAV encoding of decoded audio, so imported songs in formats a chart player may not
// support (AAC .m4a, FLAC, ...) still play: every player handles plain WAV.

/** Audio formats that are packed as-is; anything else is converted to WAV. */
export const PLAYER_SAFE_AUDIO = ['ogg', 'mp3', 'wav'];

export const encodeWav = (buffer: AudioBuffer): Blob => {
    const channels = Math.min(2, buffer.numberOfChannels);
    const frames = buffer.length;
    const bytesPerSample = 2;
    const dataSize = frames * channels * bytesPerSample;
    const view = new DataView(new ArrayBuffer(44 + dataSize));

    const writeText = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
    view.setUint16(32, channels * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, dataSize, true);

    const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
            const sample = Math.max(-1, Math.min(1, data[c][i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            offset += bytesPerSample;
        }
    }
    return new Blob([view], { type: 'audio/wav' });
};
