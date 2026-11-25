import React, { useState, useCallback, useMemo, useId, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { useDialogA11y } from './useDialogA11y';

const ToastContext = createContext();

export const useToast = () => useContext(ToastContext);

/**
 * Toast Types: success, error, warning, info
 */
const ICONS = {
    success: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    error: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    warning: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>,
    info: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
};

// Superficie de vidrio, igual para los cuatro tipos (el color lo pone el ícono).
const SURFACE = 'bg-white/80 dark:bg-slate-800/90 backdrop-blur-xl border-white/60 dark:border-slate-700/70 shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.4)]';
const SURFACE_CONFIRM = 'bg-white/90 dark:bg-slate-800/95 backdrop-blur-xl border-white/60 dark:border-slate-700/70 text-slate-800 dark:text-slate-100 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.5)]';
const TOAST_BOX = 'relative pointer-events-auto animate-fade-in motion-reduce:animate-none overflow-hidden rounded-2xl border p-4 hover:shadow-2xl transition-shadow duration-300';

const ICON_COLORS = {
    success: 'text-success-500 drop-shadow-[0_0_8px_rgba(16,185,129,0.3)] bg-success-100/50 dark:bg-success-900/30 p-1.5 rounded-xl border border-emerald-200/50 dark:border-emerald-800/50',
    error: 'text-danger-500 drop-shadow-[0_0_8px_rgba(244,63,94,0.3)] bg-danger-100/50 dark:bg-danger-900/30 p-1.5 rounded-xl border border-rose-200/50 dark:border-rose-800/50',
    warning: 'text-warning-500 drop-shadow-[0_0_8px_rgba(245,158,11,0.3)] bg-warning-100/50 dark:bg-warning-900/30 p-1.5 rounded-xl border border-amber-200/50 dark:border-amber-800/50',
    info: 'text-accent-600 dark:text-accent-400 drop-shadow-[0_0_8px_rgba(99,102,241,0.3)] bg-accent-100/50 dark:bg-accent-900/30 p-1.5 rounded-xl border border-accent-200/50 dark:border-accent-800/50',
};

// El confirm() es un diálogo de verdad: mientras está abierto atrapa el foco,
// arranca en "Cancelar" (la opción que no rompe nada) y Escape cancela.
function ConfirmToast({ message, onConfirm, onCancel }) {
    const messageId = useId();
    const ref = useDialogA11y({ open: true, onClose: onCancel, lockScroll: false });
    return (
        <div
            ref={ref}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={messageId}
            tabIndex={-1}
            className={`${TOAST_BOX} ${SURFACE_CONFIRM} focus:outline-none`}
        >
            <div className="flex flex-col gap-4">
                <div className="flex items-start gap-3">
                    <span aria-hidden="true" className="flex-shrink-0 text-warning-500 bg-warning-50 dark:bg-warning-900/30 p-1.5 rounded-xl border border-warning-100 dark:border-amber-800/50 shadow-sm mt-0.5">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                    </span>
                    <p id={messageId} className="text-[13px] font-extrabold text-slate-800 dark:text-slate-100 leading-snug mt-1">{message}</p>
                </div>
                <div className="flex gap-2 justify-end mt-1">
                    <button
                        type="button"
                        data-autofocus
                        onClick={onCancel}
                        className="px-4 py-2 max-md:min-h-10 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 rounded-xl text-xs font-bold hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                    >
                        Cancelar
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="px-4 py-2 max-md:min-h-10 bg-gradient-to-r from-danger-600 to-danger-700 text-white rounded-xl text-xs font-extrabold hover:opacity-90 transition-all shadow-md shadow-danger-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800"
                    >
                        Confirmar
                    </button>
                </div>
            </div>
        </div>
    );
}

export const ToastProvider = ({ children }) => {
    const [toasts, setToasts] = useState([]);

    const addToast = useCallback((message, type = 'info', duration = 4000) => {
        const id = Date.now() + Math.random();
        setToasts(prev => [...prev, { id, message, type, duration }]);

        if (duration > 0) {
            setTimeout(() => {
                setToasts(prev => prev.filter(t => t.id !== id));
            }, duration);
        }
        return id;
    }, []);

    const removeToast = useCallback((id) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    // Memoizado: si `toast` se recrea en cada render, todo useCallback que lo
    // tenga como dep se recrea y sus effects se re-disparan (loops de refetch).
    const toast = useMemo(() => ({
        success: (msg, dur) => addToast(msg, 'success', dur),
        error: (msg, dur) => addToast(msg, 'error', dur),
        warning: (msg, dur) => addToast(msg, 'warning', dur),
        info: (msg, dur) => addToast(msg, 'info', dur),
        dismiss: (id) => removeToast(id),
    }), [addToast, removeToast]);

    /**
     * Confirm dialog replacement for window.confirm().
     * Returns a Promise<boolean>.
     */
    const confirm = useCallback((message) => {
        return new Promise(resolve => {
            const id = Date.now() + Math.random();
            setToasts(prev => [...prev, {
                id, message, type: 'confirm', duration: 0,
                onConfirm: () => { setToasts(p => p.filter(t => t.id !== id)); resolve(true); },
                onCancel: () => { setToasts(p => p.filter(t => t.id !== id)); resolve(false); },
            }]);
        });
    }, []);

    // Renderizamos el contenedor de toasts en un portal a document.body en
    // lugar de como hermano de {children}. Antes, cuando una acción disparaba
    // simultáneamente (a) un re-render de la app (lista que cambia, modal que
    // se cierra) y (b) un toast nuevo, el reconciler de React 19 mezclaba el
    // orden de los hermanos y reventaba con "insertBefore on Node: not a
    // child of this node", dejando la pantalla en blanco.
    // Los confirm() van fuera de la región `aria-live`: son diálogos, se anuncian
    // solos al recibir el foco. Los avisos comunes van adentro (los de error como
    // `alert`, que interrumpe; el resto como `status`).
    const confirms = toasts.filter(t => t.type === 'confirm');
    const notices = toasts.filter(t => t.type !== 'confirm');
    const toastContainer = (
        <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-[calc(100vw-2rem)] sm:max-w-sm pointer-events-none">
            {confirms.map(t => (
                <ConfirmToast key={t.id} message={t.message} onConfirm={t.onConfirm} onCancel={t.onCancel} />
            ))}
            <div aria-live="polite" aria-relevant="additions" className="flex flex-col gap-2">
                {notices.map(t => (
                    <div
                        key={t.id}
                        role={t.type === 'error' ? 'alert' : 'status'}
                        className={`${TOAST_BOX} ${SURFACE}`}
                    >
                        <div className="flex items-center gap-3">
                            <span aria-hidden="true" className={`flex-shrink-0 shadow-sm ${ICON_COLORS[t.type]}`}>{ICONS[t.type]()}</span>
                            <p className="text-[13px] font-extrabold flex-1 leading-snug text-slate-700 dark:text-slate-200 tracking-wide pr-2">{t.message}</p>
                            <button
                                type="button"
                                aria-label="Cerrar"
                                onClick={() => removeToast(t.id)}
                                className="inline-flex items-center justify-center text-slate-500 dark:text-slate-400 opacity-70 hover:opacity-100 hover:text-danger-500 hover:bg-danger-50 dark:hover:bg-danger-900/30 p-1.5 rounded-lg transition-all flex-shrink-0 max-md:min-w-10 max-md:min-h-10 max-md:-my-1.5 max-md:-mr-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:opacity-100"
                            >
                                <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );

    const contextValue = useMemo(() => ({ toast, confirm }), [toast, confirm]);

    return (
        <ToastContext.Provider value={contextValue}>
            {children}
            {typeof document !== 'undefined' ? createPortal(toastContainer, document.body) : null}
        </ToastContext.Provider>
    );
};
