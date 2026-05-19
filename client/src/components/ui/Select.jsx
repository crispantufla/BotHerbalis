import React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';

const SIZES = {
    sm: 'h-8 text-xs pl-3 pr-8',
    md: 'h-10 text-sm pl-3 pr-9',
    lg: 'h-12 text-base pl-4 pr-10',
};

const Select = React.forwardRef(function Select(
    {
        size = 'md',
        leftIcon: LeftIcon,
        label,
        id,
        invalid = false,
        helperText,
        className,
        children,
        ...rest
    },
    ref
) {
    const autoId = React.useId();
    const selectId = id || autoId;

    const iconPadLeft = LeftIcon ? (size === 'sm' ? '!pl-8' : '!pl-10') : '';

    return (
        <div className="w-full">
            {label && (
                <label htmlFor={selectId} className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {label}
                </label>
            )}
            <div className="relative">
                {LeftIcon && (
                    <span className={cn(
                        'absolute inset-y-0 left-0 flex items-center justify-center text-slate-400 dark:text-slate-500 pointer-events-none',
                        size === 'sm' ? 'w-8 [&_svg]:w-3.5 [&_svg]:h-3.5' : 'w-10 [&_svg]:w-4 [&_svg]:h-4'
                    )}>
                        <LeftIcon aria-hidden="true" />
                    </span>
                )}
                <select
                    ref={ref}
                    id={selectId}
                    aria-invalid={invalid || undefined}
                    className={cn(
                        'w-full appearance-none rounded-control bg-white dark:bg-slate-900/40',
                        'border border-slate-200 dark:border-slate-700',
                        'text-slate-900 dark:text-slate-100 font-medium',
                        'transition-colors duration-150',
                        'focus:outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20',
                        'disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
                        SIZES[size],
                        iconPadLeft,
                        invalid && '!border-danger-500',
                        className
                    )}
                    {...rest}
                >
                    {children}
                </select>
                <ChevronDown
                    aria-hidden="true"
                    className={cn(
                        'absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none',
                        size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'
                    )}
                />
            </div>
            {helperText && (
                <p className={cn('mt-1.5 text-xs', invalid ? 'text-danger-600 dark:text-danger-500' : 'text-slate-500 dark:text-slate-400')}>
                    {helperText}
                </p>
            )}
        </div>
    );
});

export default Select;
