import React from 'react';
import { ShoppingCart, Copy, Truck } from 'lucide-react';
import { Card, Button, IconButton, Badge, EmptyState } from '../../ui';

// Panel desplegable con los pedidos pasados del cliente seleccionado.
// Muestra: dirección + tracking (con consulta TCA on-demand) + producto/plan/precio.
// Se monta entre el header del chat y el banner de alerta.
export default function OrdersDrawer({
    pastOrders = [],
    onClose,
    onCopySale,
    onTrack,
    isTracking,
    trackingData,
}) {
    return (
        <div className="border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 sm:p-5 z-10 animate-fade-in flex-shrink-0">
            <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-control bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400 flex items-center justify-center">
                        <ShoppingCart className="w-4 h-4" aria-hidden="true" />
                    </div>
                    <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-sm">Registro de pedidos</h3>
                    <Badge tone="neutral" size="sm">{pastOrders.length}</Badge>
                </div>
                <IconButton label="Cerrar pedidos" icon={undefined} variant="ghost" size="sm" onClick={onClose}>
                    <span aria-hidden="true">✕</span>
                </IconButton>
            </div>

            <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto custom-scrollbar pr-1">
                {pastOrders.length === 0 ? (
                    <div className="rounded-control border border-dashed border-slate-200 dark:border-slate-700">
                        <EmptyState
                            icon={ShoppingCart}
                            description="No hay registros de compras anteriores."
                            className="py-8"
                        />
                    </div>
                ) : (
                    pastOrders.map((order, i) => (
                        <Card key={i} padding="md" interactive>
                            <div className="flex justify-between items-center mb-3 pb-3 border-b border-slate-100 dark:border-slate-700">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <Badge tone="accent" size="sm">{order.status || 'Completado'}</Badge>
                                    <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                                        {order.createdAt || 'Sin fecha'}
                                    </span>
                                </div>
                                <Button
                                    size="sm"
                                    variant="subtle"
                                    leftIcon={Copy}
                                    onClick={() => onCopySale(order)}
                                >
                                    Copiar
                                </Button>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {/* Destino + tracking */}
                                <div>
                                    <h4 className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
                                        Destino de entrega
                                    </h4>
                                    <div className="space-y-2 text-xs">
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <span className="text-slate-500 dark:text-slate-400">Ubicación</span>
                                                <p className="font-medium text-slate-900 dark:text-slate-100">{order.ciudad || '—'}</p>
                                            </div>
                                            <div>
                                                <span className="text-slate-500 dark:text-slate-400">C. Postal</span>
                                                <p className="font-medium text-slate-900 dark:text-slate-100 font-mono">{order.cp || '—'}</p>
                                            </div>
                                            <div className="col-span-2">
                                                <span className="text-slate-500 dark:text-slate-400">Domicilio</span>
                                                <p className="font-medium text-slate-900 dark:text-slate-100">{order.calle || '—'}</p>
                                            </div>
                                        </div>

                                        {order.tracking && (
                                            <div className="pt-2 mt-2 border-t border-slate-100 dark:border-slate-700">
                                                <div className="flex items-center justify-between gap-2 mb-2">
                                                    <div className="min-w-0">
                                                        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide block">
                                                            Tracking TCA
                                                        </span>
                                                        <span className="font-mono text-xs font-medium text-slate-900 dark:text-slate-100">
                                                            {order.tracking}
                                                        </span>
                                                    </div>
                                                    <Button
                                                        size="sm"
                                                        variant="subtle"
                                                        leftIcon={Truck}
                                                        onClick={() => onTrack(order.tracking)}
                                                        loading={isTracking}
                                                    >
                                                        Rastrear
                                                    </Button>
                                                </div>

                                                {trackingData && (
                                                    <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 rounded-control p-2 max-h-40 overflow-y-auto custom-scrollbar mt-2">
                                                        {trackingData.success ? (
                                                            trackingData.events?.length > 0 ? (
                                                                <ul className="space-y-1.5">
                                                                    {trackingData.events.map((ev, idx) => (
                                                                        <li key={idx} className="bg-white dark:bg-slate-800 px-2 py-1.5 rounded border border-slate-100 dark:border-slate-700 text-[11px]">
                                                                            <p className="font-medium text-slate-900 dark:text-slate-100">
                                                                                {ev.fecha}
                                                                                {ev.planta && <span className="text-info-600 dark:text-info-500 ml-1">· {ev.planta}</span>}
                                                                            </p>
                                                                            <p className="text-slate-500 dark:text-slate-400 line-clamp-2 leading-snug">
                                                                                {ev.historia}
                                                                            </p>
                                                                        </li>
                                                                    ))}
                                                                </ul>
                                                            ) : (
                                                                <p className="text-xs text-slate-500 dark:text-slate-400">Aún no hay movimientos.</p>
                                                            )
                                                        ) : (
                                                            <p className="text-xs text-danger-600 dark:text-danger-500 font-medium">Tracking inválido.</p>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Mercadería + total */}
                                <div className="md:border-l md:border-slate-100 dark:md:border-slate-700 md:pl-4">
                                    <h4 className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
                                        Mercadería adquirida
                                    </h4>
                                    <div className="bg-slate-50 dark:bg-slate-900/40 rounded-control p-3 border border-slate-100 dark:border-slate-700/70 mb-3">
                                        <p className="text-slate-900 dark:text-slate-100 font-semibold text-sm mb-0.5">
                                            {order.producto}
                                        </p>
                                        <p className="text-accent-600 dark:text-accent-400 text-xs font-medium">
                                            Tratamiento de {order.plan} días
                                        </p>
                                    </div>
                                    <div className="flex justify-between items-end">
                                        <span className="text-[11px] text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide">
                                            A pagar
                                        </span>
                                        <span className="text-success-600 dark:text-success-500 font-semibold text-xl tabular-nums">
                                            ${order.precio || '0'}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </Card>
                    ))
                )}
            </div>
        </div>
    );
}
