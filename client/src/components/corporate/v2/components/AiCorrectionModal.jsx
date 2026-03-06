import React, { useState, useEffect } from 'react';
import { AlertTriangle, Copy, X, ArrowUpCircle } from 'lucide-react';
import { useToast } from '../../../../../ui/Toast';

const AiCorrectionModal = ({ isOpen, onClose, messages = [], reportedMsgId, selectedChat }) => {
    const { toast } = useToast();
    const [contextCount, setContextCount] = useState(4); // default 4 messages (1 reported + 3 before)
    const [correctionText, setCorrectionText] = useState('');
    const [contextMessages, setContextMessages] = useState([]);

    useEffect(() => {
        if (!isOpen || !reportedMsgId) return;

        const reportedIndex = messages.findIndex(m => m.id === reportedMsgId);
        if (reportedIndex === -1) return;

        // Get up to `contextCount` messages ending at reportedIndex
        const startIdx = Math.max(0, reportedIndex - contextCount + 1);
        const sliced = messages.slice(startIdx, reportedIndex + 1);
        setContextMessages(sliced);
    }, [isOpen, reportedMsgId, messages, contextCount]);

    useEffect(() => {
        if (!isOpen) {
            setCorrectionText('');
            setContextCount(4);
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleLoadMore = () => {
        setContextCount(prev => prev + 4);
    };

    const generateAndCopyReport = () => {
        if (!correctionText.trim()) {
            toast.error('Por favor, escribe tus sugerencias de corrección.');
            return;
        }

        let markdown = `# ⚠ Reporte de Corrección de Flujo\n\n**Contexto de la conversación:**\n`;

        contextMessages.forEach(msg => {
            const sender = msg.fromMe ? '🤖 Bot' : '👤 Usuario';
            const body = msg.body || '[Contenido oculto/Media]';
            const isReported = msg.id === reportedMsgId;

            if (isReported) {
                markdown += `❌ **Bot (Respuesta Errónea):** ${body}\n`;
            } else {
                markdown += `${sender}: ${body}\n`;
            }
        });

        markdown += `\n💡 **Corrección del Administrador:**\n"${correctionText.trim()}"\n`;

        navigator.clipboard.writeText(markdown)
            .then(() => {
                toast.success('Reporte copiado al portapapeles ✅. ¡Pegalo en el chat con la IA!');
                onClose();
            })
            .catch(() => {
                toast.error('Error al copiar al portapapeles');
            });
    };

    return (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}></div>

            {/* Modal */}
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
                <div className="flex-1 overflow-y-auto p-5 sm:p-6 custom-scrollbar Space-y-6">
                    <div>
                        <div className="flex justify-between items-end mb-4">
                            <h3 className="font-bold text-slate-700 dark:text-slate-200 text-sm tracking-wide uppercase">Contexto de la Conversación</h3>
                            <button
                                onClick={handleLoadMore}
                                className="text-xs font-bold text-indigo-600 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors"
                            >
                                <ArrowUpCircle className="w-4 h-4" /> Cargar más
                            </button>
                        </div>

                        <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-2xl p-4 space-y-3">
                            {contextMessages.map((msg, idx) => {
                                const isReported = msg.id === reportedMsgId;
                                const isLast = idx === contextMessages.length - 1;

                                return (
                                    <div key={msg.id} className={`flex flex-col ${msg.fromMe ? 'items-end' : 'items-start'}`}>
                                        <div className={`
                                            max-w-[85%] p-3 rounded-2xl text-[13px] leading-relaxed relative
                                            ${isReported
                                                ? 'bg-rose-100 dark:bg-rose-900/30 text-rose-800 dark:text-rose-200 border-2 border-rose-400'
                                                : msg.fromMe
                                                    ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-200'
                                                    : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700'
                                            }
                                        `}>
                                            {isReported && (
                                                <div className="absolute -top-3 -right-2 bg-rose-500 text-white text-[10px] font-black uppercase px-2 py-0.5 rounded-full shadow-sm">
                                                    Respuesta Errónea
                                                </div>
                                            )}
                                            <span className="font-bold block text-[10px] opacity-60 uppercase mb-1">
                                                {msg.fromMe ? 'Bot' : 'Usuario'}
                                            </span>
                                            {msg.body || '[Media Oculta]'}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div className="mt-8">
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
                        <button onClick={onClose} className="px-5 py-2.5 rounded-xl font-bold text-slate-600 hover:bg-slate-200 transition-colors">
                            Cancelar
                        </button>
                        <button
                            onClick={generateAndCopyReport}
                            className="px-6 py-2.5 rounded-xl font-bold text-white bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 shadow-md shadow-amber-500/20 hover:shadow-lg transition-all flex items-center gap-2 transform active:scale-95"
                        >
                            <Copy className="w-5 h-5" /> Generar y Copiar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AiCorrectionModal;
