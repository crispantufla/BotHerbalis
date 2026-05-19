import React from 'react';
import { cn } from './cn';

// Input estándar con leftIcon/rightSlot opcionales.
// `invalid` activa el ring rojo; el mensaje de error se renderiza vía
// helperText cuando invalid=true. Mantenemos esto separado de los formularios
// complejos — para forms con muchos campos podríamos meter react-hook-form,
// pero hoy las vistas tienen formularios chicos (1-3 inputs) que no lo justifican.
const SIZES = {
    sm: 'h-8 text-xs',
    md: 'h-10 text-sm',
    lg: 'h-12 text-base',
};

const Input = React.forwardRef(function Input(
    {
        size = 'md',
        leftIcon: LeftIcon,
        rightSlot,
        invalid = false,
        helperText,
        label,
        id,
        className,
        ...rest
    },
    ref
) {
    const autoId = React.useId();
    const inputId = id || autoId;
    const helperId = helperText ? `${inputId}-helper` : undefined;

    const iconPadLeft = LeftIcon ? (size === 'sm' ? 'pl-8' : 'pl-10') : 'pl-3';
    const slotPadRight = rightSlot ? (size === 'sm' ? 'pr-9' : 'pr-11') : 'pr-3';

    return (
        <div className="w-full">
            {label && (
                <label htmlFor={inputId} className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
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
                <input
                    ref={ref}
                    id={inputId}
                    aria-invalid={invalid || undefined}
                    aria-describedby={helperId}
                    className={cn(
                        'w-full rounded-control bg-white dark:bg-slate-900/40',
                        'border border-slate-200 dark:border-slate-700',
                        'text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500',
                        'transition-colors duration-150',
                        'focus:outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        SIZES[size],
                        iconPadLeft,
                        slotPadRight,
                        invalid && '!border-danger-500 focus:!border-danger-500 focus:!ring-danger-500/20',
                        className
                    )}
                    {...rest}
                />
                {rightSlot && (
                    <span className={cn('absolute inset-y-0 right-0 flex items-center pr-2', size === 'sm' ? 'pr-1.5' : 'pr-2')}>
                        {rightSlot}
                    </span>
                )}
            </div>
            {helperText && (
                <p id={helperId} className={cn('mt-1.5 text-xs', invalid ? 'text-danger-600 dark:text-danger-500' : 'text-slate-500 dark:text-slate-400')}>
                    {helperText}
                </p>
            )}
        </div>
    );
});

export default Input;
