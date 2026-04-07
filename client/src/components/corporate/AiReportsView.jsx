import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Trash2, ChevronDown, ChevronUp, RefreshCw, MessageSquare } from 'lucide-react';
import api from '../../config/axios';
import { useToast } from '../ui/Toast';

const AiReportsView = () => {
    const { toast } = useToast();
    const [reports, setReports] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedId, setExpandedId] = useState(null);

    const fetchReports = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get('/api/ai-reports');
            setReports(res.data);
        } catch (e) {
            toast.error('Error al cargar reportes: ' + (e.response?.data?.error || e.message));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchReports(); }, [fetchReports]);

    const handleDelete = async (id) => {
        if (!window.confirm('¿Eliminar este reporte?')) return;
        try {
            await api.delete(`/api/ai-reports/${id}`);
            setReports(prev => prev.filter(r => r.id !== id));
            toast.success('Reporte eliminado');
        } catch (e) {
            toast.error('Error al eliminar: ' + (e.response?.data?.error || e.message));
        }
    };

    const toggleExpand = (id) => setExpandedId(prev => prev === id ? null : id);

    const formatDate = (iso) => {
        const d = new Date(iso);
        return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
            + ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    };

    return (
        <div className="w-full max-w-4xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-600 flex items-center justify-center">
                        <AlertTriangle className="w-5 h-5" />
                    </div>
                    <div>
                        <h2 className="text-xl font-extrabold text-slate-800 dark:text-slate-100">Errores de IA</h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">{reports.length} reporte{reports.length !== 1 ? 's' : ''} guardado{reports.length !== 1 ? 's' : ''}</p>
                    </div>
                </div>
                <button
                    onClick={fetchReports}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-indigo-300 hover:text-indigo-600 transition-all shadow-sm"
                >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    Actualizar
                </button>
            </div>

            {/* Content */}
            {loading ? (
                <div className="flex items-center justify-center h-40">
                    <div className="w-8 h-8 border-4 border-amber-400 border-t-transparent rounded-full animate-spin" />
                </div>
            ) : reports.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-56 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 text-slate-400">
                    <MessageSquare className="w-10 h-10 mb-3 opacity-30" />
                    <p className="font-bold text-slate-500 dark:text-slate-400">No hay reportes todavía</p>
                    <p className="text-xs mt-1">Cuando marques un mensaje del bot como erróneo, aparecerá acá.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {reports.map((report) => {
                        const isExpanded = expandedId === report.id;
                        let conversation = [];
                        try { conversation = JSON.parse(report.conversation); } catch { }

                        return (
                            <div key={report.id} className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                                {/* Row */}
                                <div className="flex items-start gap-4 p-4">
                                    <div className="w-9 h-9 rounded-full bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 flex items-center justify-center flex-shrink-0 mt-0.5">
                                        <AlertTriangle className="w-4 h-4" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                                            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 font-mono">+{report.userPhone}</span>
                                            <span className="text-[10px] text-slate-400 dark:text-slate-500">{formatDate(report.createdAt)}</span>
                                        </div>
                                        {/* Reported message */}
                                        <p className="text-sm text-rose-700 dark:text-rose-300 font-medium bg-rose-50 dark:bg-rose-900/20 rounded-xl px-3 py-2 border border-rose-200 dark:border-rose-800/50 mb-2 line-clamp-2">
                                            ❌ {report.reportedMessage || '—'}
                                        </p>
                                        {/* Correction */}
                                        <p className="text-sm text-emerald-700 dark:text-emerald-300 font-medium bg-emerald-50 dark:bg-emerald-900/20 rounded-xl px-3 py-2 border border-emerald-200 dark:border-emerald-800/50">
                                            💡 {report.correction}
                                        </p>
                                    </div>

                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        <button
                                            onClick={() => toggleExpand(report.id)}
                                            className="p-2 rounded-xl text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
                                            title="Ver conversación completa"
                                        >
                                            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                        </button>
                                        <button
                                            onClick={() => handleDelete(report.id)}
                                            className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
                                            title="Eliminar reporte"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>

                                {/* Expanded conversation */}
                                {isExpanded && conversation.length > 0 && (
                                    <div className="border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4">
                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Conversación completa</p>
                                        <div className="space-y-2">
                                            {conversation.map((msg, idx) => (
                                                <div key={idx} className={`flex flex-col ${msg.role === 'bot' ? 'items-end' : 'items-start'}`}>
                                                    <div className={`
                                                        max-w-[85%] px-3 py-2 rounded-2xl text-[12px] leading-relaxed
                                                        ${msg.isReported
                                                            ? 'bg-rose-100 dark:bg-rose-900/30 text-rose-800 dark:text-rose-200 border-2 border-rose-400'
                                                            : msg.role === 'bot'
                                                                ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200'
                                                                : 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-600'
                                                        }
                                                    `}>
                                                        <span className="font-bold text-[10px] opacity-50 uppercase block mb-0.5">
                                                            {msg.role === 'bot' ? 'Bot' : 'Usuario'}{msg.isReported ? ' ❌' : ''}
                                                        </span>
                                                        {msg.body}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default AiReportsView;
