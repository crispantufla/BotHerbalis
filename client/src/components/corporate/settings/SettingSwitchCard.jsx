import React from 'react';
import { Card, cn } from '../../ui';

// Tarjeta de un ajuste on/off de Configuración: ícono, título, explicación
// (children) y el switch. `setting` es lo que devuelve useSettingSwitch.
export default function SettingSwitchCard({ className, icon: Icon, iconClassName, title, onLabel, offLabel, hint, setting, children }) {
    return (
        <Card padding="md" className={className}>
            <div className="flex items-start gap-3 min-w-0 mb-3">
                <div className={cn('w-10 h-10 rounded-control', iconClassName, 'flex items-center justify-center flex-shrink-0')}>
                    <Icon className="w-5 h-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                    <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-sm mb-1">
                        {title}
                    </h3>
                    <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                        {children}
                    </p>
                </div>
            </div>
            <div className="mt-auto flex items-center justify-between gap-3 pt-3 border-t border-slate-200/70 dark:border-slate-700/70">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    {setting.value ? onLabel : offLabel}
                    <span className="text-[11px] text-slate-400 dark:text-slate-500 font-normal ml-1.5">
                        {hint}
                    </span>
                </span>
                <button
                    type="button"
                    role="switch"
                    aria-checked={setting.value}
                    aria-label={title}
                    onClick={setting.toggle}
                    disabled={setting.toggling}
                    className={cn(
                        'relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        setting.value ? 'bg-accent-500' : 'bg-slate-300 dark:bg-slate-600'
                    )}
                >
                    <span className={cn(
                        'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform mt-0.5',
                        setting.value ? 'translate-x-[22px]' : 'translate-x-0.5'
                    )} />
                </button>
            </div>
        </Card>
    );
}
