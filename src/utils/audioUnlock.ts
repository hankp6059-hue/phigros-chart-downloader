// on iPhone and iPad, Web Audio counts as "ambient" sound and is silenced by silent mode (the bell in
// Control Center, or the ring switch), while an <audio> element is not. call this from the tap that
// starts playback so the page is treated as playing music.

let silentClip: HTMLAudioElement | null = null;

/** A tenth of a second of silence as a WAV file. */
const silentWavUrl = () => {
    const samples = 800;
    const view = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (offset: number, value: string) => {
        for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples * 2, true);
    return URL.createObjectURL(new Blob([view], { type: 'audio/wav' }));
};

export const unlockAudio = (context?: AudioContext) => {
    // Safari 16.4+: declare the page as playing music
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) {
        try {
            session.type = 'playback';
        } catch {
            // older implementations reject unknown types; the fallback below still applies
        }
    }
    // older Safari: playing any <audio> element moves the page to the playback category
    if (!silentClip) {
        silentClip = new Audio(silentWavUrl());
        silentClip.setAttribute('playsinline', '');
    }
    silentClip.play().catch(() => {
        // not allowed outside a tap; playback will simply follow the device's sound settings
    });
    // a context created during the tap can still start suspended on iOS
    if (context && context.state === 'suspended') context.resume().catch(() => {});
};
