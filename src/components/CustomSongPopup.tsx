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
import {
    AudioAnalysis,
    GENERATOR_DIFFICULTIES,
    GeneratorDifficulty,
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

    useEffect(() => {
        if (!coverFile) {
            setCoverUrl(null);
            return;
        }
        const url = URL.createObjectURL(coverFile);
        setCoverUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [coverFile]);

    const handleAudio = async (file: File | undefined) => {
        if (!file) return;
        setShowPreview(false);
        setError(null);
        setAudioFile(file);
        setAnalysis(null);
        setAudioBuffer(null);
        if (!name) setName(file.name.replace(/\.[^.]+$/, ''));
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
            setBpmInput(String(result.bpm));
            setOffsetInput('0');
        } catch (e) {
            console.error(e);
            setAudioFile(null);
            setError('无法解码该音频文件，请换用 OGG / MP3 / WAV / FLAC 格式。');
        } finally {
            setIsAnalyzing(false);
        }
    };

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
        })])) as Record<GeneratorDifficulty, ReturnType<typeof generateChart>>;
    }, [analysis, bpmValid, bpm, offsetMs, name, audioFile, lineMotion]);
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
                                ? `时长 ${Math.floor(analysis.duration / 60)}:${String(Math.floor(analysis.duration % 60)).padStart(2, '0')} · 检测到 BPM ${analysis.bpm}`
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
                        </div>
                        <Button variant="outline" onClick={() => setShowPreview(v => !v)}>{showPreview ? '收起预览' : '预览谱面'}</Button>
                    </div>
                )}

                {analysis && (
                    <div className="flex flex-col gap-2">
                        <label className="flex items-center gap-2 text-[13px] text-slate-300">
                            <input type="checkbox" checked={lineMotion} onChange={e => setLineMotion(e.target.checked)} className="accent-[#22d3ee]" />
                            判定线随歌曲情绪运动
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
                            </>
                        )}
                    </div>
                )}

                {showPreview && generated && audioBuffer && (
                    <ChartPreview chart={generated.chart} audio={audioBuffer} cover={coverUrl} />
                )}

                <p className="text-[12px] leading-[1.6] text-slate-500 text-pretty">
                    音符放在哪里，由一个从 240 首官方谱面（曲库的 73%）里学到的模型决定，模仿谱师的取舍；左右位置跟随音高（低音在左、高音在右），音符之间不会重叠。最强的重音是红色 Flick，轻打和快速连音是黄色 Drag，
                    持续的长音是 Hold，其余是蓝色 Tap。判定线按每小节的情绪运动：平缓处呼吸、律动处摇摆、铺垫时蓄力倾斜、爆发时回正下砸，
                    高潮的动法由歌曲本身的明亮度、密度和旋律起伏混合而成。物量和各种键的比例参照官方同难度谱面的中位数；定数由官方 516 张谱面拟合的公式自动评出（平均误差约 ±1）。
                    如果试听时打击音和节拍对不上，请修改 BPM 或偏移（正数让音符更晚出现）。导出格式与原程序一致，遵循设置里的「ZIP 格式」和「谱面格式转换」选项。
                </p>

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
