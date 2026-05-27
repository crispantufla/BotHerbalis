import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, CreditCard, Loader2 } from 'lucide-react';
import api from '../../../config/axios';
import { useToast } from '../../ui/Toast';

/**
 * ManualMpLinkModal — Pide un monto al vendedor, genera un link MP real y lo
 * inserta en el textarea via onLinkReady(link). El template del step viene en
 * `template` y se renderiza como preview con {{LINK}} sustituido.
 *
 * Props:
 *   isOpen, onClose
 *   template: string — texto del step (payment_mp_link.response) con {{LINK}}
 *   formatTemplate(text, { link }) → string — usa formatScriptMessage del parent
 *   suggestedAmount: string|number — monto pre-cargado del state (total del carrito)
 *   onLinkReady(finalMessage) — llamado tras generar el link, con el mensaje final
 */
const ManualMpLinkModal = ({ isOpen, onClose, template = '', formatTemplate, suggestedAmount = '', onLinkReady }) => {
    const { toast } = useToast();
    const [amount, setAmount] = useState('');
    const [loading, setLoading] = useState(false);
    const [generatedLink, setGeneratedLink] = useState(null);

    useEffect(() => {
        if (isOpen) {
            const suggested = String(suggestedAmount || '').replace(/[^\d.]/g, '');
            setAmount(suggested);
            setGeneratedLink(null);
        }
    }, [isOpen, suggestedAmount]);

    if (!isOpen) return null;

    const parsedAmount = parseFloat((amount || '').replace(/\./g, '').replace(',', '.'));
    const isValid = !isNaN(parsedAmount) && parsedAmount > 0;

    const handleGenerate = async () => {
        if (!isValid) {
            toast.error('Ingresá un monto válido en pesos.');
            return;
        }
        setLoading(true);
        try {
            const res = await api.post('/api/payments/manual-link', { amount: parsedAmount });
            const link = res.data?.link;
            if (!link) throw new Error('La API no devolvió link');
            setGeneratedLink(link);
            const finalMsg = formatTemplate ? formatTemplate(template, { link }) : template.replace(/{{LINK}}/g, link);
            onLinkReady?.(finalMsg);
            toast.success('Link de pago generado ✅');
        } catch (e) {
            toast.error('No se pudo generar el link: ' + (e.response?.data?.error || e.message));
        } finally {
            setLoading(false);
        }
    };

    const previewMessage = formatTemplate
        ? formatTemplate(template, { link: generatedLink || '(se completa al generar)' })
        : template.replace(/{{LINK}}/g, generatedLink || '(se completa al generar)');

    const modalContent = (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
            <div className="relative z-10 w-full max-w-lg bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-sky-50 dark:bg-sky-900/20">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-sky-100 dark:bg-sky-900/40 text-sky-600 flex items-center justify-center">
                            <CreditCard className="w-5 h-5" />
                        </div>
                        <div>
                            <h2 className="text-lg font-extrabold text-slate-800 dark:text-slate-100">Generar link de Mercado Pago</h2>
                            <p className="text-xs text-slate-500 font-medium">Crea una preferencia MP con el monto que indiques</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Body */}
                <div className="p-5 space-y-4 overflow-y-auto custom-scrollbar">
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1.5">Monto en pesos</label>
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-base">$</span>
                            <input
                                type="text"
                                inputMode="decimal"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                placeholder="46900"
                                disabled={loading}
                                autoFocus
                                className="w-full bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl pl-8 pr-3 py-3 text-base focus:outline-none focus:border-sky-400 text-slate-800 dark:text-slate-100 disabled:opacity-50"
                            />
                        </div>
                        <p className="text-[11px] text-slate-400 mt-1">Sin puntos ni comas — solo el número (ej: <span className="font-mono">46900</span>).</p>
                    </div>

                    {/* Live preview */}
                    {template && (
                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1.5">Vista previa del mensaje</label>
                            <pre className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3 text-[11px] text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed max-h-44 overflow-y-auto font-sans">
                                {previewMessage}
                            </pre>
                        </div>
                    )}

                    {generatedLink && (
                        <div className="rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 p-3">
                            <p className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide mb-1">Link generado</p>
                            <a href={generatedLink} target="_blank" rel="noopener noreferrer" className="text-xs text-emerald-700 dark:text-emerald-400 underline break-all">{generatedLink}</a>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex justify-end gap-3">
                    <button onClick={onClose} className="px-5 py-2.5 rounded-xl font-bold text-slate-600 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors">
                        {generatedLink ? 'Cerrar' : 'Cancelar'}
                    </button>
                    {!generatedLink && (
                        <button
                            onClick={handleGenerate}
                            disabled={!isValid || loading}
                            className="px-6 py-2.5 rounded-xl font-bold text-white bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 shadow-md transition-all flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {loading
                                ? <Loader2 className="w-4 h-4 animate-spin" />
                                : <CreditCard className="w-4 h-4" />}
                            {loading ? 'Generando…' : 'Generar e insertar'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );

    return createPortal(modalContent, document.body);
};

export default ManualMpLinkModal;
