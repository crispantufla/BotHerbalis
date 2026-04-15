import React, { useState, useEffect, useRef } from 'react';
import { X, CreditCard, Loader2, Check, Copy } from 'lucide-react';
import api from '../../../config/axios';
import toast from 'react-hot-toast';

const MpLinkPanel = ({ chatId, onClose }) => {
    const [amount, setAmount] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');
    const panelRef = useRef(null);
    const amountRef = useRef(null);

    useEffect(() => { amountRef.current?.focus(); }, []);

    useEffect(() => {
        const handler = (e) => {
            if (panelRef.current && !panelRef.current.contains(e.target)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        const amt = parseFloat(amount.replace(/\./g, '').replace(',', '.'));
        if (!amt || amt <= 0) { setError('Monto inválido'); return; }
        if (!chatId) { setError('Seleccioná un chat primero'); return; }

        setLoading(true);
        setError('');
        try {
            const phone = chatId.split('@')[0].replace(/\D/g, '');
            const res = await api.post('/api/mp-link', {
                amount: amt,
                userPhone: phone,
                sendToChat: true,
            });
            if (res.data.sent) {
                setResult(res.data);
                toast.success('Link enviado al cliente');
            } else {
                setResult(res.data);
                setError(res.data.sendError || 'El link se creó pero no se pudo enviar');
            }
        } catch (e) {
            setError(e.response?.data?.error || 'Error generando el link');
        } finally {
            setLoading(false);
        }
    };

    const handleCopy = () => {
        if (!result?.link) return;
        navigator.clipboard.writeText(result.link);
        toast.success('Link copiado');
    };

    return (
        <div
            ref={panelRef}
            className="absolute bottom-full left-4 sm:left-6 mb-2 z-50 w-80 sm:w-96 shadow-2xl rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 animate-fade-in origin-bottom-left"
        >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-700">
                <div className="flex items-center gap-2">
                    <CreditCard className="w-4 h-4 text-emerald-500" />
                    <span className="font-semibold text-sm text-slate-700 dark:text-slate-200">Enviar link de MercadoPago</span>
                </div>
                <button
                    onClick={onClose}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {error && (
                <div className="mx-3 mt-3 px-3 py-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/30 rounded-lg">
                    {error}
                </div>
            )}

            {!result?.sent ? (
                <form onSubmit={handleSubmit} className="px-4 py-4 space-y-3">
                    <label className="block">
                        <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1 block">Monto (ARS)</span>
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                            <input
                                ref={amountRef}
                                type="text"
                                inputMode="decimal"
                                placeholder="46.900"
                                value={amount}
                                onChange={e => setAmount(e.target.value)}
                                className="w-full pl-7 pr-3 py-2.5 text-sm rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 placeholder:text-slate-400"
                            />
                        </div>
                    </label>

                    <button
                        type="submit"
                        disabled={loading || !amount.trim()}
                        className="w-full py-2.5 text-sm font-semibold rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white transition-colors flex items-center justify-center gap-2"
                    >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                        {loading ? 'Generando y enviando...' : 'Generar y enviar al cliente'}
                    </button>

                    <p className="text-[11px] text-slate-400 dark:text-slate-500 text-center">
                        El link se envía automáticamente al chat actual.
                    </p>
                </form>
            ) : (
                <div className="px-4 py-4 space-y-3">
                    <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-sm font-semibold">
                        <Check className="w-4 h-4" />
                        Link enviado al cliente
                    </div>
                    <div className="p-2 bg-slate-50 dark:bg-slate-700/50 rounded-lg text-xs text-slate-600 dark:text-slate-300 break-all">
                        {result.link}
                    </div>
                    <button
                        onClick={handleCopy}
                        className="w-full py-2 text-xs font-semibold rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 transition-colors flex items-center justify-center gap-2"
                    >
                        <Copy className="w-3.5 h-3.5" /> Copiar link
                    </button>
                </div>
            )}
        </div>
    );
};

export default MpLinkPanel;
