import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Activity, TrendingDown, PauseCircle, Repeat, Package, Cpu,
    RefreshCw, AlertTriangle, Timer, ChevronRight, HelpCircle, Info, Lightbulb,
    ChevronDown, ChevronUp
} from 'lucide-react';
import api from '../../config/axios';
import {
    Card, Button, IconButton, Badge, Select, KpiCard as UiKpiCard, EmptyState, useToast, cn
} from '../ui';

const STEP_LABELS = {
    greeting: 'Saludo', general: 'General',
    waiting_weight: 'Peso', waiting_preference: 'Preferencia',
    waiting_preference_consultation: 'Consulta pref.',
    waiting_plan_choice: 'Plan', waiting_price_confirmation: 'Confirm. precio',
    waiting_ok: 'OK', waiting_data: 'Datos',
    waiting_maps_confirmation: 'Maps', waiting_payment_method: 'Pago',
    waiting_mp_payment: 'MP', waiting_transfer_confirmation: 'Transferencia',
    waiting_final_confirmation: 'Conf. final',
    waiting_admin_ok: 'Admin OK', waiting_admin_validation: 'Admin valid.',
    closing: 'Cierre', completed: 'Completado', post_sale: 'Post-venta',
    safety_check: 'Safety',
    rejected_medical: '❌ Médico', rejected_abusive: '❌ Abusivo', rejected_geo: '❌ Geo',
};

const STEP_ORDER = [
    'greeting', 'general', 'waiting_weight', 'waiting_preference',
    'waiting_preference_consultation', 'waiting_plan_choice',
    'waiting_price_confirmation', 'waiting_ok', 'waiting_data',
    'waiting_maps_confirmation', 'waiting_payment_method', 'waiting_mp_payment',
    'waiting_transfer_confirmation', 'waiting_final_confirmation',
    'waiting_admin_ok', 'waiting_admin_validation', 'closing', 'completed',
];

const TABS = [
    { id: 'funnel',     label: 'Embudo',     icon: TrendingDown },
    { id: 'friction',   label: 'Fricción',   icon: AlertTriangle },
    { id: 'conversion', label: 'Conversión', icon: Timer },
    { id: 'product',    label: 'Producto',   icon: Package },
    { id: 'tech',       label: 'Técnico',    icon: Cpu },
];

function formatDur(sec) {
    if (!sec || sec <= 0) return '—';
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    if (sec < 86400) return `${Math.round(sec / 3600 * 10) / 10}h`;
    return `${Math.round(sec / 86400 * 10) / 10}d`;
}

// Descripción humana de cada step (glosario).
const STEP_EXPLAIN = {
    greeting: 'Primer contacto. El bot saludó y pregunta de qué se trata.',
    general: 'Conversación general sin un objetivo de venta asignado.',
    waiting_weight: 'El bot le pidió al cliente cuántos kilos quiere bajar.',
    waiting_preference: 'Está preguntando qué producto prefiere.',
    waiting_preference_consultation: 'Consulta técnica sobre el producto antes de elegir.',
    waiting_plan_choice: 'Mostrando planes 60 o 120 días.',
    waiting_price_confirmation: 'El cliente aún no vio el precio.',
    waiting_ok: 'Ya pasó toda la info y espera "sí quiero" antes de pedir datos.',
    waiting_data: 'Pidiendo nombre, dirección, ciudad, código postal.',
    waiting_maps_confirmation: 'Validando la dirección contra Google Maps.',
    waiting_payment_method: 'Eligiendo forma de pago.',
    waiting_mp_payment: 'Esperando que pague por MercadoPago.',
    waiting_transfer_confirmation: 'Esperando comprobante de transferencia.',
    waiting_final_confirmation: 'Confirmación final del pedido.',
    waiting_admin_ok: 'Admin validando antes de cerrar.',
    waiting_admin_validation: 'Espera OK manual del admin.',
    closing: 'Cierre: armando el mensaje final con totales.',
    completed: 'Venta cerrada. Cliente derivado a post-venta.',
    post_sale: 'Cliente que ya compró. Preguntas post-entrega.',
    safety_check: 'Chequeo de seguridad antes de vender.',
    rejected_medical: 'Rechazado por contraindicación médica.',
    rejected_abusive: 'Rechazado por abuso/insultos.',
    rejected_geo: 'Fuera de Argentina.',
};

// InfoBox: callout tonal (info | tip). Usado en muchas secciones.
function InfoBox({ children, variant = 'info' }) {
    const Icon = variant === 'tip' ? Lightbulb : Info;
    const cls = variant === 'tip'
        ? 'bg-warning-50 dark:bg-warning-900/20 border-warning-200 dark:border-warning-900/40 text-warning-800 dark:text-warning-500'
        : 'bg-info-50 dark:bg-info-900/20 border-info-200 dark:border-info-900/40 text-info-800 dark:text-info-500';
    return (
        <div className={cn('border rounded-card p-4 text-sm flex gap-3', cls)}>
            <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <div className="flex-1 space-y-1.5">{children}</div>
        </div>
    );
}

const FunnelAnalyticsView = () => {
    const { toast } = useToast();
    const [tab, setTab] = useState('funnel');
    const [daysBack, setDaysBack] = useState(7);
    const [showHowTo, setShowHowTo] = useState(false);
    const [showGlossary, setShowGlossary] = useState(false);
    const [loading, setLoading] = useState(false);
    const [funnel, setFunnel] = useState(null);
    const [pauseAlerts, setPauseAlerts] = useState(null);
    const [ttc, setTtc] = useState(null);
    const [reentries, setReentries] = useState(null);
    const [retries, setRetries] = useState(null);
    const [aiFallback, setAiFallback] = useState(null);
    const [priceObj, setPriceObj] = useState(null);
    const [abandonment, setAbandonment] = useState(null);
    const [productMix, setProductMix] = useState(null);
    const [cacheHits, setCacheHits] = useState(null);

    const fetchAll = useCallback(async () => {
        setLoading(true);
        try {
            const qs = `?days=${daysBack}`;
            const [f, p, t, r, ret, aif, po, ab, pm, ch] = await Promise.all([
                api.get('/api/analytics/funnel' + qs),
                api.get('/api/analytics/pause-alerts' + qs),
                api.get('/api/analytics/time-to-close' + qs),
                api.get('/api/analytics/reentries' + qs),
                api.get('/api/analytics/retries' + qs),
                api.get('/api/analytics/ai-fallback' + qs),
                api.get('/api/analytics/price-objections' + qs),
                api.get('/api/analytics/abandonment-by-hour' + qs),
                api.get('/api/analytics/product-mix' + qs),
                api.get('/api/analytics/cache-hits' + qs),
            ]);
            setFunnel(f.data); setPauseAlerts(p.data); setTtc(t.data);
            setReentries(r.data); setRetries(ret.data); setAiFallback(aif.data);
            setPriceObj(po.data); setAbandonment(ab.data);
            setProductMix(pm.data); setCacheHits(ch.data);
        } catch (e) {
            toast.error('Error cargando analítica: ' + (e.response?.data?.error || e.message));
        } finally {
            setLoading(false);
        }
    }, [daysBack, toast]);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    const orderedFunnel = useMemo(() => {
        if (!funnel?.steps) return [];
        return [...funnel.steps].sort((a, b) => {
            const ia = STEP_ORDER.indexOf(a.step);
            const ib = STEP_ORDER.indexOf(b.step);
            if (ia === -1 && ib === -1) return 0;
            if (ia === -1) return 1;
            if (ib === -1) return -1;
            return ia - ib;
        });
    }, [funnel]);

    const maxEntered = useMemo(() => {
        if (!orderedFunnel.length) return 1;
        return Math.max(...orderedFunnel.map(s => s.entered));
    }, [orderedFunnel]);

    return (
        <div className="w-full max-w-7xl mx-auto space-y-4">
            <header className="flex items-center justify-between flex-wrap gap-3">
                <div className="min-w-0">
                    <h1 className="text-display text-slate-900 dark:text-slate-100">Analítica de embudo</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        Dónde se traban las conversaciones y cómo mejorar la conversión.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Select
                        value={daysBack}
                        onChange={e => setDaysBack(parseInt(e.target.value, 10))}
                        aria-label="Rango"
                        className="!w-44"
                    >
                        <option value={1}>Últimas 24h</option>
                        <option value={7}>Últimos 7 días</option>
                        <option value={30}>Últimos 30 días</option>
                        <option value={90}>Últimos 90 días</option>
                    </Select>
                    <IconButton
                        label="Recargar"
                        icon={RefreshCw}
                        variant="ghost"
                        onClick={fetchAll}
                        disabled={loading}
                        className={loading ? '[&_svg]:animate-spin' : ''}
                    />
                </div>
            </header>

            {/* Ayuda expandibles */}
            <div className="space-y-2">
                <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={HelpCircle}
                    rightIcon={showHowTo ? ChevronUp : ChevronDown}
                    onClick={() => setShowHowTo(v => !v)}
                >
                    ¿Cómo leer esta página?
                </Button>
                {showHowTo && (
                    <Card padding="md">
                        <div className="text-sm text-slate-700 dark:text-slate-300 space-y-2">
                            <p>
                                <strong className="text-slate-900 dark:text-slate-100">Qué es el embudo.</strong>{' '}
                                Una conversación con el bot pasa por varios <em>steps</em>: saluda → pregunta el peso → elige producto → elige plan → da datos → paga → cierra. Cada vez que el cliente avanza, lo registramos.
                            </p>
                            <p>
                                <strong className="text-slate-900 dark:text-slate-100">Qué significa "se traba".</strong>{' '}
                                Si de 100 clientes que llegaron a "Datos" solo 60 pasaron al siguiente, hay 40 que se cayeron ahí — un <strong>40% de drop</strong>. Ver <em>qué step</em> tiene más drop es donde conviene arreglar.
                            </p>
                            <p>
                                <strong className="text-slate-900 dark:text-slate-100">De dónde sale la data.</strong>{' '}
                                Solo conversaciones nuevas desde que esta función se activó. Los números crecen con el tiempo. El rango de fechas define qué período mirar.
                            </p>
                        </div>
                    </Card>
                )}

                <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={HelpCircle}
                    rightIcon={showGlossary ? ChevronUp : ChevronDown}
                    onClick={() => setShowGlossary(v => !v)}
                >
                    ¿Qué significa cada paso?
                </Button>
                {showGlossary && (
                    <Card padding="md">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                            {STEP_ORDER.filter(s => STEP_EXPLAIN[s]).map(s => (
                                <div key={s} className="flex gap-3">
                                    <span className="font-semibold text-slate-700 dark:text-slate-200 w-32 flex-shrink-0">
                                        {STEP_LABELS[s] || s}
                                    </span>
                                    <span className="text-slate-500 dark:text-slate-400">{STEP_EXPLAIN[s]}</span>
                                </div>
                            ))}
                        </div>
                    </Card>
                )}
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-200 dark:border-slate-700 overflow-x-auto">
                {TABS.map(t => {
                    const Icon = t.icon;
                    const isActive = tab === t.id;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            onClick={() => setTab(t.id)}
                            className={cn(
                                'inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap',
                                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-inset',
                                isActive
                                    ? 'border-accent-500 text-accent-600 dark:text-accent-400'
                                    : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                            )}
                        >
                            <Icon className="w-4 h-4" aria-hidden="true" />
                            {t.label}
                        </button>
                    );
                })}
            </div>

            {/* Contenido del tab */}
            {loading && !funnel ? (
                <Card padding="lg" className="flex items-center justify-center min-h-[200px]">
                    <div className="w-8 h-8 border-[3px] border-accent-200 dark:border-accent-900 border-t-accent-600 dark:border-t-accent-500 rounded-full animate-spin" />
                </Card>
            ) : tab === 'funnel' ? (
                <FunnelTab orderedFunnel={orderedFunnel} maxEntered={maxEntered} pauseAlerts={pauseAlerts} reentries={reentries} />
            ) : tab === 'friction' ? (
                <FrictionTab retries={retries} aiFallback={aiFallback} pauseAlerts={pauseAlerts} />
            ) : tab === 'conversion' ? (
                <ConversionTab ttc={ttc} priceObj={priceObj} abandonment={abandonment} />
            ) : tab === 'product' ? (
                <ProductTab mix={productMix} />
            ) : tab === 'tech' ? (
                <TechTab cache={cacheHits} aiFallback={aiFallback} />
            ) : null}
        </div>
    );
};

// ─── TAB: EMBUDO ────────────────────────────────────────────────
function FunnelTab({ orderedFunnel, maxEntered, pauseAlerts, reentries }) {
    const pauseMap = useMemo(
        () => Object.fromEntries((pauseAlerts?.byStep || []).map(r => [r.step, r.count])),
        [pauseAlerts]
    );

    if (!orderedFunnel.length) {
        return (
            <Card padding="lg">
                <EmptyState
                    icon={TrendingDown}
                    title="Sin datos"
                    description="Sin datos en el rango seleccionado. Los eventos se registran desde el último deploy."
                />
            </Card>
        );
    }

    return (
        <div className="space-y-4">
            <InfoBox>
                <p><strong>Qué estás viendo.</strong> Por cada paso del flujo: cuántos clientes entraron, cuántos avanzaron, y cuántos se cayeron o el bot pausó. El <strong>% Drop</strong> suma pausados + caídos sobre entrados.</p>
                <p><strong>Cómo usarlo.</strong> Los pasos con drop alto (&gt;30%, resaltado en rojo) son los cuellos de botella.</p>
            </InfoBox>

            <Card padding="md">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">Volumen y drop por step</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                    Ancho de la barra = cuántos clientes llegaron a ese paso.
                </p>
                <div className="space-y-2">
                    {orderedFunnel.map(s => {
                        const widthPct = Math.max(3, (s.entered / maxEntered) * 100);
                        const dropPct = s.dropRate;
                        const alertCount = pauseMap[s.step] || 0;
                        return (
                            <div key={s.step} className="flex items-center gap-3">
                                <div className="w-32 flex-shrink-0 text-xs text-slate-600 dark:text-slate-300 truncate">
                                    {STEP_LABELS[s.step] || s.step}
                                </div>
                                <div className="flex-1 relative h-6 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                                    <div
                                        className="absolute inset-y-0 left-0 bg-accent-500 transition-all"
                                        style={{ width: `${widthPct}%` }}
                                    />
                                    <div className="absolute inset-0 flex items-center px-2 text-[11px] font-medium text-white drop-shadow tabular-nums">
                                        {s.entered} entraron
                                    </div>
                                </div>
                                <div className="w-20 text-right text-xs tabular-nums">
                                    <span className={cn(
                                        'font-medium',
                                        dropPct > 30 ? 'text-danger-600 dark:text-danger-500'
                                        : dropPct > 15 ? 'text-warning-600 dark:text-warning-500'
                                        : 'text-slate-500 dark:text-slate-400'
                                    )}>
                                        {dropPct}% drop
                                    </span>
                                </div>
                                {alertCount > 0 && (
                                    <div className="w-16 text-right text-xs text-warning-600 dark:text-warning-500 flex items-center justify-end gap-1 tabular-nums">
                                        <PauseCircle className="w-3 h-3" aria-hidden="true" />
                                        {alertCount}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </Card>

            {/* Tabla detalle */}
            <Card padding="none" className="overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Detalle por step</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 dark:bg-slate-800/40 text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
                            <tr>
                                <th className="text-left px-4 py-2.5">Step</th>
                                <th className="text-right px-4 py-2.5">Entraron</th>
                                <th className="text-right px-4 py-2.5">Avanzaron</th>
                                <th className="text-right px-4 py-2.5">Volvieron</th>
                                <th className="text-right px-4 py-2.5">Pausados</th>
                                <th className="text-right px-4 py-2.5">Cayeron</th>
                                <th className="text-right px-4 py-2.5">Drop %</th>
                                <th className="text-right px-4 py-2.5">Tiempo p50</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {orderedFunnel.map(s => (
                                <tr key={s.step} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200 font-medium">{STEP_LABELS[s.step] || s.step}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-slate-600 dark:text-slate-300">{s.entered}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-success-600 dark:text-success-500">{s.advanced}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-warning-600 dark:text-warning-500">{s.back}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-warning-600 dark:text-warning-500">{s.paused}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-danger-600 dark:text-danger-500">{s.dropped}</td>
                                    <td className={cn(
                                        'text-right px-4 py-2 font-medium tabular-nums',
                                        s.dropRate > 30 ? 'text-danger-600 dark:text-danger-500'
                                        : s.dropRate > 15 ? 'text-warning-600 dark:text-warning-500'
                                        : 'text-slate-500 dark:text-slate-400'
                                    )}>
                                        {s.dropRate}%
                                    </td>
                                    <td className="text-right px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">
                                        {formatDur(s.medianTimeSec)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Card>

            {/* Reentradas */}
            {reentries?.transitions?.length > 0 && (
                <Card padding="md">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1 flex items-center gap-2">
                        <Repeat className="w-4 h-4 text-warning-500" aria-hidden="true" />
                        Top retrocesos
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
                        Transiciones donde el cliente se movió a un step anterior. Muchos retrocesos en la misma pareja = algo que confunde.
                    </p>
                    <div className="space-y-1">
                        {reentries.transitions.slice(0, 10).map((t, i) => (
                            <div key={i} className="flex items-center gap-2 text-sm py-1.5 px-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                <span className="text-slate-600 dark:text-slate-300 w-40 truncate">{STEP_LABELS[t.from] || t.from}</span>
                                <ChevronRight className="w-4 h-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                                <span className="text-slate-600 dark:text-slate-300 w-40 truncate">{STEP_LABELS[t.to] || t.to}</span>
                                <span className="ml-auto text-slate-700 dark:text-slate-200 font-semibold tabular-nums">{t.count}</span>
                            </div>
                        ))}
                    </div>
                </Card>
            )}
        </div>
    );
}

// ─── TAB: CONVERSIÓN ────────────────────────────────────────────
function ConversionTab({ ttc, priceObj, abandonment }) {
    const maxHourCount = useMemo(
        () => Math.max(1, ...(abandonment?.byHour?.map(h => h.count) || [0])),
        [abandonment]
    );

    return (
        <div className="space-y-4">
            <InfoBox>
                <p><strong>Qué estás viendo.</strong> Tres ángulos para entender por qué la gente compra o no:</p>
                <ul className="list-disc ml-5 space-y-0.5">
                    <li><strong>Tiempo a cierre</strong>: de "hola" hasta venta cerrada.</li>
                    <li><strong>Abandonos por hora</strong>: en qué hora del día abandonan más.</li>
                    <li><strong>Objeciones de precio</strong>: en qué step aparece "es caro" / "descuento".</li>
                </ul>
            </InfoBox>

            {ttc && ttc.total > 0 ? (
                <>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                        <UiKpiCard label="Cierres totales" value={ttc.total} subtext="Ventas completadas en el rango" tone="success" />
                        <UiKpiCard label="Tiempo mediano (p50)" value={formatDur(ttc.p50)} subtext="La mitad cerró antes" tone="accent" />
                        <UiKpiCard label="p90" value={formatDur(ttc.p90)} subtext="El 90% cerró antes" tone="info" />
                        <UiKpiCard label="p99" value={formatDur(ttc.p99)} subtext="Casos extremos (1% más lento)" tone="warning" />
                    </div>

                    <Card padding="md">
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">Distribución del tiempo a cierre</h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                            Cuántas ventas cerraron en cada ventana de tiempo.
                        </p>
                        <div className="space-y-2">
                            {ttc.histogram.map(b => {
                                const pct = ttc.total > 0 ? (b.count / ttc.total) * 100 : 0;
                                return (
                                    <div key={b.label} className="flex items-center gap-3">
                                        <div className="w-20 text-xs text-slate-600 dark:text-slate-300">{b.label}</div>
                                        <div className="flex-1 relative h-5 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                                            <div
                                                className="absolute inset-y-0 left-0 bg-success-500"
                                                style={{ width: `${Math.max(2, pct)}%` }}
                                            />
                                        </div>
                                        <div className="w-24 text-right text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                                            {b.count} ({pct.toFixed(1)}%)
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </Card>
                </>
            ) : (
                <Card padding="lg">
                    <EmptyState
                        icon={Timer}
                        title="Sin cierres"
                        description="Aún no hay cierres en el rango seleccionado."
                    />
                </Card>
            )}

            {abandonment && abandonment.total > 0 && (
                <Card padding="md">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">Abandonos por hora (Argentina)</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                        Hora del último mensaje antes de nunca más responder. Total: <strong>{abandonment.total}</strong>
                    </p>
                    <div className="flex items-end gap-1 h-32">
                        {abandonment.byHour.map(h => {
                            const heightPct = (h.count / maxHourCount) * 100;
                            return (
                                <div key={h.hour} className="flex-1 flex flex-col items-center gap-1" title={`${h.hour}:00 — ${h.count} abandonos`}>
                                    <div className="flex-1 w-full flex items-end">
                                        <div
                                            className="w-full bg-danger-500 rounded-t transition-all"
                                            style={{ height: `${Math.max(2, heightPct)}%` }}
                                        />
                                    </div>
                                    <div className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">{h.hour}</div>
                                </div>
                            );
                        })}
                    </div>
                </Card>
            )}

            {priceObj && priceObj.byStep?.length > 0 && (
                <Card padding="md">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1">Objeciones de precio por step</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                        Mensajes que contuvieron palabras tipo "caro", "descuento", "no tengo plata", agrupado por step.
                    </p>
                    <div className="space-y-2">
                        {priceObj.byStep.map(s => (
                            <div key={s.step} className="flex items-center gap-3 text-sm">
                                <div className="w-40 text-slate-600 dark:text-slate-300 truncate">{STEP_LABELS[s.step] || s.step}</div>
                                <div className="flex-1 relative h-4 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                                    <div
                                        className="absolute inset-y-0 left-0 bg-warning-500"
                                        style={{ width: `${Math.min(100, s.rate)}%` }}
                                    />
                                </div>
                                <div className="w-32 text-right text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                                    {s.objectionCount} ({s.rate}%)
                                </div>
                            </div>
                        ))}
                    </div>
                </Card>
            )}
        </div>
    );
}

// ─── TAB: FRICCIÓN ────────────────────────────────────────────
function FrictionTab({ retries, aiFallback, pauseAlerts }) {
    const merged = useMemo(() => {
        const map = new Map();
        const ensure = s => {
            if (!map.has(s)) map.set(s, { step: s, retryRate: null, b0: 0, b1: 0, b2_3: 0, b4plus: 0, total: 0, pauseCount: 0, msgs: 0, aiCalls: 0, aiRate: null });
            return map.get(s);
        };
        (retries?.byStep || []).forEach(r => {
            const g = ensure(r.step);
            g.retryRate = r.retryRate;
            g.b0 = r.b0; g.b1 = r.b1; g.b2_3 = r.b2_3; g.b4plus = r.b4plus; g.total = r.total;
        });
        (aiFallback?.byStep || []).forEach(r => {
            const g = ensure(r.step);
            g.msgs = r.messageCount; g.aiCalls = r.aiCallCount; g.aiRate = r.aiFallbackRate;
        });
        (pauseAlerts?.byStep || []).forEach(r => {
            const g = ensure(r.step);
            g.pauseCount = r.count;
        });
        return Array.from(map.values()).sort((a, b) => {
            const ai = STEP_ORDER.indexOf(a.step);
            const bi = STEP_ORDER.indexOf(b.step);
            if (ai === -1 && bi === -1) return 0;
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        });
    }, [retries, aiFallback, pauseAlerts]);

    if (!merged.length) {
        return (
            <Card padding="lg">
                <EmptyState
                    icon={AlertTriangle}
                    title="Sin datos"
                    description="Sin datos de fricción en el rango seleccionado."
                />
            </Card>
        );
    }

    return (
        <div className="space-y-4">
            <InfoBox>
                <p><strong>Qué estás viendo.</strong> Señales de que el bot está pasándolo mal en cierto paso. Tres ángulos:</p>
                <ul className="list-disc ml-5 space-y-0.5">
                    <li><strong>Retries</strong>: el cliente escribió varias veces porque el bot le repregunta lo mismo.</li>
                    <li><strong>AI fallback</strong>: cuánto del trabajo del paso cayó a GPT vs reglas.</li>
                    <li><strong>Pausas</strong>: el bot se rindió, alertó al admin y paró.</li>
                </ul>
            </InfoBox>

            <InfoBox variant="tip">
                <p><strong>¿Qué hacer con esto?</strong></p>
                <ul className="list-disc ml-5 space-y-0.5">
                    <li>Step con <strong>Retries &gt;40%</strong>: leer chats reales y ajustar el parser.</li>
                    <li>Step con <strong>AI fallback &gt;60%</strong>: agregar reglas hardcoded para preguntas frecuentes.</li>
                    <li>Step con <strong>Pausas &gt;5</strong>: bug en el handler o falta una rama lógica.</li>
                </ul>
            </InfoBox>

            <Card padding="none" className="overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 dark:bg-slate-800/40 text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
                            <tr>
                                <th className="text-left px-4 py-2.5">Step</th>
                                <th className="text-right px-4 py-2.5">Mensajes</th>
                                <th className="text-right px-4 py-2.5">Retries %</th>
                                <th className="text-right px-4 py-2.5">Retry 2-3x</th>
                                <th className="text-right px-4 py-2.5">Retry 4+x</th>
                                <th className="text-right px-4 py-2.5">AI fallback %</th>
                                <th className="text-right px-4 py-2.5">Pausas</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {merged.map(g => (
                                <tr key={g.step} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200 font-medium">{STEP_LABELS[g.step] || g.step}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-slate-600 dark:text-slate-300">{g.total || g.msgs || 0}</td>
                                    <td className={cn(
                                        'text-right px-4 py-2 font-medium tabular-nums',
                                        g.retryRate > 40 ? 'text-danger-600 dark:text-danger-500'
                                        : g.retryRate > 20 ? 'text-warning-600 dark:text-warning-500'
                                        : 'text-slate-500 dark:text-slate-400'
                                    )}>
                                        {g.retryRate != null ? `${g.retryRate}%` : '—'}
                                    </td>
                                    <td className="text-right px-4 py-2 tabular-nums text-warning-600 dark:text-warning-500">{g.b2_3}</td>
                                    <td className={cn(
                                        'text-right px-4 py-2 font-medium tabular-nums',
                                        g.b4plus > 0 ? 'text-danger-600 dark:text-danger-500' : 'text-slate-400 dark:text-slate-500'
                                    )}>{g.b4plus}</td>
                                    <td className={cn(
                                        'text-right px-4 py-2 font-medium tabular-nums',
                                        g.aiRate > 60 ? 'text-danger-600 dark:text-danger-500'
                                        : g.aiRate > 30 ? 'text-warning-600 dark:text-warning-500'
                                        : 'text-slate-500 dark:text-slate-400'
                                    )}>
                                        {g.aiRate != null ? `${g.aiRate}%` : '—'}
                                    </td>
                                    <td className={cn(
                                        'text-right px-4 py-2 font-medium tabular-nums',
                                        g.pauseCount > 5 ? 'text-danger-600 dark:text-danger-500'
                                        : g.pauseCount > 0 ? 'text-warning-600 dark:text-warning-500'
                                        : 'text-slate-400 dark:text-slate-500'
                                    )}>
                                        {g.pauseCount || '—'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
}

// ─── TAB: PRODUCTO ──────────────────────────────────────────────
function ProductTab({ mix }) {
    if (!mix || mix.total === 0) {
        return (
            <Card padding="lg">
                <EmptyState
                    icon={Package}
                    title="Sin órdenes"
                    description="No hay órdenes cerradas en el rango seleccionado."
                />
            </Card>
        );
    }

    const paymentLabel = (p) => ({
        mercadopago: 'MercadoPago',
        transferencia: 'Transferencia',
        contrarembolso: 'Contrareembolso',
    }[p] || p);

    const formatArs = (n) => `$${Math.round(n).toLocaleString('es-AR').replace(/,/g, '.')}`;

    const byProduct = mix.mix.reduce((acc, r) => {
        if (!acc[r.product]) acc[r.product] = { count: 0, revenue: 0 };
        acc[r.product].count += r.count;
        acc[r.product].revenue += r.revenue;
        return acc;
    }, {});

    return (
        <div className="space-y-4">
            <InfoBox>
                <p><strong>Qué estás viendo.</strong> Qué productos, en qué plan, y con qué método de pago se están vendiendo de verdad. No incluye ventas canceladas.</p>
                <p><strong>Ticket promedio.</strong> Precio promedio de una venta en esa combinación (incluye adicional MAX si aplica).</p>
            </InfoBox>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <UiKpiCard label="Órdenes totales" value={mix.total} subtext="Ventas cerradas en el rango" tone="success" />
                {Object.entries(byProduct).slice(0, 3).map(([prod, g]) => (
                    <UiKpiCard
                        key={prod}
                        label={prod}
                        value={`${g.count} (${((g.count / mix.total) * 100).toFixed(0)}%)`}
                        subtext={formatArs(g.revenue) + ' facturado'}
                        tone="accent"
                    />
                ))}
            </div>

            <Card padding="none" className="overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Mix de producto × plan × pago</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        Ordenado por cantidad de órdenes.
                    </p>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 dark:bg-slate-800/40 text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
                            <tr>
                                <th className="text-left px-4 py-2.5">Producto</th>
                                <th className="text-left px-4 py-2.5">Plan</th>
                                <th className="text-left px-4 py-2.5">Pago</th>
                                <th className="text-right px-4 py-2.5">Órdenes</th>
                                <th className="text-right px-4 py-2.5">Share</th>
                                <th className="text-right px-4 py-2.5">Ticket prom.</th>
                                <th className="text-right px-4 py-2.5">Ingreso</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {mix.mix.map((r, i) => (
                                <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200 font-medium">{r.product}</td>
                                    <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{r.plan}</td>
                                    <td className="px-4 py-2 text-slate-500 dark:text-slate-400">{paymentLabel(r.paymentMethod)}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-slate-700 dark:text-slate-200 font-semibold">{r.count}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{r.share}%</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{formatArs(r.avgTicket)}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-success-600 dark:text-success-500 font-semibold">{formatArs(r.revenue)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
}

// ─── TAB: TÉCNICO ───────────────────────────────────────────────
function TechTab({ cache, aiFallback }) {
    const rows = useMemo(() => {
        const map = new Map();
        (cache?.byStep || []).forEach(r => {
            map.set(r.step, { ...r, aiCalls: 0, messages: r.messagesInRange || 0 });
        });
        (aiFallback?.byStep || []).forEach(r => {
            const existing = map.get(r.step) || { step: r.step, cachedEntries: 0, totalHits: 0, messagesInRange: 0, avgHitsPerEntry: 0 };
            existing.aiCalls = r.aiCallCount;
            existing.messages = r.messageCount;
            map.set(r.step, existing);
        });
        return Array.from(map.values()).sort((a, b) => b.totalHits - a.totalHits);
    }, [cache, aiFallback]);

    if (!rows.length) {
        return (
            <Card padding="lg">
                <EmptyState
                    icon={Cpu}
                    title="Sin datos técnicos"
                    description="Sin datos técnicos en el rango seleccionado."
                />
            </Card>
        );
    }

    return (
        <div className="space-y-4">
            <InfoBox>
                <p><strong>Qué estás viendo.</strong> El bot tiene un <em>caché semántico</em>: cuando un cliente pregunta algo parecido a otra cosa ya respondida, le sirve la respuesta guardada en lugar de gastar tokens en GPT. Esta vista mide qué tan bien funciona en cada step.</p>
                <p><strong>Columnas.</strong> <strong>Mensajes</strong> = turnos del cliente en el rango. <strong>AI calls</strong> = veces que sí hubo que llamar a GPT. <strong>Cache entries</strong> = respuestas distintas almacenadas. <strong>Total hits</strong> = veces que se reutilizaron (histórico, no filtrado al rango).</p>
            </InfoBox>

            <InfoBox variant="tip">
                <p><strong>¿Qué hacer con esto?</strong></p>
                <ul className="list-disc ml-5 space-y-0.5">
                    <li><strong>Muchos AI calls + pocos cache entries</strong> → la gente pregunta cosas únicas, el caché no ayuda. Hardcodear las más comunes.</li>
                    <li><strong>Muchos cache entries + pocos hits</strong> → estamos guardando respuestas que nadie repite. Consume memoria sin ahorrar.</li>
                    <li><strong>Hits / entry &gt;5</strong> → excelente, el caché está ahorrando OpenAI.</li>
                </ul>
            </InfoBox>

            <Card padding="none" className="overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 dark:bg-slate-800/40 text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
                            <tr>
                                <th className="text-left px-4 py-2.5">Step</th>
                                <th className="text-right px-4 py-2.5">Mensajes</th>
                                <th className="text-right px-4 py-2.5">AI calls</th>
                                <th className="text-right px-4 py-2.5">Cache entries</th>
                                <th className="text-right px-4 py-2.5">Total hits</th>
                                <th className="text-right px-4 py-2.5">Hits / entry</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {rows.map(r => (
                                <tr key={r.step} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200 font-medium">{STEP_LABELS[r.step] || r.step}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-slate-600 dark:text-slate-300">{r.messages || 0}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-accent-600 dark:text-accent-400">{r.aiCalls || 0}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{r.cachedEntries || 0}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-success-600 dark:text-success-500 font-semibold">{r.totalHits || 0}</td>
                                    <td className="text-right px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">{r.avgHitsPerEntry || 0}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </Card>
        </div>
    );
}

export default FunnelAnalyticsView;
