import React, { useState, useCallback, createContext, useContext } from 'react';

const ToastContext = createContext();

export const useToast = () => useContext(ToastContext);

/**
 * Toast Types: success, error, warning, info
 */
const ICONS = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
};

const STYLES = {
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    error: 'bg-rose-50 border-rose-200 text-rose-800',
    warning: 'bg-amber-50 border-amber-200 text-amber-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800',
};

const PROGRESS_STYLES = {
    success: 'bg-emerald-400',
    error: 'bg-rose-400',
    warning: 'bg-amber-400',
    info: 'bg-blue-400',
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
                            pointer-events-auto animate-fade-in
                            rounded-lg border shadow-lg p-4
                            ${t.type === 'confirm' ? 'bg-white border-slate-200 text-slate-800' : STYLES[t.type]}
                        `}
                    >
                        {t.type === 'confirm' ? (
                            // Confirm Dialog
                            <div>
                                <div className="flex items-start gap-3 mb-3">
                                    <span className="text-lg">⚠️</span>
                                    <p className="text-sm font-medium">{t.message}</p>
                                </div>
                                <div className="flex gap-2 justify-end">
                                    <button
                                        onClick={t.onCancel}
                                        className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded text-xs font-bold hover:bg-slate-200 transition"
                                    >
                                        Cancelar
                                    </button>
                                    <button
                                        onClick={t.onConfirm}
                                        className="px-3 py-1.5 bg-rose-600 text-white rounded text-xs font-bold hover:bg-rose-700 transition"
                                    >
                                        Confirmar
                                    </button>
                                </div>
                            </div>
                        ) : (
                            // Regular Toast
                            <div className="flex items-start gap-3 relative overflow-hidden">
                                <span className="text-lg flex-shrink-0">{ICONS[t.type]}</span>
                                <p className="text-sm font-medium flex-1">{t.message}</p>
                                <button
                                    onClick={() => removeToast(t.id)}
                                    className="text-current opacity-50 hover:opacity-100 text-xs flex-shrink-0 ml-2"
                                >
                                    ✕
                                </button>
                                {/* Progress bar */}
                                {t.duration > 0 && (
                                    <div className="absolute bottom-0 left-0 right-0 h-0.5">
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
