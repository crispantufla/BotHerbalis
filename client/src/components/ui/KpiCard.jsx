import React from 'react';
import { cn } from './cn';

// Card de KPI para dashboards. Sin gradients, sin "background glow":
// la jerarquía la da la tipografía y el ícono tonal en la esquina.
// Si en algún momento se necesita `trend` (↑12%), se agrega aquí, no en
// cada vista que use KPIs.
const TONES = {
    accent:  { bg: 'bg-accent-50 dark:bg-accent-900/30',   fg: 'text-accent-600 dark:text-accent-400' },
    success: { bg: 'bg-success-50 dark:bg-success-900/30', fg: 'text-success-600 dark:text-success-500' },
    warning: { bg: 'bg-warning-50 dark:bg-warning-900/30', fg: 'text-warning-600 dark:text-warning-500' },
    danger:  { bg: 'bg-danger-50 dark:bg-danger-900/30',   fg: 'text-danger-600 dark:text-danger-500' },
    info:    { bg: 'bg-info-50 dark:bg-info-900/30',       fg: 'text-info-600 dark:text-info-500' },
    neutral: { bg: 'bg-slate-100 dark:bg-slate-800',       fg: 'text-slate-600 dark:text-slate-300' },
};

export default function KpiCard({ label, value, subtext, icon: Icon, tone = 'accent', loading = false, className }) {
    if (loading) {
        return (
            <div className={cn('rounded-card bg-white dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/70 shadow-card p-4 sm:p-5 animate-pulse', className)}>
                <div className="flex items-center justify-between mb-3">
                    <div className="h-3 w-20 bg-slate-200/70 dark:bg-slate-700/70 rounded" />
                    <div className="h-8 w-8 bg-slate-200/70 dark:bg-slate-700/70 rounded-control" />
                </div>
                <div className="h-7 w-24 bg-slate-200/70 dark:bg-slate-700/70 rounded mb-2" />
                <div className="h-3 w-32 bg-slate-200/70 dark:bg-slate-700/70 rounded" />
            </div>
        );
    }

    const t = TONES[tone];

    return (
        <div className={cn('rounded-card bg-white dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/70 shadow-card p-4 sm:p-5 transition-shadow hover:shadow-card-hover', className)}>
            <div className="flex items-start justify-between gap-3 mb-3">
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">{label}</p>
                {Icon && (
                    <div className={cn('w-9 h-9 rounded-control flex items-center justify-center flex-shrink-0', t.bg, t.fg)}>
                        <Icon className="w-4 h-4" aria-hidden="true" />
                    </div>
                )}
            </div>
            <div className="text-2xl sm:text-3xl font-semibold tabular-nums text-slate-900 dark:text-white tracking-tight leading-none">
                {value}
            </div>
            {subtext && (
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 font-normal leading-snug">
                    {subtext}
                </p>
            )}
        </div>
    );
}
