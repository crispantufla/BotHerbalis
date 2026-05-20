import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Trash2, ChevronDown, ChevronUp, RefreshCw, MessageSquare } from 'lucide-react';
import api from '../../config/axios';
import {
    Card, Button, IconButton, Badge, EmptyState, useToast, cn
} from '../ui';

const formatDate = (iso) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
};

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

    return (
        <div className="w-full max-w-4xl mx-auto space-y-4">
            <header className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-display text-slate-900 dark:text-slate-100">Errores de IA</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        {reports.length} reporte{reports.length !== 1 ? 's' : ''} guardado{reports.length !== 1 ? 's' : ''}.
                    </p>
                </div>
                <Button
                    variant="secondary"
                    leftIcon={RefreshCw}
                    onClick={fetchReports}
                    className={loading ? '[&_svg]:animate-spin' : ''}
                >
                    Actualizar
                </Button>
            </header>

            {loading ? (
                <Card padding="lg" className="flex items-center justify-center min-h-[160px]">
                    <div className="w-8 h-8 border-[3px] border-warning-200 dark:border-warning-900 border-t-warning-600 dark:border-t-warning-500 rounded-full animate-spin" />
                </Card>
            ) : reports.length === 0 ? (
                <Card padding="lg">
                    <EmptyState
                        icon={MessageSquare}
                        title="No hay reportes todavía"
                        description="Cuando marques un mensaje del bot como erróneo, aparecerá acá."
                    />
                </Card>
            ) : (
                <div className="space-y-3">
                    {reports.map(report => {
                        const isExpanded = expandedId === report.id;
                        let conversation = [];
                        try { conversation = JSON.parse(report.conversation); } catch { /* */ }

                        return (
                            <Card key={report.id} padding="none" interactive>
                                <div className="flex items-start gap-3 p-4">
                                    <div className="w-9 h-9 rounded-control bg-danger-50 dark:bg-danger-900/30 text-danger-600 dark:text-danger-500 flex items-center justify-center flex-shrink-0">
                                        <AlertTriangle className="w-4 h-4" aria-hidden="true" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                                            <span className="text-xs font-mono text-slate-600 dark:text-slate-300">+{report.userPhone}</span>
                                            <span className="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">
                                                {formatDate(report.createdAt)}
                                            </span>
                                        </div>
                                        <div className="rounded-control bg-danger-50 dark:bg-danger-900/20 border border-danger-100 dark:border-danger-900/40 px-3 py-2 mb-2">
                                            <p className="text-[11px] font-medium text-danger-700 dark:text-danger-500 uppercase tracking-wide mb-0.5">
                                                Mensaje reportado
                                            </p>
                                            <p className="text-sm text-danger-700 dark:text-danger-500/90 line-clamp-2">
                                                {report.reportedMessage || '—'}
                                            </p>
                                        </div>
                                        <div className="rounded-control bg-success-50 dark:bg-success-900/20 border border-success-100 dark:border-success-900/40 px-3 py-2">
                                            <p className="text-[11px] font-medium text-success-700 dark:text-success-500 uppercase tracking-wide mb-0.5">
                                                Corrección
                                            </p>
                                            <p className="text-sm text-success-700 dark:text-success-500/90">
                                                {report.correction}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-1 flex-shrink-0">
                                        <IconButton
                                            label={isExpanded ? 'Colapsar conversación' : 'Ver conversación completa'}
                                            icon={isExpanded ? ChevronUp : ChevronDown}
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => toggleExpand(report.id)}
                                        />
                                        <IconButton
                                            label="Eliminar reporte"
                                            icon={Trash2}
                                            variant="danger"
                                            size="sm"
                                            onClick={() => handleDelete(report.id)}
                                        />
                                    </div>
                                </div>

                                {isExpanded && conversation.length > 0 && (
                                    <div className="border-t border-slate-200/70 dark:border-slate-700/70 bg-slate-50/60 dark:bg-slate-800/40 p-4">
                                        <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-3">
                                            Conversación completa
                                        </p>
                                        <div className="space-y-2">
                                            {conversation.map((msg, idx) => (
                                                <div key={idx} className={cn(
                                                    'flex flex-col',
                                                    msg.role === 'bot' ? 'items-end' : 'items-start'
                                                )}>
                                                    <div className={cn(
                                                        'max-w-[85%] px-3 py-2 rounded-control text-xs leading-relaxed',
                                                        msg.isReported
                                                            ? 'bg-danger-100 dark:bg-danger-900/30 text-danger-700 dark:text-danger-300 border-2 border-danger-400'
                                                            : msg.role === 'bot'
                                                                ? 'bg-accent-100 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300'
                                                                : 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-600'
                                                    )}>
                                                        <span className="font-medium text-[10px] opacity-60 uppercase block mb-0.5 tracking-wide">
                                                            {msg.role === 'bot' ? 'Bot' : 'Usuario'}{msg.isReported ? ' · reportado' : ''}
                                                        </span>
                                                        {msg.body}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </Card>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default AiReportsView;
