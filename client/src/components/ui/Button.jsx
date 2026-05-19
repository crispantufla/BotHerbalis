import React from 'react';
import { cn } from './cn';

// Variantes:
//   primary  — acción positiva principal (acento). Color flat, no gradient.
//   secondary— acción secundaria, contorno sutil sobre fondo neutro.
//   ghost    — acción terciaria, sin borde — para barras de toolbar.
//   danger   — acción destructiva, color flat rojo.
//   subtle   — acción tonal (bg tinted, sin sombra) — útil cuando hay muchos
//              botones secundarios juntos y `secondary` es demasiado pesado.
//
// Tamaños: sm (h-8), md (h-10, default), lg (h-12).
//
// Props:
//   loading  — muestra spinner y desactiva. Setea aria-busy.
//   leftIcon / rightIcon — lucide-react o cualquier ReactNode.
//   fullWidth — w-full para mobile / formularios.
const VARIANTS = {
    primary:
        'bg-accent-600 text-white hover:bg-accent-700 active:bg-accent-800 disabled:bg-accent-300 dark:disabled:bg-accent-900/40 shadow-sm',
    secondary:
        'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/50 active:bg-slate-100 dark:active:bg-slate-700 disabled:opacity-50',
    ghost:
        'bg-transparent text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 active:bg-slate-200 dark:active:bg-slate-700 disabled:opacity-50',
    danger:
        'bg-danger-600 text-white hover:bg-danger-700 active:bg-danger-700 disabled:bg-danger-300 dark:disabled:bg-danger-900/40 shadow-sm',
    subtle:
        'bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300 border border-accent-100 dark:border-accent-900/50 hover:bg-accent-100 dark:hover:bg-accent-900/50 disabled:opacity-50',
};

const SIZES = {
    sm: 'h-8 px-3 text-xs gap-1.5',
    md: 'h-10 px-4 text-sm gap-2',
    lg: 'h-12 px-5 text-base gap-2',
};

const ICON_SIZE = { sm: 'w-3.5 h-3.5', md: 'w-4 h-4', lg: 'w-5 h-5' };

const Button = React.forwardRef(function Button(
    {
        variant = 'primary',
        size = 'md',
        loading = false,
        disabled = false,
        leftIcon: LeftIcon,
        rightIcon: RightIcon,
        fullWidth = false,
        className,
        children,
        type = 'button',
        ...rest
    },
    ref
) {
    const isDisabled = disabled || loading;
    const iconSize = ICON_SIZE[size];

    return (
        <button
            ref={ref}
            type={type}
            disabled={isDisabled}
            aria-busy={loading || undefined}
            className={cn(
                'inline-flex items-center justify-center rounded-control font-semibold',
                'transition-colors duration-150',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
                'disabled:cursor-not-allowed',
                SIZES[size],
                VARIANTS[variant],
                fullWidth && 'w-full',
                className
            )}
            {...rest}
        >
            {loading ? (
                <svg
                    className={cn('animate-spin', iconSize)}
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                >
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
                    <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                </svg>
            ) : (
                LeftIcon && <LeftIcon className={iconSize} aria-hidden="true" />
            )}
            {children}
            {!loading && RightIcon && <RightIcon className={iconSize} aria-hidden="true" />}
        </button>
    );
});

export default Button;
