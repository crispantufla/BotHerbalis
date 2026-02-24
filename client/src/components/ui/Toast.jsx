import React, { useState, useCallback, createContext, useContext } from 'react';

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

const STYLES = {
    success: 'bg-white/80 backdrop-blur-xl border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.08)]',
    error: 'bg-white/80 backdrop-blur-xl border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.08)]',
    warning: 'bg-white/80 backdrop-blur-xl border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.08)]',
    info: 'bg-white/80 backdrop-blur-xl border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.08)]',
};

const ICON_COLORS = {
    success: 'text-emerald-500 drop-shadow-[0_0_8px_rgba(16,185,129,0.3)] bg-emerald-100/50 p-1.5 rounded-xl border border-emerald-200/50',
    error: 'text-rose-500 drop-shadow-[0_0_8px_rgba(244,63,94,0.3)] bg-rose-100/50 p-1.5 rounded-xl border border-rose-200/50',
    warning: 'text-amber-500 drop-shadow-[0_0_8px_rgba(245,158,11,0.3)] bg-amber-100/50 p-1.5 rounded-xl border border-amber-200/50',
    info: 'text-indigo-600 drop-shadow-[0_0_8px_rgba(99,102,241,0.3)] bg-indigo-100/50 p-1.5 rounded-xl border border-indigo-200/50',
};

const PROGRESS_STYLES = {
    success: 'bg-gradient-to-r from-emerald-400 to-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]',
    error: 'bg-gradient-to-r from-rose-400 to-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]',
    warning: 'bg-gradient-to-r from-amber-400 to-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)]',
    info: 'bg-gradient-to-r from-indigo-500 to-purple-500 shadow-[0_0_10px_rgba(99,102,241,0.5)]',
};

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

    const toast = {
        success: (msg, dur) => addToast(msg, 'success', dur),
        error: (msg, dur) => addToast(msg, 'error', dur),
        warning: (msg, dur) => addToast(msg, 'warning', dur),
        info: (msg, dur) => addToast(msg, 'info', dur),
    };

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

    return (
        <ToastContext.Provider value={{ toast, confirm }}>
            {children}

            {/* Toast Container */}
            <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm pointer-events-none">
                {toasts.map(t => (
                    <div
                        key={t.id}
                        className={`
                            relative pointer-events-auto animate-fade-in overflow-hidden
                            rounded-2xl border p-4 hover:shadow-2xl transition-shadow duration-300
                            ${t.type === 'confirm' ? 'bg-white/90 backdrop-blur-xl border-white/60 text-slate-800 shadow-[0_8px_30px_rgb(0,0,0,0.12)]' : STYLES[t.type]}
                        `}
                    >
                        {t.type === 'confirm' ? (
                            // Confirm Dialog
                            <div className="flex flex-col gap-4">
                                <div className="flex items-start gap-3">
                                    <span className="flex-shrink-0 text-amber-500 bg-amber-50 p-1.5 rounded-xl border border-amber-100 shadow-sm mt-0.5">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                                    </span>
                                    <p className="text-[13px] font-extrabold text-slate-800 leading-snug mt-1">{t.message}</p>
                                </div>
                                <div className="flex gap-2 justify-end mt-1">
                                    <button
                                        onClick={t.onCancel}
                                        className="px-4 py-2 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-200 transition-colors shadow-sm"
                                    >
                                        Cancelar
                                    </button>
                                    <button
                                        onClick={t.onConfirm}
                                        className="px-4 py-2 bg-gradient-to-r from-rose-500 to-rose-600 text-white rounded-xl text-xs font-extrabold hover:opacity-90 transition-all shadow-md shadow-rose-500/30"
                                    >
                                        Confirmar
                                    </button>
                                </div>
                            </div>
                        ) : (
                            // Regular Toast
                            <div className="flex items-center gap-3">
                                <span className={`flex-shrink-0 shadow-sm ${ICON_COLORS[t.type]}`}>{ICONS[t.type]()}</span>
                                <p className="text-[13px] font-extrabold flex-1 leading-snug text-slate-700 tracking-wide pr-2">{t.message}</p>
                                <button
                                    onClick={() => removeToast(t.id)}
                                    className="text-slate-400 opacity-50 hover:opacity-100 hover:text-rose-500 hover:bg-rose-50 p-1.5 rounded-lg transition-all flex-shrink-0"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                                {/* Progress bar */}
                                {t.duration > 0 && (
                                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-slate-100/50">
                                        <div
                                            className={`h-full ${PROGRESS_STYLES[t.type]}`}
                                            style={{
                                                animation: `shrink ${t.duration}ms linear forwards`,
                                            }}
                                        />
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {/* Progress bar animation */}
            <style>{`
                @keyframes shrink {
                    from { width: 100%; }
                    to { width: 0%; }
                }
            `}</style>
        </ToastContext.Provider>
    );
};
