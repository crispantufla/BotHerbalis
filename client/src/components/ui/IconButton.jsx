import React from 'react';
import { cn } from './cn';

// Botón cuadrado solo-icono. `label` es REQUERIDO (a11y) — se usa como
// aria-label y como tooltip nativo (`title`).
const VARIANTS = {
    ghost:
        'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100',
    subtle:
        'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700',
    accent:
        'bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400 hover:bg-accent-100 dark:hover:bg-accent-900/50 border border-accent-100 dark:border-accent-900/50',
    danger:
        'text-slate-400 dark:text-slate-500 hover:bg-danger-50 dark:hover:bg-danger-900/30 hover:text-danger-600 dark:hover:text-danger-400',
};

const SIZES = {
    sm: 'w-8 h-8 [&_svg]:w-4 [&_svg]:h-4',
    md: 'w-10 h-10 [&_svg]:w-5 [&_svg]:h-5',
};

const IconButton = React.forwardRef(function IconButton(
    {
        label,
        icon: Icon,
        variant = 'ghost',
        size = 'md',
        disabled = false,
        className,
        children,
        ...rest
    },
    ref
) {
    if (!label && import.meta.env?.DEV) {
        // eslint-disable-next-line no-console
        console.warn('[IconButton] missing required `label` prop (a11y)');
    }

    return (
        <button
            ref={ref}
            type="button"
            disabled={disabled}
            aria-label={label}
            title={label}
            className={cn(
                'inline-flex items-center justify-center rounded-control',
                'transition-colors duration-150',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                SIZES[size],
                VARIANTS[variant],
                className
            )}
            {...rest}
        >
            {Icon ? <Icon aria-hidden="true" /> : children}
        </button>
    );
});

export default IconButton;
