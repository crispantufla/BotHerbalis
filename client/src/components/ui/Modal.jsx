import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from './cn';
import IconButton from './IconButton';

// Modal con backdrop, ESC para cerrar, click fuera para cerrar (opcional).
// El cliente decide el contenido vía `Modal.Body` / `Modal.Footer`.
// Props:
//   open: bool
//   onClose: () => void
//   size: 'sm' | 'md' | 'lg' | 'fullscreen-mobile'
//   title, subtitle, statusSlot (opcional, va en header)
//   closeOnBackdrop: bool (default true)
const SIZES = {
    sm:                 'max-w-sm',
    md:                 'max-w-md',
    lg:                 'max-w-xl',
    'fullscreen-mobile':'max-w-xl sm:rounded-card rounded-none w-full h-full sm:h-auto sm:max-h-[90vh]',
};

export default function Modal({
    open,
    onClose,
    title,
    subtitle,
    statusSlot,
    size = 'md',
    closeOnBackdrop = true,
    children,
}) {
    useEffect(() => {
        if (!open) return;
        const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
        document.addEventListener('keydown', onKey);
        // bloqueamos scroll del body mientras está abierto
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [open, onClose]);

    if (!open) return null;

    const isFullscreenMobile = size === 'fullscreen-mobile';
    const sizeClasses = SIZES[size] || SIZES.md;
    const radiusClass = isFullscreenMobile ? '' : 'rounded-card';

    return createPortal(
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center animate-fade-in bg-slate-900/40 backdrop-blur-sm p-0 sm:p-4"
            onClick={closeOnBackdrop ? onClose : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? 'modal-title' : undefined}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className={cn(
                    'w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700',
                    'shadow-elevated flex flex-col overflow-hidden',
                    radiusClass,
                    sizeClasses,
                )}
            >
                {(title || statusSlot) && (
                    <div className="px-5 py-3.5 flex items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex-shrink-0">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                            {title && (
                                <div className="min-w-0">
                                    <h2 id="modal-title" className="font-semibold text-slate-900 dark:text-slate-100 text-sm leading-tight truncate">
                                        {title}
                                    </h2>
                                    {subtitle && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">{subtitle}</p>}
                                </div>
                            )}
                            {statusSlot}
                        </div>
                        <IconButton label="Cerrar" icon={X} variant="ghost" size="sm" onClick={onClose} />
                    </div>
                )}
                {children}
            </div>
        </div>,
        document.body
    );
}

Modal.Body = function ModalBody({ className, children, padded = true }) {
    return (
        <div className={cn('overflow-y-auto custom-scrollbar flex-1', padded && 'p-5', className)}>
            {children}
        </div>
    );
};

Modal.Footer = function ModalFooter({ className, children }) {
    return (
        <div className={cn(
            'px-5 py-3 flex justify-end gap-2 flex-shrink-0',
            'border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50',
            className
        )}>
            {children}
        </div>
    );
};
