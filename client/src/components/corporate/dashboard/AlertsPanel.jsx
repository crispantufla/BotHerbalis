import React, { useState } from 'react';
import { AlertTriangle, MessageCircle, Send, Package, MapPin, CheckCircle2, Sparkles, X } from 'lucide-react';
import { Card, Button, IconButton, Badge, EmptyState } from '../../ui';

const AlertsPanel = ({ alerts, onCommand, onQuickAction }) => {
    const [adminInputs, setAdminInputs] = useState({});
    const [sendingCommand, setSendingCommand] = useState({});
    const [expandedCards, setExpandedCards] = useState({});

    const handleSend = async (alert, command) => {
        if (!command.trim()) return;
        setSendingCommand(prev => ({ ...prev, [alert.id]: true }));
        await onCommand(alert, command);
        setSendingCommand(prev => ({ ...prev, [alert.id]: false }));
        setAdminInputs(prev => ({ ...prev, [alert.id]: '' }));
    };

    const toggleExpand = (id) => setExpandedCards(prev => ({ ...prev, [id]: !prev[id] }));

    const getTimeDiff = (timestamp) => {
        const diff = Date.now() - new Date(timestamp).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'Ahora';
        if (mins < 60) return `${mins}m`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h`;
        return `${Math.floor(hrs / 24)}d`;
    };

    return (
        <div className="space-y-4">
            {/* Header */}
            <Card padding="md">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-card bg-danger-50 dark:bg-danger-900/30 text-danger-600 dark:text-danger-500 flex items-center justify-center flex-shrink-0">
                        <AlertTriangle className="w-5 h-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                        <h2 className="font-semibold text-slate-900 dark:text-slate-100 text-base leading-tight">
                            Intervenciones
                        </h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            {alerts.length > 0
                                ? `${alerts.length} alerta${alerts.length === 1 ? '' : 's'} requieren tu atención`
                                : 'Sistema automatizado en marcha'}
                        </p>
                    </div>
                </div>
            </Card>

            {/* Empty State */}
            {alerts.length === 0 ? (
                <Card padding="lg">
                    <EmptyState
                        icon={CheckCircle2}
                        title="Todo bajo control"
                        description="El bot está gestionando todas las conversaciones en automático. Las alertas aparecerán aquí cuando un cliente requiera intervención directa."
                    />
                </Card>
            ) : (
                <div className="space-y-3">
                    {alerts.map((alert) => {
                        const od = alert.orderData || {};
                        const addr = od.address || {};
                        const hasOrder = !!(od.product || od.price);
                        const isOrderApproval = hasOrder && Boolean(
                            alert.reason && (alert.reason.toLowerCase().includes('inesperada') || alert.reason.toLowerCase().includes('aprobaci'))
                        );
                        const cleanPhone = alert.userPhone ? alert.userPhone.split('@')[0] : 'Desconocido';
                        const inputValue = adminInputs[alert.id] || '';
                        const isSending = sendingCommand[alert.id] || false;
                        const isExpanded = expandedCards[alert.id] !== false;

                        return (
                            <Card key={alert.id} padding="none" className="overflow-hidden">
                                {/* Cabecera clickeable */}
                                <button
                                    type="button"
                                    onClick={() => toggleExpand(alert.id)}
                                    aria-expanded={isExpanded}
                                    className="w-full text-left p-4 sm:p-5 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-inset"
                                >
                                    <div className="flex flex-wrap lg:flex-nowrap items-start justify-between gap-3">
                                        <div className="flex items-start gap-3 min-w-0 flex-1">
                                            <div className="w-10 h-10 rounded-card bg-danger-50 dark:bg-danger-900/30 text-danger-600 dark:text-danger-500 flex items-center justify-center flex-shrink-0">
                                                <AlertTriangle className="w-5 h-5" aria-hidden="true" />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                    <Badge tone="danger" size="sm">Urgente</Badge>
                                                    <span className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                                                        {getTimeDiff(alert.timestamp)}
                                                    </span>
                                                </div>
                                                <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-sm leading-snug line-clamp-2">
                                                    {alert.reason}
                                                </h3>
                                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono">
                                                    {cleanPhone}
                                                </p>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-2 flex-shrink-0">
                                            <IconButton
                                                label="Ver chat"
                                                icon={MessageCircle}
                                                variant="accent"
                                                size="sm"
                                                onClick={(e) => { e.stopPropagation(); onQuickAction(alert.userPhone, 'chat'); }}
                                            />
                                            {isOrderApproval && (
                                                <Button
                                                    size="sm"
                                                    variant="primary"
                                                    onClick={(e) => { e.stopPropagation(); onQuickAction(alert.userPhone, 'confirmar'); }}
                                                    className="!bg-success-600 hover:!bg-success-700"
                                                >
                                                    Aprobar
                                                </Button>
                                            )}
                                            <Button
                                                size="sm"
                                                variant="subtle"
                                                onClick={(e) => { e.stopPropagation(); toggleExpand(alert.id); }}
                                                className="!bg-warning-50 dark:!bg-warning-900/20 !text-warning-700 dark:!text-warning-500 !border-warning-100 dark:!border-warning-900/50 hover:!bg-warning-100 dark:hover:!bg-warning-900/40"
                                            >
                                                Interceder
                                            </Button>
                                            <IconButton
                                                label="Descartar alerta"
                                                icon={X}
                                                variant="danger"
                                                size="sm"
                                                onClick={(e) => { e.stopPropagation(); onQuickAction(alert.userPhone, 'descartar'); }}
                                            />
                                        </div>
                                    </div>
                                </button>

                                {/* Contenido expandido */}
                                {isExpanded && (
                                    <div className="border-t border-slate-200/70 dark:border-slate-700/70 bg-slate-50/60 dark:bg-slate-800/30 p-4 sm:p-5">
                                        {isOrderApproval && (
                                            <div className="mb-4 bg-white dark:bg-slate-900/40 rounded-control p-4 border border-slate-200/70 dark:border-slate-700/70 grid grid-cols-1 sm:grid-cols-2 gap-4">
                                                <div className="flex gap-3 items-start">
                                                    <div className="w-9 h-9 rounded-control bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400 flex items-center justify-center flex-shrink-0">
                                                        <Package className="w-4 h-4" aria-hidden="true" />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Pedido</p>
                                                        <p className="font-semibold text-slate-900 dark:text-slate-100 text-sm truncate">{od.product}</p>
                                                        <p className="text-xs text-success-600 dark:text-success-500 font-medium">Plan {od.plan} · ${od.price}</p>
                                                    </div>
                                                </div>
                                                <div className="flex gap-3 items-start">
                                                    <div className="w-9 h-9 rounded-control bg-info-50 dark:bg-info-900/30 text-info-600 dark:text-info-500 flex items-center justify-center flex-shrink-0">
                                                        <MapPin className="w-4 h-4" aria-hidden="true" />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Envío</p>
                                                        <p className="font-semibold text-slate-900 dark:text-slate-100 text-sm truncate">{addr.nombre}</p>
                                                        <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{addr.calle}, {addr.ciudad}</p>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {!isOrderApproval && hasOrder && (
                                            <div className="mb-4">
                                                <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Pedido actual</p>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {od.product && <Badge tone="accent" size="md"><Package className="w-3 h-3" />{od.product}</Badge>}
                                                    {od.plan && <Badge tone="info" size="md">{od.plan} días</Badge>}
                                                    {od.price && <Badge tone="success" size="md">${od.price}</Badge>}
                                                    {od.step && <Badge tone="neutral" size="md">Paso: {od.step.replace('waiting_', '').replace(/_/g, ' ')}</Badge>}
                                                </div>
                                            </div>
                                        )}

                                        {alert.details && (
                                            <div className="mb-4 bg-warning-50 dark:bg-warning-900/20 rounded-control p-3 border border-warning-100 dark:border-warning-900/40">
                                                <p className="text-[11px] font-medium text-warning-700 dark:text-warning-500 uppercase tracking-wide mb-1">Detalles</p>
                                                <p className="text-xs text-warning-900 dark:text-warning-500/80 leading-relaxed whitespace-pre-wrap">
                                                    {alert.details}
                                                </p>
                                            </div>
                                        )}

                                        <form
                                            onSubmit={(e) => { e.preventDefault(); handleSend(alert, inputValue); }}
                                            className="flex gap-2"
                                        >
                                            <input
                                                type="text"
                                                value={inputValue}
                                                onChange={(e) => setAdminInputs(prev => ({ ...prev, [alert.id]: e.target.value }))}
                                                placeholder="Instrucción para la IA…"
                                                aria-label="Instrucción para la IA"
                                                className="flex-1 h-10 rounded-control bg-white dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 px-3 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20"
                                            />
                                            <Button
                                                type="submit"
                                                variant="primary"
                                                loading={isSending}
                                                disabled={!inputValue.trim()}
                                                leftIcon={isSending ? null : Sparkles}
                                            >
                                                Enviar a IA
                                            </Button>
                                        </form>
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

export default AlertsPanel;
