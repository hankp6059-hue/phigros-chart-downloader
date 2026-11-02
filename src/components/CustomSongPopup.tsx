import React, { useEffect, useMemo, useState } from 'react';
import { DialogFrame, DialogHeader, DialogFooter, Button } from './ui/Dialog';
import { useSettings } from '../contexts/SettingsContext';
import { exportCustomChart } from '../utils/export';
import { ChartPreview } from './ChartPreview';
import { DifficultyCard } from './DifficultyCard';
import { PlayMode } from './PlayMode';
import { encodeWav } from '../utils/wav';
import { encodeOgg } from '../utils/oggEncode';
import type { BarState } from '../utils/lineMotion';
import type { Ease, Entry, Motif } from '../utils/choreography';
import FileSaver from 'file-saver';
import { SavedSongSummary, deleteSavedSong, listSavedSongs, loadSavedSong, newSongId, saveSong } from '../utils/customSongStore';
import {
    AudioAnalysis,
    FINGERING_STYLES,
    FingeringStyle,
    GENERATOR_DIFFICULTIES,
    GeneratorDifficulty,
    StreamPath,
    analyzeAudio,
    generateChart,
} from '../utils/chartGenerator';

interface CustomSongPopupProps {
    isOpen: boolean;
    onClose: () => void;
    onExported: (fileName: string) => void;
}

const inputClass = 'w-full min-w-0 h-[38px] max-md:h-11 px-3 rounded-lg bg-white/[.04] border border-white/[.08] text-[13px] max-md:text-base text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-[#22d3ee]/50';
const labelClass = 'flex flex-col gap-1.5 text-[12px] font-medium text-slate-400';

const LATENCY_KEY = 'phigrosDownloader_customLatencyMs';

const MOOD_LABELS: Record<BarState, string> = {
    silent: '静默', calm: '平缓', groove: '律动', build: '铺垫', drop: '爆发', climax: '高潮',
};
const MOOD_COLORS: Record<BarState, string> = {
    silent: '#334155', calm: '#60a5fa', groove: '#2dd4bf', build: '#fbbf24', drop: '#f43f5e', climax: '#e879f9',
};

const FINGERING_LABELS: Record<FingeringStyle, string> = { single: '双手单指', multi: '双手多指' };
const FINGERING_HINTS: Record<FingeringStyle, string> = {
    single: '手机双拇指：每只手一个手指，快速连打左右交互',
    multi: '平板多指：每只手三指，可单手滚键、按住 Hold 时同手点键，双押更多',
};

const MOTIF_LABELS: Record<Motif, string> = {
    relay: '接力', split: '分线', stack: '叠线', fan: '扇形', cross: '交叉', orbit: '旋转', sweep: '横扫',
    flyIn: '飞入', mirror: '镜像', pendulum: '钟摆', converge: '汇聚', shatter: '碎裂', pulse: '闪线',
    spiral: '螺旋', lattice: '网格', ripple: '涟漪', scissor: '剪刀',
};
const STREAM_LABELS: Record<StreamPath, string> = { cross: '横扫', converge: '双手收拢', arc: '弧线', wave: '波浪' };
const EASE_LABELS: Record<Ease, string> = { smooth: '平滑', out: '急起缓停', in: '缓起急停', sine: '柔和', linger: '停顿' };
const ENTRY_LABELS: Record<Entry, string> = { fade: '淡入', slide: '横移', drop: '落下', rise: '升起', unfold: '展开', turn: '转入' };

const fileExtension = (file: File, fallback: string) => {
    const match = /\.([a-z0-9]+)$/i.exec(file.name);
    return match ? match[1].toLowerCase() : fallback;
};

/** 16:9 cover with the song name, used when no illustration is imported. */
const createPlaceholderIllustration = (title: string, subtitle: string): Promise<Blob> => {
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const g = canvas.getContext('2d')!;
    const gradient = g.createLinearGradient(0, 0, 1920, 1080);
    gradient.addColorStop(0, '#0f172a');
    gradient.addColorStop(1, '#164e63');
    g.fillStyle = gradient;
    g.fillRect(0, 0, 1920, 1080);
    g.fillStyle = '#22d3ee';
    g.fillRect(160, 470, 24, 140);
    g.fillStyle = '#f1f5f9';
    g.font = '600 96px Saira, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(title, 230, 510, 1530);
    g.fillStyle = '#94a3b8';
    g.font = '400 48px Saira, sans-serif';
    g.fillText(subtitle, 230, 600, 1530);
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('无法生成封面'))), 'image/png'));
};

export const CustomSongPopup: React.FC<CustomSongPopupProps> = ({ isOpen, onClose, onExported }) => {
    const { settings } = useSettings();

    const [audioFile, setAudioFile] = useState<File | null>(null);
    const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
    const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [coverFile, setCoverFile] = useState<File | null>(null);
    const [coverUrl, setCoverUrl] = useState<string | null>(null);

    const [name, setName] = useState('');
    const [composer, setComposer] = useState('');
    const [charter, setCharter] = useState('自动生成');
    const [difficulty, setDifficulty] = useState<GeneratorDifficulty>('IN');
    // null means use the automatic rating
    const [levelOverride, setLevelOverride] = useState<string | null>(null);
    const [bpmInput, setBpmInput] = useState('');
    const [offsetInput, setOffsetInput] = useState('0');

    const [error, setError] = useState<string | null>(null);
    const [exportProgress, setExportProgress] = useState<number | null>(null);
    const [showPreview, setShowPreview] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [latencyInput, setLatencyInput] = useState(() => {
        try {
            return localStorage.getItem(LATENCY_KEY) ?? '0';
        } catch {
            return '0';
        }
    });
    useEffect(() => {
        try {
            localStorage.setItem(LATENCY_KEY, latencyInput);
        } catch {
            // private browsing: the setting just isn't remembered
        }
    }, [latencyInput]);
    const [lineMotion, setLineMotion] = useState(true);
    const [speedChanges, setSpeedChanges] = useState(true);
    // which staging of the judgment-line performances; changing it restages them and leaves the notes
    const [stagingSeed, setStagingSeed] = useState(0);
    const [fingering, setFingering] = useState<FingeringStyle>('single');

    // songs saved in this browser; `savedId` is the one open (saving again updates it)
    const [savedSongs, setSavedSongs] = useState<SavedSongSummary[]>([]);
    const [savedId, setSavedId] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    /** settings as last saved or opened, to tell whether there is anything new to save */
    const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
    const [storageError, setStorageError] = useState<string | null>(null);
    const [skinState, setSkinState] = useState<'idle' | 'building' | 'failed'>('idle');
    const downloadSkin = async () => {
        setSkinState('building');
        try {
            // loaded on demand: it brings the zip library along
            const { buildPhiraSkin } = await import('../utils/phiraSkin');
            FileSaver.saveAs(await buildPhiraSkin(), 'Phigros-Style-Phira-Skin.zip');
            setSkinState('idle');
        } catch (e) {
            console.error(e);
            setSkinState('failed');
        }
    };
    const refreshSaved = () => listSavedSongs().then(setSavedSongs).catch(() => setStorageError('这个浏览器无法保存歌曲（可能处于无痕模式或禁用了网站数据）。'));
    useEffect(() => {
        if (isOpen) refreshSaved();
    }, [isOpen]);

    useEffect(() => {
        if (!coverFile) {
            setCoverUrl(null);
            return;
        }
        const url = URL.createObjectURL(coverFile);
        setCoverUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [coverFile]);

    /** `saved`: BPM and offset of a saved song, kept instead of the detected ones */
    const handleAudio = async (file: File | undefined, saved?: { bpm: string; offsetMs: string }) => {
        if (!file) return;
        setShowPreview(false);
        setError(null);
        setAudioFile(file);
        setAnalysis(null);
        setAudioBuffer(null);
        if (!name && !saved) setName(file.name.replace(/\.[^.]+$/, ''));
        setIsAnalyzing(true);
        try {
            const context = new AudioContext();
            const buffer = await context.decodeAudioData(await file.arrayBuffer());
            context.close();
            // let the spinner paint before the (synchronous) analysis
            await new Promise(resolve => setTimeout(resolve, 30));
            const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
            const result = analyzeAudio(channels, buffer.sampleRate);
            setAudioBuffer(buffer);
            setAnalysis(result);
            setBpmInput(saved?.bpm ?? String(result.bpm));
            setOffsetInput(saved?.offsetMs ?? '0');
        } catch (e) {
            console.error(e);
            setAudioFile(null);
            setError('无法解码该音频文件，请换用 OGG / MP3 / WAV / FLAC 格式。');
        } finally {
            setIsAnalyzing(false);
        }
    };

    const snapshot = (values: { name: string; composer: string; charter: string; difficulty: string; levelOverride: string | null; bpm: string; offsetMs: string; lineMotion: boolean; speedChanges: boolean; fingering: string; stagingSeed?: number; cover: Blob | null }) =>
        JSON.stringify([values.name, values.composer, values.charter, values.difficulty, values.levelOverride, values.bpm, values.offsetMs,
            values.lineMotion, values.speedChanges, values.fingering, values.stagingSeed ?? 0, values.cover ? values.cover.size : null]);
    const currentSnapshot = snapshot({ name: name.trim() || '未命名', composer: composer.trim(), charter: charter.trim(), difficulty, levelOverride, bpm: bpmInput, offsetMs: offsetInput, lineMotion, speedChanges, fingering, stagingSeed, cover: coverFile });

    const handleSave = async () => {
        if (!audioFile) return;
        setSaving(true);
        setStorageError(null);
        const id = savedId ?? newSongId();
        try {
            await saveSong({
                id,
                name: name.trim() || '未命名',
                composer: composer.trim(),
                charter: charter.trim(),
                difficulty,
                levelOverride,
                bpm: bpmInput,
                offsetMs: offsetInput,
                lineMotion,
                speedChanges,
                fingering,
                stagingSeed,
                audio: audioFile,
                audioName: audioFile.name,
                cover: coverFile,
                coverName: coverFile?.name ?? null,
                savedAt: Date.now(),
            });
            setSavedId(id);
            setSavedSnapshot(currentSnapshot);
            refreshSaved();
        } catch (e) {
            console.error(e);
            setStorageError('保存失败：浏览器的存储空间可能不足，或网站数据被禁用。');
        } finally {
            setSaving(false);
        }
    };

    const openSaved = async (id: string) => {
        try {
            const song = await loadSavedSong(id);
            if (!song) return refreshSaved();
            setSavedId(id);
            setSavedSnapshot(snapshot({ ...song, cover: song.cover }));
            setName(song.name);
            setComposer(song.composer);
            setCharter(song.charter);
            setDifficulty(song.difficulty);
            setLevelOverride(song.levelOverride);
            setLineMotion(song.lineMotion);
            setSpeedChanges(song.speedChanges);
            setFingering(song.fingering);
            setStagingSeed(song.stagingSeed ?? 0);
            setCoverFile(song.cover ? new File([song.cover], song.coverName ?? 'cover.png', { type: song.cover.type }) : null);
            await handleAudio(new File([song.audio], song.audioName, { type: song.audio.type }), { bpm: song.bpm, offsetMs: song.offsetMs });
        } catch (e) {
            console.error(e);
            setStorageError('无法读取保存的歌曲。');
        }
    };

    const removeSaved = async (song: SavedSongSummary) => {
        if (!window.confirm(`从这个浏览器删除「${song.name}」？`)) return;
        try {
            await deleteSavedSong(song.id);
            if (savedId === song.id) {
                setSavedId(null);
                setSavedSnapshot(null);
            }
            refreshSaved();
        } catch (e) {
            console.error(e);
            setStorageError('删除失败。');
        }
    };

    /** a fresh form for importing another song */
    const startNew = () => {
        setSavedId(null);
        setSavedSnapshot(null);
        setAudioFile(null);
        setAudioBuffer(null);
        setAnalysis(null);
        setCoverFile(null);
        setName('');
        setComposer('');
        setLevelOverride(null);
        setBpmInput('');
        setOffsetInput('0');
        setShowPreview(false);
        setStagingSeed(0);
        setError(null);
    };

    const upToDate = savedId !== null && currentSnapshot === savedSnapshot;

    const bpm = parseFloat(bpmInput);
    const bpmValid = Number.isFinite(bpm) && bpm >= 30 && bpm <= 400;
    const offsetMs = parseFloat(offsetInput) || 0;

    // every difficulty is generated so each card can show its own rating
    const charts = useMemo(() => {
        if (!analysis || !bpmValid) return null;
        return Object.fromEntries(GENERATOR_DIFFICULTIES.map(diff => [diff, generateChart(analysis, {
            difficulty: diff,
            bpm,
            firstBeat: analysis.firstBeat + offsetMs / 1000,
            seed: `${name}|${audioFile?.size ?? 0}`,
            lineMotion,
            speedChanges,
            fingering,
            stagingSeed,
        })])) as Record<GeneratorDifficulty, ReturnType<typeof generateChart>>;
    }, [analysis, bpmValid, bpm, offsetMs, name, audioFile, lineMotion, speedChanges, fingering, stagingSeed]);
    const generated = charts?.[difficulty] ?? null;

    const level = levelOverride ?? (generated ? String(generated.level) : '');

    // official music is Ogg Vorbis; anything else is converted so it plays like the official songs do
    const keepsOriginalAudio = audioFile ? fileExtension(audioFile, '') === 'ogg' : false;
    const [convertProgress, setConvertProgress] = useState<number | null>(null);

    const handleExport = async () => {
        if (!audioFile || !audioBuffer || !generated) return;
        setShowPreview(false);
        setError(null);
        setExportProgress(0);
        try {
            const songName = name.trim() || '未命名';
            const illustration = coverFile ?? await createPlaceholderIllustration(songName, composer || 'Custom Song');
            let audio: Blob = audioFile;
            let audioExtension = 'ogg';
            if (!keepsOriginalAudio) {
                setConvertProgress(0);
                try {
                    audio = await encodeOgg(audioBuffer, setConvertProgress);
                } catch (e) {
                    // no WebAssembly or encoder failure: plain WAV still plays everywhere
                    console.error(e);
                    audio = encodeWav(audioBuffer);
                    audioExtension = 'wav';
                } finally {
                    setConvertProgress(null);
                }
            }
            const fileName = await exportCustomChart({
                name: songName,
                composer: composer.trim() || 'Unknown',
                charter: charter.trim() || 'Unknown',
                difficulty,
                level: parseFloat(level) || 0,
                chart: generated.chart,
                audio,
                audioExtension,
                illustration,
                illustrationExtension: coverFile ? fileExtension(coverFile, 'png') : 'png',
            }, settings, setExportProgress);
            onExported(fileName);
        } catch (e) {
            console.error(e);
            setError(`导出失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setExportProgress(null);
        }
    };

    if (!isOpen) return null;

    const isExporting = exportProgress !== null;
    const formatLabel = `${settings.useZipFormat ? 'ZIP' : 'PEZ'} · ${settings.chartFormatConversion === 'rpe' ? 'RPE 格式' : '官方格式'}`;

    return (
        <DialogFrame onClose={onClose} labelledBy="custom-song-title" className="w-full max-w-[640px] max-h-[min(760px,calc(100dvh-32px))]">
            <DialogHeader id="custom-song-title" eyebrow="自定义歌曲" title="导入歌曲并生成谱面" onClose={onClose} />

            <div className="flex-1 min-h-0 overflow-y-auto thin-scroll px-6 max-md:px-5 py-5 flex flex-col gap-5">
                {savedSongs.length > 0 && (
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <span className="text-[12px] font-medium text-slate-400">我的歌曲（保存在这个浏览器）</span>
                            {(audioFile || savedId) && <Button variant="ghost" onClick={startNew}>导入新歌曲</Button>}
                        </div>
                        <ul className="flex flex-col rounded-xl border border-white/[.08] divide-y divide-white/[.06] max-h-[180px] overflow-y-auto thin-scroll">
                            {savedSongs.map(song => (
                                <li key={song.id} className={`flex items-center gap-3 px-3 py-2 ${song.id === savedId ? 'bg-[#22d3ee]/[.08]' : ''}`}>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[13px] text-slate-100 truncate">{song.name}</div>
                                        <div className="text-[11px] text-slate-500 truncate">
                                            {[song.composer, song.difficulty, `${(song.audioSize / 1048576).toFixed(1)} MB`, new Date(song.savedAt).toLocaleDateString()].filter(Boolean).join(' · ')}
                                        </div>
                                    </div>
                                    <Button variant="outline" onClick={() => openSaved(song.id)} disabled={isAnalyzing}>{song.id === savedId ? '已打开' : '打开'}</Button>
                                    <Button variant="ghost" onClick={() => removeSaved(song)}>删除</Button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {storageError && <p className="text-[12px] text-[#fbbf24]">{storageError}</p>}
                <div className="grid grid-cols-[1fr_auto] max-md:grid-cols-1 gap-4">
                    <label className={labelClass}>
                        音频（必填）
                        <input
                            type="file"
                            accept="audio/*,.ogg,.mp3,.wav,.flac"
                            onChange={e => handleAudio(e.target.files?.[0])}
                            className="text-[13px] text-slate-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-[#22d3ee] file:text-[#06141a] file:font-semibold"
                        />
                        <span className="text-[12px] font-normal text-slate-500">
                            {isAnalyzing ? '正在分析节奏…' : analysis
                                ? `${audioFile ? `${audioFile.name} · ` : ''}时长 ${Math.floor(analysis.duration / 60)}:${String(Math.floor(analysis.duration % 60)).padStart(2, '0')} · 检测到 BPM ${analysis.bpm}`
                                : '支持浏览器能解码的格式（OGG、MP3、WAV、M4A、FLAC 等）。'}
                            {audioFile && !keepsOriginalAudio && ' · 导出时转为 OGG（和原游戏的音乐相同的格式）'}
                        </span>
                    </label>
                    <label className={`${labelClass} items-start`}>
                        曲绘（可选）
                        <div className="w-[160px] aspect-video rounded-lg border border-white/[.08] bg-white/[.03] overflow-hidden flex items-center justify-center text-[11px] text-slate-500">
                            {coverUrl ? <img src={coverUrl} alt="" className="w-full h-full object-cover" /> : '自动生成封面'}
                        </div>
                        <input
                            type="file"
                            accept="image/png,image/jpeg"
                            onChange={e => setCoverFile(e.target.files?.[0] ?? null)}
                            className="w-[160px] text-[11px] text-slate-400 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-white/[.08] file:text-slate-200"
                        />
                    </label>
                </div>

                <div className="grid grid-cols-3 max-md:grid-cols-1 gap-3">
                    <label className={labelClass}>曲名<input className={inputClass} value={name} onChange={e => setName(e.target.value)} /></label>
                    <label className={labelClass}>曲师<input className={inputClass} value={composer} onChange={e => setComposer(e.target.value)} /></label>
                    <label className={labelClass}>谱师<input className={inputClass} value={charter} onChange={e => setCharter(e.target.value)} /></label>
                </div>

                <div className={labelClass}>
                    难度
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5" role="radiogroup" aria-label="难度">
                        {GENERATOR_DIFFICULTIES.map(diff => (
                            <DifficultyCard
                                key={diff}
                                difficulty={diff}
                                level={diff === difficulty && levelOverride !== null ? levelOverride || '?' : charts ? charts[diff].level.toFixed(1) : '?'}
                                selected={diff === difficulty}
                                onClick={() => { setDifficulty(diff); setLevelOverride(null); }}
                            />
                        ))}
                    </div>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                    <label className={`${labelClass} w-[110px]`}>
                        {levelOverride === null ? '定数（自动）' : '定数（手动）'}
                        <input className={inputClass} inputMode="decimal" value={level} onChange={e => setLevelOverride(e.target.value)} disabled={!generated} />
                    </label>
                    <label className={`${labelClass} w-[110px]`}>
                        BPM
                        <input className={`${inputClass} ${bpmInput && !bpmValid ? 'border-[#f87171]/60' : ''}`} inputMode="decimal" value={bpmInput} onChange={e => setBpmInput(e.target.value)} disabled={!analysis} />
                    </label>
                    <label className={`${labelClass} w-[110px]`}>
                        偏移 (ms)
                        <input className={inputClass} inputMode="numeric" value={offsetInput} onChange={e => setOffsetInput(e.target.value)} disabled={!analysis} />
                    </label>
                    {analysis && bpmInput !== String(analysis.bpm) && (
                        <Button variant="ghost" onClick={() => setBpmInput(String(analysis.bpm))}>恢复检测 BPM</Button>
                    )}
                    {levelOverride !== null && (
                        <Button variant="ghost" onClick={() => setLevelOverride(null)}>恢复自动定数</Button>
                    )}
                </div>

                {generated && (
                    <div className="rounded-xl border border-[rgba(34,211,238,.22)] bg-[rgba(34,211,238,.04)] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[12px] text-slate-300">
                            <span className="text-slate-100 font-semibold">{difficulty} Lv.{generated.level.toFixed(1)}</span>
                            <span className="text-slate-100">物量 {generated.stats.total}</span>
                            <span className="text-[#7dd3fc]">Tap {generated.stats.tap}</span>
                            <span className="text-[#fde047]">Drag {generated.stats.drag}</span>
                            <span className="text-[#f87171]">Flick {generated.stats.flick}</span>
                            <span className="text-[#c4b5fd]">Hold {generated.stats.hold}</span>
                            <span className="text-slate-400" title="谱面流速（官方单位），随歌曲段落变化">
                                流速 {generated.speed.min === generated.speed.max ? generated.speed.min.toFixed(2) : `${generated.speed.min.toFixed(2)}–${generated.speed.max.toFixed(2)}`}
                            </span>
                        </div>
                        <Button variant="outline" onClick={() => setShowPreview(v => !v)}>{showPreview ? '收起预览' : '预览谱面'}</Button>
                    </div>
                )}

                {analysis && (
                    <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2 text-[13px] text-slate-300">
                            指法
                            {FINGERING_STYLES.map(style => (
                                <button
                                    key={style}
                                    type="button"
                                    title={FINGERING_HINTS[style]}
                                    onClick={() => setFingering(style)}
                                    className={`h-8 px-3 rounded-lg border text-[13px] transition-colors ${fingering === style ? 'border-[#22d3ee]/60 bg-[#22d3ee]/10 text-white' : 'border-white/[.08] bg-white/[.04] text-slate-400 hover:text-slate-200'}`}
                                >
                                    {FINGERING_LABELS[style]}
                                </button>
                            ))}
                            <span className="text-[12px] text-slate-500">{FINGERING_HINTS[fingering]}</span>
                        </div>
                        <label className="flex items-center gap-2 text-[13px] text-slate-300">
                            <input type="checkbox" checked={lineMotion} onChange={e => setLineMotion(e.target.checked)} className="accent-[#22d3ee]" />
                            判定线随歌曲情绪运动
                        </label>
                        <label className="flex items-center gap-2 text-[13px] text-slate-300">
                            <input type="checkbox" checked={speedChanges} onChange={e => setSpeedChanges(e.target.checked)} className="accent-[#22d3ee]" />
                            流速随音乐变化（平缓处放慢，铺垫逐拍加速，爆发与高潮提速）
                        </label>
                        {generated?.motion && (
                            <>
                                <div className="flex h-3 rounded overflow-hidden" title="每格一小节">
                                    {generated.motion.bars.map((bar, i) => (
                                        <span key={i} className="flex-1" style={{ background: MOOD_COLORS[bar.state], opacity: 0.35 + 0.65 * bar.intensity }} title={`第 ${i + 1} 小节 · ${MOOD_LABELS[bar.state]}`} />
                                    ))}
                                </div>
                                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
                                    {(Object.keys(MOOD_LABELS) as BarState[]).map(state => (
                                        <span key={state} className="flex items-center gap-1">
                                            <span className="w-2 h-2 rounded-sm" style={{ background: MOOD_COLORS[state] }} />{MOOD_LABELS[state]}
                                        </span>
                                    ))}
                                    <span className="text-slate-500">
                                        高潮风格：弹跳 {Math.round(generated.motion.character.bounce * 100)}% · 钟摆 {Math.round(generated.motion.character.pendulum * 100)}% · 波浪 {Math.round(generated.motion.character.wave * 100)}%
                                    </span>
                                </div>
                                {generated.streams.length > 0 && (
                                    <p className="text-[11px] leading-[1.6] text-slate-400" title="高潮前一小节用黄键冲刺，落在高潮第一拍（EZ 以外为双押）；高潮里乐句结尾用两拍黄键滑进下一句">
                                        <span className="text-[#ece34f]">黄键流 {generated.streams.length} 段</span>：
                                        冲刺 {generated.streams.filter(s => s.kind === 'runway').length} · 高潮过门 {generated.streams.filter(s => s.kind === 'fill').length}
                                        （{generated.streams.map(s => `${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, '0')} ${STREAM_LABELS[s.path]}`).join('、')}）
                                    </p>
                                )}
                                {generated.choreography && generated.choreography.performances.length > 0 && (
                                    <div className="flex items-start gap-2">
                                        <p className="flex-1 text-[11px] leading-[1.6] text-slate-400" title="按歌曲段落、重音和风格编排，每首歌不同；同一段动作每次出场的缓动、进场方式、节奏也不同">
                                            判定线演出 {generated.choreography.performances.length} 段（{generated.choreography.lineCount + 1} 条线）：
                                            {generated.choreography.performances.map(p => `${MOTIF_LABELS[p.motif]}·${ENTRY_LABELS[p.variant.entry]}${p.variant.snap ? '·卡点' : ''}`).join(' → ')}
                                            <span className="block text-slate-500">
                                                本曲风格：{generated.choreography.style.eases.map(e => EASE_LABELS[e]).join('/')}
                                                {generated.choreography.style.stagger > 0 ? ' · 依次错开' : ''}
                                                {generated.choreography.style.spin > 0 ? ' · 自转' : ''}
                                                {generated.choreography.style.breathe > 0 ? ' · 随拍闪烁' : ''}
                                                {stagingSeed > 0 ? ` · 第 ${stagingSeed + 1} 套` : ''}
                                            </span>
                                        </p>
                                        <button type="button" onClick={() => setStagingSeed(s => s + 1)} title="音符不变，重新编排判定线演出"
                                            className="shrink-0 px-2 py-1 rounded border border-white/15 text-[11px] text-slate-300 hover:bg-white/10">
                                            换一套演出
                                        </button>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}

                {showPreview && generated && audioBuffer && (
                    <ChartPreview chart={generated.chart} audio={audioBuffer} cover={coverUrl} />
                )}

                <p className="text-[12px] leading-[1.6] text-slate-500 text-pretty">
                    音符放在哪里，由一个从 240 首官方谱面（曲库的 73%）里学到的模型决定，模仿谱师的取舍。键位按官方谱面的双手习惯来排，可选「双手单指」（手机双拇指）或「双手多指」（平板，每只手三指）：左手负责左半屏、右手负责右半屏，两手永不交叉；
                    快于单手连打的音符左右交互，慢一些时旋律上行交给右手、下行交给左手，每只手顺着旋律从上一个位置移动，移动距离不超过手指在这段时间里能到达的范围；
                    双押一手一个，Hold 由一只手按住时其余音符全部交给另一只手，音符之间不会重叠。键型的排布参照 96 张官方谱面：红色 Flick 落在重拍和乐句结尾，常成对出现或接在一串 Drag 后面（滑后划）；Flick 之后 0.3 秒内附近不放 Tap / Hold，避免划键时误触，紧跟的多是 Flick 或 Drag。黄色 Drag 是轻打和快速连音，连成一条随旋律扫动的线；双押会混搭键型（Drag+Tap、Hold+Tap、Flick+Tap、双 Flick），
                    持续的长音是 Hold，其余是蓝色 Tap。流速跟着段落走：平缓、静默段放慢，铺垫段逐拍加速，爆发和高潮段提速（EZ 变化更小）。额外的判定线按段落、重音和歌曲风格编排演出（接力、分线、扇形、交叉、旋转、碎裂等），每首歌都不同，同一首歌重复的段落会以镜像重现；Hard 及以上，接力时一条倾斜的副线飞入接手整段乐句、主线变暗，分线时右手音符走上面的线、左手走下面的线，副线上的音符在屏幕上的左右位置和指法都不变。主判定线按每小节的情绪运动：平缓处呼吸、律动处摇摆、铺垫时蓄力倾斜、爆发时回正下砸，
                    高潮的动法由歌曲本身的明亮度、密度和旋律起伏混合而成。物量和各种键的比例参照官方同难度谱面的中位数；定数由官方 516 张谱面拟合的公式自动评出（平均误差约 ±1）。
                    如果试听时打击音和节拍对不上，请修改 BPM 或偏移（正数让音符更晚出现）。导出格式与原程序一致，遵循设置里的「ZIP 格式」和「谱面格式转换」选项。
                </p>

                <div className="rounded-xl border border-white/[.08] bg-white/[.02] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-[12px] leading-[1.6] text-slate-400 flex-1 min-w-[220px]">
                        在 Phira 里，键的形状和打击动画由 Phira 的资源包决定，谱面改变不了。下载这个原作风格的资源包（全部用代码绘制，不含游戏素材），
                        在 Phira 的「设置 → 资源包」里导入一次，之后所有谱面都会用原作风格的键型和打击动画。
                    </p>
                    <Button variant="outline" onClick={downloadSkin} disabled={skinState === 'building'}>
                        {skinState === 'building' ? '生成中…' : skinState === 'failed' ? '生成失败，重试' : '下载 Phira 皮肤'}
                    </Button>
                </div>

                {error && <p className="text-[13px] text-[#f87171]">{error}</p>}
            </div>

            <DialogFooter>
                <label className="flex items-center gap-2 text-[12px] text-slate-400" title="耳机或音箱有延迟时，判定会感觉偏早；调大这个值">
                    延迟校准
                    <input
                        className="w-[64px] h-8 px-2 rounded-md bg-white/[.04] border border-white/[.08] text-[13px] max-md:text-base text-slate-200 focus:outline-none focus:border-[#22d3ee]/50"
                        inputMode="numeric"
                        value={latencyInput}
                        onChange={e => setLatencyInput(e.target.value)}
                    />
                    ms
                </label>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="md" title="把音频、曲绘和以上设置保存在这个浏览器里，下次打开网站可以直接打开" onClick={handleSave} disabled={!audioFile || !analysis || saving || upToDate}>
                        {saving ? '保存中…' : upToDate ? '已保存' : savedId ? '保存修改' : '保存'}
                    </Button>
                    <Button variant="outline" size="md" title={`导出为 ${formatLabel}`} onClick={handleExport} disabled={!generated || isExporting || generated.stats.total === 0}>
                        {convertProgress !== null ? `转换音频 ${Math.round(convertProgress * 100)}%` : isExporting ? `导出中 ${Math.round(exportProgress ?? 0)}%` : '导出 PEZ'}
                    </Button>
                    <Button variant="primary" size="md" onClick={() => { setShowPreview(false); setPlaying(true); }} disabled={!generated || !audioBuffer || generated.stats.total === 0}>
                        开始游玩
                    </Button>
                </div>
            </DialogFooter>
            {playing && generated && audioBuffer && (
                <PlayMode
                    chart={generated.chart}
                    audio={audioBuffer}
                    title={name.trim() || '未命名'}
                    difficulty={difficulty}
                    level={level}
                    cover={coverUrl}
                    latencyMs={parseFloat(latencyInput) || 0}
                    onExit={() => setPlaying(false)}
                />
            )}
        </DialogFrame>
    );
};
