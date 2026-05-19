import React from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Trash2, Zap, Package } from 'lucide-react';
import { Button, IconButton, Badge } from '../../ui';

// Banner inline que muestra una alerta activa para el chat seleccionado:
//   - reason (header siempre visible)
//   - orderData (product/plan/price/step) si existe
//   - details (texto largo de la alerta)
//   - quickReplies (botones de respuesta rápida sugerida)
// Se puede colapsar tocando el header.
export default function AlertBanner({ alert, expanded, onToggle, onAlertAction, onPickReply }) {
    if (!alert) return null;

    const isOrderAlert = !!(alert.reason && alert.reason.includes('Pedido'));

    return (
        <div className="border-b border-danger-200 dark:border-danger-900/50 bg-danger-50/60 dark:bg-danger-900/15 flex-shrink-0">
            {/* Header — siempre visible, clickeable para colapsar */}
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                className="w-full flex items-center justify-between gap-2 p-3 sm:p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger-500 focus-visible:ring-inset"
            >
                <div className="flex items-center gap-3 min-w-0 flex-1 text-left">
                    <div className="w-9 h-9 rounded-control bg-danger-100 dark:bg-danger-900/40 text-danger-600 dark:text-danger-500 flex items-center justify-center flex-shrink-0">
                        <AlertTriangle className="w-4 h-4" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                            <Badge tone="danger" size="sm">Atención</Badge>
                            <h4 className="font-semibold text-slate-900 dark:text-slate-100 text-sm truncate">
                                {alert.reason || 'Notificación del sistema'}
                            </h4>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                    {isOrderAlert && onAlertAction && (
                        <Button
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); onAlertAction(alert.userPhone, 'confirmar'); }}
                            className="!bg-success-600 hover:!bg-success-700"
                        >
                            Aprobar
                        </Button>
                    )}
                    {onAlertAction && (
                        <IconButton
                            label="Descartar alerta"
                            icon={Trash2}
                            variant="danger"
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); onAlertAction(alert.userPhone, 'descartar'); }}
                        />
                    )}
                    {expanded
                        ? <ChevronUp className="w-4 h-4 text-slate-500" aria-hidden="true" />
                        : <ChevronDown className="w-4 h-4 text-slate-500" aria-hidden="true" />
                    }
                </div>
            </button>

            {/* Contenido expandido */}
            {expanded && (
                <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-3">
                    {/* Pedido actual — chips de product/plan/price/step */}
                    {alert.orderData && (alert.orderData.product || alert.orderData.step) && (
                        <div className="rounded-control bg-accent-50 dark:bg-accent-900/20 border border-accent-100 dark:border-accent-900/40 p-3">
                            <p className="text-[11px] font-medium text-accent-700 dark:text-accent-400 uppercase tracking-wide mb-2">
                                Pedido actual
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {alert.orderData.product && (
                                    <Badge tone="accent" size="md">
                                        <Package className="w-3 h-3" />
                                        {alert.orderData.product}
                                    </Badge>
                                )}
                                {alert.orderData.plan && <Badge tone="purple" size="md">{alert.orderData.plan} días</Badge>}
                                {alert.orderData.price && <Badge tone="success" size="md">${alert.orderData.price}</Badge>}
                                {alert.orderData.step && (
                                    <Badge tone="neutral" size="md">
                                        Paso: {alert.orderData.step.replace('waiting_', '').replace(/_/g, ' ')}
                                    </Badge>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Detalles del bug/alerta */}
                    {alert.details && (
                        <div className="bg-white/70 dark:bg-slate-800/50 rounded-control p-3 border border-danger-100 dark:border-danger-900/40">
                            <p className="text-[11px] font-medium text-danger-700 dark:text-danger-500 uppercase tracking-wide mb-1.5">
                                Detalles
                            </p>
                            <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-wrap">
                                {alert.details}
                            </p>
                        </div>
                    )}

                    {/* Quick replies sugeridas */}
                    {alert.quickReplies && alert.quickReplies.length > 0 && (
                        <div>
                            <p className="text-[11px] font-medium text-warning-700 dark:text-warning-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                                <Zap className="w-3 h-3" aria-hidden="true" />
                                Sugerencias
                            </p>
                            <div className="flex flex-col gap-1.5">
                                {alert.quickReplies.map((qr, i) => (
                                    <button
                                        key={i}
                                        type="button"
                                        onClick={() => onPickReply(qr.message)}
                                        className="text-left w-full px-3 py-2 rounded-control bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-accent-300 dark:hover:border-accent-700 hover:bg-accent-50 dark:hover:bg-accent-900/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                                    >
                                        <span className="text-[11px] font-semibold text-accent-700 dark:text-accent-400 uppercase tracking-wide">
                                            {qr.label}
                                        </span>
                                        <p className="text-xs text-slate-700 dark:text-slate-200 mt-0.5 leading-snug">
                                            {qr.message}
                                        </p>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
