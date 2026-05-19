import React from 'react';
import { cn } from './cn';

// Badge tonal. Para estados de orden y "pills" descriptivos.
// `tone='neutral'` por default — el resto se elige por intención
// (success = entregado, warning = pendiente, danger = cancelado, etc).
const TONES = {
    neutral: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700',
    accent:  'bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300 border-accent-100 dark:border-accent-900/50',
    success: 'bg-success-50 dark:bg-success-900/30 text-success-700 dark:text-success-500 border-success-100 dark:border-success-900/50',
    warning: 'bg-warning-50 dark:bg-warning-900/20 text-warning-700 dark:text-warning-500 border-warning-100 dark:border-warning-900/50',
    danger:  'bg-danger-50 dark:bg-danger-900/20 text-danger-700 dark:text-danger-500 border-danger-100 dark:border-danger-900/50',
    info:    'bg-info-50 dark:bg-info-900/30 text-info-700 dark:text-info-500 border-info-100 dark:border-info-900/50',
    // `purple` no es tan común — lo agregamos porque en SalesView hay 6 estados
    // de orden y 5 tonos no alcanzan a distinguirlos bien.
    purple:  'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border-purple-100 dark:border-purple-900/50',
};

const SIZES = {
    sm: 'text-[10px] px-1.5 py-0.5',
    md: 'text-xs px-2 py-0.5',
    lg: 'text-sm px-2.5 py-1',
};

export default function Badge({ tone = 'neutral', size = 'md', dot = false, className, children }) {
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
                TONES[tone],
                SIZES[size],
                className
            )}
        >
            {dot && (
                <span
                    className={cn(
                        'w-1.5 h-1.5 rounded-full',
                        {
                            neutral: 'bg-slate-400',
                            accent:  'bg-accent-500',
                            success: 'bg-success-500',
                            warning: 'bg-warning-500',
                            danger:  'bg-danger-500',
                            info:    'bg-info-500',
                            purple:  'bg-purple-500',
                        }[tone]
                    )}
                />
            )}
            {children}
        </span>
    );
}
