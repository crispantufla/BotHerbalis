import React from 'react';
import { cn } from './cn';

// Card consistente. `padding` controla el padding interno; cuando se usan
// Card.Header / Card.Body / Card.Footer NO le pasen `padding` al `<Card>` —
// cada sección maneja su propio espaciado.
export function Card({ as: Tag = 'div', padding = 'md', interactive = false, className, children, ...rest }) {
    const pad = {
        none: '',
        sm: 'p-3',
        md: 'p-4 sm:p-5',
        lg: 'p-5 sm:p-6',
    }[padding];

    return (
        <Tag
            className={cn(
                'rounded-card bg-white dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/70',
                'shadow-card',
                interactive && 'transition-shadow duration-200 hover:shadow-card-hover',
                pad,
                className
            )}
            {...rest}
        >
            {children}
        </Tag>
    );
}

Card.Header = function CardHeader({ title, subtitle, action, className, children }) {
    if (children) {
        return (
            <div className={cn('px-4 sm:px-5 py-4 border-b border-slate-200/70 dark:border-slate-700/70', className)}>
                {children}
            </div>
        );
    }
    return (
        <div className={cn('px-4 sm:px-5 py-4 border-b border-slate-200/70 dark:border-slate-700/70 flex items-start justify-between gap-3', className)}>
            <div className="min-w-0">
                {title && <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-sm leading-tight">{title}</h3>}
                {subtitle && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>}
            </div>
            {action && <div className="flex-shrink-0">{action}</div>}
        </div>
    );
};

Card.Body = function CardBody({ className, children }) {
    return <div className={cn('p-4 sm:p-5', className)}>{children}</div>;
};

Card.Footer = function CardFooter({ className, children }) {
    return (
        <div className={cn('px-4 sm:px-5 py-3 border-t border-slate-200/70 dark:border-slate-700/70 bg-slate-50/50 dark:bg-slate-800/30 rounded-b-card', className)}>
            {children}
        </div>
    );
};

export default Card;
