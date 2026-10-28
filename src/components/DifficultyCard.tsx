import React from 'react';
import { getDifficultyColor } from '../utils/difficulty';

interface DifficultyCardProps {
    difficulty: string;
    level: string;
    selected?: boolean;
    onClick?: () => void;
}

/** Difficulty and level, styled like the song page's difficulty selector. */
export const DifficultyCard: React.FC<DifficultyCardProps> = ({ difficulty, level, selected = true, onClick }) => {
    const className = 'px-4 py-3.5 rounded-[10px] border backdrop-blur-sm flex items-baseline justify-between gap-3 transition-colors';
    const style = {
        borderColor: selected ? '#ffffff' : 'rgba(255,255,255,0.08)',
        background: selected ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.015)',
    };
    const content = (
        <>
            <span className="font-bold text-[15px] tracking-[.08em]" style={{ color: getDifficultyColor(difficulty) }}>{difficulty}</span>
            <span className={`text-[26px] font-semibold leading-none ${selected ? 'text-white' : 'text-slate-500'}`}>{level}</span>
        </>
    );
    if (!onClick) return <div className={className} style={style}>{content}</div>;
    return (
        <button type="button" role="radio" aria-checked={selected} onClick={onClick} className={`${className} hover:bg-white/[.04]`} style={style}>
            {content}
        </button>
    );
};
