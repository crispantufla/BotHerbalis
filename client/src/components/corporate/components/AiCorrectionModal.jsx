import React, { useState, useEffect } from 'react';
import { AlertTriangle, Send, X } from 'lucide-react';
import { useToast } from '../../ui/Toast';
import api from '../../../config/axios';

const AiCorrectionModal = ({ isOpen, onClose, messages = [], reportedMsgId, selectedChat }) => {
    const { toast } = useToast();
    const [correctionText, setCorrectionText] = useState('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!isOpen) setCorrectionText('');
    }, [isOpen]);

    if (!isOpen) return null;

    const reportedMsg = messages.find(m => m.id === reportedMsgId);

    const getConversationContext = () => {
        const reportedIndex = messages.findIndex(m => m.id === reportedMsgId);
        if (reportedIndex === -1) return [];
        const startIdx = Math.max(0, reportedIndex - 7);
        return messages.slice(startIdx, reportedIndex + 1);
    };

    const handleSubmit = async () => {
        if (!correctionText.trim()) {
            toast.error('Por favor, escribe tus sugerencias de corrección.');
            return;
        }
        setLoading(true);
        try {
            const userPhone = selectedChat?.id?.split('@')[0] || 'unknown';
            const context = getConversationContext();

            await api.post('/api/ai-reports', {
                userPhone,
                reportedMessage: reportedMsg?.body || '',
                conversation: context.map(m => ({
                    role: m.fromMe ? 'bot' : 'user',
                    body: m.body || '[Media]',
                    isReported: m.id === reportedMsgId,
                })),
                correction: correctionText.trim(),
            });

            toast.success('Reporte guardado ✅ Lo podés ver en la sección "Errores de IA".');
            onClose();
        } catch (e) {
            toast.error('Error al guardar el reporte: ' + (e.response?.data?.error || e.message));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}></div>

            <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl overflow-hidden relative z-10 animate-fade-in flex flex-col max-h-[90vh]">

                {/* Header */}
                <div className="p-5 sm:p-6 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-amber-50 dark:bg-amber-900/20">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-600 flex items-center justify-center">
                            <AlertTriangle className="w-5 h-5" />
                        </div>
                        <div>
                            <h2 className="text-xl font-extrabold text-slate-800 dark:text-slate-100">Reportar Error de IA</h2>
                            <p className="text-xs text-slate-500 font-medium">Ayudá a mejorar las respuestas del bot (+{selectedChat?.id?.split('@')[0]})</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors">
                        <X className="w-6 h-6" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5 sm:p-6 custom-scrollbar space-y-6">

                    {/* Reported message */}
                    <div>
                        <h3 className="font-bold text-slate-700 dark:text-slate-200 text-sm tracking-wide uppercase mb-3">Estás reportando este mensaje</h3>
                        <div className="flex justify-end">
                            <div className="max-w-[85%] p-3 rounded-2xl text-[13px] leading-relaxed bg-rose-100 dark:bg-rose-900/30 text-rose-800 dark:text-rose-200 border-2 border-rose-400">
                                <span className="font-bold block text-[10px] opacity-60 uppercase mb-1">Bot</span>
                                {reportedMsg?.body || '[Media Oculta]'}
                            </div>
                        </div>
                    </div>

                    {/* Correction */}
                    <div>
                        <h3 className="font-bold text-slate-700 dark:text-slate-200 text-sm tracking-wide mb-3 flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-amber-500 outline outline-2 outline-amber-200"></span>
                            ¿Qué hizo mal o qué debería haber dicho?
                        </h3>
                        <textarea
                            value={correctionText}
                            onChange={(e) => setCorrectionText(e.target.value)}
                            placeholder="Ej: Acá asumió que no teníamos stock, pero sí tenemos. Debería haberle ofrecido el pack de 60 días."
                            className="w-full h-32 bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-2xl p-4 text-sm focus:outline-none focus:border-amber-400 focus:ring-4 focus:ring-amber-500/10 transition-all text-slate-800 dark:text-slate-100 resize-none"
                            autoFocus
                        ></textarea>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-5 sm:p-6 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
                    <div className="flex gap-3 justify-end">
                        <button onClick={onClose} className="px-5 py-2.5 rounded-xl font-bold text-slate-600 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors">
                            Cancelar
                        </button>
                        <button
                            onClick={handleSubmit}
                            disabled={loading}
                            className="px-6 py-2.5 rounded-xl font-bold text-white bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 shadow-md shadow-amber-500/20 hover:shadow-lg transition-all flex items-center gap-2 transform active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {loading
                                ? <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                : <Send className="w-4 h-4" />
                            }
                            {loading ? 'Guardando...' : 'Guardar Reporte'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AiCorrectionModal;
