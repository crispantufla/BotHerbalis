import React from 'react';
import { cn } from './cn';

// Empty state consistente. Sin emojis ni "blur orbs": ícono tonal limpio
// + título + descripción + (opcional) action button.
export default function EmptyState({ icon: Icon, title, description, action, className }) {
    return (
        <div className={cn('flex flex-col items-center justify-center text-center px-6 py-12', className)}>
            {Icon && (
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 flex items-center justify-center mb-4">
                    <Icon className="w-6 h-6" aria-hidden="true" />
                </div>
            )}
            {title && (
                <p className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">
                    {title}
                </p>
            )}
            {description && (
                <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm leading-relaxed">
                    {description}
                </p>
            )}
            {action && <div className="mt-5">{action}</div>}
        </div>
    );
}
