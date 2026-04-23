import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../config/axios';
import { useToast } from '../ui/Toast';
import {
    Activity, TrendingDown, Clock, PauseCircle, Repeat, Package, Cpu,
    RefreshCw, AlertTriangle, Timer, ChevronRight
} from 'lucide-react';

// Map de steps a labels humanos cortos (para gráficos).
const STEP_LABELS = {
    greeting: 'Saludo',
    general: 'General',
    waiting_weight: 'Peso',
    waiting_preference: 'Preferencia',
    waiting_preference_consultation: 'Consulta pref.',
    waiting_plan_choice: 'Plan',
    waiting_price_confirmation: 'Confirm. precio',
    waiting_ok: 'OK',
    waiting_data: 'Datos',
    waiting_maps_confirmation: 'Maps',
    waiting_payment_method: 'Pago',
    waiting_mp_payment: 'MP',
    waiting_transfer_confirmation: 'Transferencia',
    waiting_final_confirmation: 'Conf. final',
    waiting_admin_ok: 'Admin OK',
    waiting_admin_validation: 'Admin valid.',
    closing: 'Cierre',
    completed: 'Completado',
    post_sale: 'Post-venta',
    safety_check: 'Safety',
    rejected_medical: '❌ Médico',
    rejected_abusive: '❌ Abusivo',
    rejected_geo: '❌ Geo',
};

// Orden canónico (igual que funnelLogger.ts)
const STEP_ORDER = [
    'greeting', 'general', 'waiting_weight', 'waiting_preference',
    'waiting_preference_consultation', 'waiting_plan_choice',
    'waiting_price_confirmation', 'waiting_ok', 'waiting_data',
    'waiting_maps_confirmation', 'waiting_payment_method', 'waiting_mp_payment',
    'waiting_transfer_confirmation', 'waiting_final_confirmation',
    'waiting_admin_ok', 'waiting_admin_validation', 'closing', 'completed',
];

const TABS = [
    { id: 'funnel', label: 'Embudo', icon: TrendingDown },
    { id: 'friction', label: 'Fricción', icon: AlertTriangle },
    { id: 'conversion', label: 'Conversión', icon: Timer },
    { id: 'product', label: 'Producto', icon: Package },
    { id: 'tech', label: 'Técnico', icon: Cpu },
];

function formatDur(sec) {
    if (!sec || sec <= 0) return '—';
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    if (sec < 86400) return `${Math.round(sec / 3600 * 10) / 10}h`;
    return `${Math.round(sec / 86400 * 10) / 10}d`;
}

const FunnelAnalyticsView = () => {
    const { toast } = useToast();
    const [tab, setTab] = useState('funnel');
    const [daysBack, setDaysBack] = useState(7);
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
            setFunnel(f.data);
            setPauseAlerts(p.data);
            setTtc(t.data);
            setReentries(r.data);
            setRetries(ret.data);
            setAiFallback(aif.data);
            setPriceObj(po.data);
            setAbandonment(ab.data);
            setProductMix(pm.data);
            setCacheHits(ch.data);
        } catch (e) {
            toast.error('Error cargando analítica: ' + (e.response?.data?.error || e.message));
        } finally {
            setLoading(false);
        }
    }, [daysBack, toast]);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    // Ordenar steps del funnel por orden canónico.
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
        <div className="p-6 md:p-8 w-full max-w-7xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center">
                            <Activity className="w-5 h-5 text-white" />
                        </div>
                        Analítica de Embudo
                    </h2>
                    <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
                        Dónde se traban las conversaciones y cómo mejorar la conversión
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <select
                        value={daysBack}
                        onChange={e => setDaysBack(parseInt(e.target.value))}
                        className="px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-700 dark:text-slate-200"
                    >
                        <option value={1}>Últimas 24h</option>
                        <option value={7}>Últimos 7 días</option>
                        <option value={30}>Últimos 30 días</option>
                        <option value={90}>Últimos 90 días</option>
                    </select>
                    <button
                        onClick={fetchAll}
                        disabled={loading}
                        className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 transition-colors"
                        title="Recargar"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-200 dark:border-slate-700 mb-6 overflow-x-auto">
                {TABS.map(t => {
                    const Icon = t.icon;
                    const isActive = tab === t.id;
                    const isDisabled = t.disabled;
                    return (
                        <button
                            key={t.id}
                            onClick={() => !isDisabled && setTab(t.id)}
                            disabled={isDisabled}
                            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
                                isActive
                                    ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                                    : isDisabled
                                        ? 'border-transparent text-slate-300 dark:text-slate-600 cursor-not-allowed'
                                        : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                            }`}
                        >
                            <Icon className="w-4 h-4" />
                            {t.label}
                            {isDisabled && <span className="text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">{t.soon}</span>}
                        </button>
                    );
                })}
            </div>

            {/* Content */}
            {loading && !funnel ? (
                <div className="flex items-center justify-center py-20">
                    <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                </div>
            ) : tab === 'funnel' ? (
                <FunnelTab
                    orderedFunnel={orderedFunnel}
                    maxEntered={maxEntered}
                    pauseAlerts={pauseAlerts}
                    reentries={reentries}
                />
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
const FunnelTab = ({ orderedFunnel, maxEntered, pauseAlerts, reentries }) => {
    const pauseMap = useMemo(
        () => Object.fromEntries((pauseAlerts?.byStep || []).map(r => [r.step, r.count])),
        [pauseAlerts]
    );

    if (!orderedFunnel.length) {
        return (
            <div className="text-center py-20 text-slate-400 dark:text-slate-500">
                <TrendingDown className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">Sin datos en el rango seleccionado.</p>
                <p className="text-xs mt-1">Los eventos se registran desde el último deploy. Dale tiempo al bot para acumular.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Bar chart vertical */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
                <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm mb-4">Drop-off por step</h3>
                <div className="space-y-2">
                    {orderedFunnel.map(s => {
                        const widthPct = Math.max(3, (s.entered / maxEntered) * 100);
                        const dropPct = s.dropRate;
                        const alertCount = pauseMap[s.step] || 0;
                        return (
                            <div key={s.step} className="group">
                                <div className="flex items-center gap-3">
                                    <div className="w-32 flex-shrink-0 text-xs text-slate-600 dark:text-slate-300 truncate">
                                        {STEP_LABELS[s.step] || s.step}
                                    </div>
                                    <div className="flex-1 relative h-7 bg-slate-100 dark:bg-slate-900 rounded-md overflow-hidden">
                                        <div
                                            className="absolute inset-y-0 left-0 bg-gradient-to-r from-indigo-500 to-sky-500 transition-all"
                                            style={{ width: `${widthPct}%` }}
                                        />
                                        <div className="absolute inset-0 flex items-center px-3 text-xs font-medium text-white drop-shadow">
                                            {s.entered} entraron
                                        </div>
                                    </div>
                                    <div className="w-20 text-right text-xs">
                                        <span className={dropPct > 30 ? 'text-red-500 font-bold' : dropPct > 15 ? 'text-amber-500' : 'text-slate-400'}>
                                            {dropPct}% drop
                                        </span>
                                    </div>
                                    {alertCount > 0 && (
                                        <div className="w-20 text-right text-xs text-amber-600 dark:text-amber-400 flex items-center justify-end gap-1">
                                            <PauseCircle className="w-3 h-3" />
                                            {alertCount}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Tabla detalle */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700">
                    <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">Detalle por step</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400">
                            <tr>
                                <th className="text-left px-4 py-3 font-medium">Step</th>
                                <th className="text-right px-4 py-3 font-medium">Entraron</th>
                                <th className="text-right px-4 py-3 font-medium">Avanzaron</th>
                                <th className="text-right px-4 py-3 font-medium">Volvieron</th>
                                <th className="text-right px-4 py-3 font-medium">Pausados</th>
                                <th className="text-right px-4 py-3 font-medium">Cayeron</th>
                                <th className="text-right px-4 py-3 font-medium">Drop %</th>
                                <th className="text-right px-4 py-3 font-medium">Tiempo p50</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                            {orderedFunnel.map(s => (
                                <tr key={s.step} className="hover:bg-slate-50 dark:hover:bg-slate-900/30">
                                    <td className="px-4 py-3 text-slate-700 dark:text-slate-200 font-medium">{STEP_LABELS[s.step] || s.step}</td>
                                    <td className="text-right px-4 py-3 text-slate-600 dark:text-slate-300">{s.entered}</td>
                                    <td className="text-right px-4 py-3 text-emerald-600 dark:text-emerald-400">{s.advanced}</td>
                                    <td className="text-right px-4 py-3 text-amber-500">{s.back}</td>
                                    <td className="text-right px-4 py-3 text-orange-500">{s.paused}</td>
                                    <td className="text-right px-4 py-3 text-red-500">{s.dropped}</td>
                                    <td className={`text-right px-4 py-3 font-medium ${s.dropRate > 30 ? 'text-red-500' : s.dropRate > 15 ? 'text-amber-500' : 'text-slate-500'}`}>
                                        {s.dropRate}%
                                    </td>
                                    <td className="text-right px-4 py-3 text-slate-500 dark:text-slate-400">{formatDur(s.medianTimeSec)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Reentradas */}
            {reentries?.transitions?.length > 0 && (
                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
                    <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm mb-4 flex items-center gap-2">
                        <Repeat className="w-4 h-4 text-amber-500" />
                        Top retrocesos (el usuario volvió atrás en el flujo)
                    </h3>
                    <div className="space-y-2">
                        {reentries.transitions.slice(0, 10).map((t, i) => (
                            <div key={i} className="flex items-center gap-2 text-sm p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900/30">
                                <span className="text-slate-600 dark:text-slate-300 w-40 truncate">{STEP_LABELS[t.from] || t.from}</span>
                                <ChevronRight className="w-4 h-4 text-slate-400" />
                                <span className="text-slate-600 dark:text-slate-300 w-40 truncate">{STEP_LABELS[t.to] || t.to}</span>
                                <span className="ml-auto text-slate-500 dark:text-slate-400 font-medium">{t.count}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

// ─── TAB: CONVERSIÓN ────────────────────────────────────────────
const ConversionTab = ({ ttc, priceObj, abandonment }) => {
    const maxHourCount = useMemo(
        () => Math.max(1, ...(abandonment?.byHour?.map(h => h.count) || [0])),
        [abandonment]
    );

    return (
        <div className="space-y-6">
            {/* KPI cards de tiempo a cierre */}
            {ttc && ttc.total > 0 ? (
                <>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <KpiCard label="Cierres totales" value={ttc.total} />
                        <KpiCard label="Tiempo mediano (p50)" value={formatDur(ttc.p50)} hint="Mitad cerró antes" />
                        <KpiCard label="p90" value={formatDur(ttc.p90)} hint="90% cerró antes" />
                        <KpiCard label="p99" value={formatDur(ttc.p99)} hint="Casos más largos" />
                    </div>

                    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
                        <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm mb-4">Distribución del tiempo a cierre</h3>
                        <div className="space-y-2">
                            {ttc.histogram.map(b => {
                                const pct = ttc.total > 0 ? (b.count / ttc.total) * 100 : 0;
                                return (
                                    <div key={b.label} className="flex items-center gap-3">
                                        <div className="w-20 text-xs text-slate-600 dark:text-slate-300">{b.label}</div>
                                        <div className="flex-1 relative h-6 bg-slate-100 dark:bg-slate-900 rounded-md overflow-hidden">
                                            <div
                                                className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-sky-500"
                                                style={{ width: `${Math.max(2, pct)}%` }}
                                            />
                                        </div>
                                        <div className="w-24 text-right text-xs text-slate-500 dark:text-slate-400">
                                            {b.count} ({pct.toFixed(1)}%)
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </>
            ) : (
                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 shadow-sm text-center text-sm text-slate-400 dark:text-slate-500">
                    Aún no hay cierres en el rango seleccionado.
                </div>
            )}

            {/* Abandonos por hora (AR) */}
            {abandonment && abandonment.total > 0 && (
                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
                    <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm mb-1">Abandonos por hora (Argentina)</h3>
                    <p className="text-xs text-slate-400 dark:text-slate-500 mb-4">Hora en que el usuario envió su último mensaje antes de dejar de responder. Total: {abandonment.total}</p>
                    <div className="flex items-end gap-1 h-32">
                        {abandonment.byHour.map(h => {
                            const heightPct = (h.count / maxHourCount) * 100;
                            return (
                                <div key={h.hour} className="flex-1 flex flex-col items-center gap-1" title={`${h.hour}:00 — ${h.count} abandonos`}>
                                    <div className="flex-1 w-full flex items-end">
                                        <div
                                            className="w-full bg-gradient-to-t from-rose-500 to-orange-400 rounded-t-md transition-all"
                                            style={{ height: `${Math.max(2, heightPct)}%` }}
                                        />
                                    </div>
                                    <div className="text-[10px] text-slate-400 dark:text-slate-500">{h.hour}</div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Objeciones de precio por step */}
            {priceObj && priceObj.byStep?.length > 0 && (
                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
                    <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm mb-1">Objeciones de precio por step</h3>
                    <p className="text-xs text-slate-400 dark:text-slate-500 mb-4">Mensajes donde el usuario mencionó precio, descuento, o falta de plata</p>
                    <div className="space-y-2">
                        {priceObj.byStep.map(s => (
                            <div key={s.step} className="flex items-center gap-3 text-sm">
                                <div className="w-40 text-slate-600 dark:text-slate-300 truncate">{STEP_LABELS[s.step] || s.step}</div>
                                <div className="flex-1 relative h-5 bg-slate-100 dark:bg-slate-900 rounded-md overflow-hidden">
                                    <div
                                        className="absolute inset-y-0 left-0 bg-amber-400"
                                        style={{ width: `${Math.min(100, s.rate)}%` }}
                                    />
                                </div>
                                <div className="w-32 text-right text-xs text-slate-500 dark:text-slate-400">
                                    {s.objectionCount} ({s.rate}%)
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

// ─── TAB: FRICCIÓN ────────────────────────────────────────────
const FrictionTab = ({ retries, aiFallback, pauseAlerts }) => {
    // Merge todo por step para una sola tabla de fricción.
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
            g.msgs = r.messageCount;
            g.aiCalls = r.aiCallCount;
            g.aiRate = r.aiFallbackRate;
        });
        (pauseAlerts?.byStep || []).forEach(r => {
            const g = ensure(r.step);
            g.pauseCount = r.count;
        });
        return Array.from(map.values())
            .sort((a, b) => {
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
            <div className="text-center py-20 text-slate-400 dark:text-slate-500">
                <AlertTriangle className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">Sin datos de fricción en el rango seleccionado.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Leyenda */}
            <div className="bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 rounded-xl p-4 text-xs text-slate-500 dark:text-slate-400">
                <span className="font-medium text-slate-600 dark:text-slate-300">Cómo leer:</span>
                {' '}Retries = mensajes donde el bot tuvo que re-preguntar lo mismo.
                {' '}AI fallback = porcentaje de respuestas que no matchearon y cayeron a GPT.
                {' '}Pausas = veces que el bot "se rindió" y alertó al admin.
                {' '}Valores altos en rojo indican candidatos a mejorar.
            </div>

            {/* Tabla combinada */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400">
                            <tr>
                                <th className="text-left px-4 py-3 font-medium">Step</th>
                                <th className="text-right px-4 py-3 font-medium">Mensajes</th>
                                <th className="text-right px-4 py-3 font-medium">Retries %</th>
                                <th className="text-right px-4 py-3 font-medium">Retry 2-3x</th>
                                <th className="text-right px-4 py-3 font-medium">Retry 4+x</th>
                                <th className="text-right px-4 py-3 font-medium">AI fallback %</th>
                                <th className="text-right px-4 py-3 font-medium">Pausas</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                            {merged.map(g => (
                                <tr key={g.step} className="hover:bg-slate-50 dark:hover:bg-slate-900/30">
                                    <td className="px-4 py-3 text-slate-700 dark:text-slate-200 font-medium">{STEP_LABELS[g.step] || g.step}</td>
                                    <td className="text-right px-4 py-3 text-slate-600 dark:text-slate-300">{g.total || g.msgs || 0}</td>
                                    <td className={`text-right px-4 py-3 font-medium ${g.retryRate > 40 ? 'text-red-500' : g.retryRate > 20 ? 'text-amber-500' : 'text-slate-500'}`}>
                                        {g.retryRate != null ? `${g.retryRate}%` : '—'}
                                    </td>
                                    <td className="text-right px-4 py-3 text-amber-500">{g.b2_3}</td>
                                    <td className={`text-right px-4 py-3 font-medium ${g.b4plus > 0 ? 'text-red-500' : 'text-slate-400'}`}>{g.b4plus}</td>
                                    <td className={`text-right px-4 py-3 font-medium ${g.aiRate > 60 ? 'text-red-500' : g.aiRate > 30 ? 'text-amber-500' : 'text-slate-500'}`}>
                                        {g.aiRate != null ? `${g.aiRate}%` : '—'}
                                    </td>
                                    <td className={`text-right px-4 py-3 font-medium ${g.pauseCount > 5 ? 'text-red-500' : g.pauseCount > 0 ? 'text-amber-500' : 'text-slate-400'}`}>
                                        {g.pauseCount || '—'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

// ─── TAB: PRODUCTO ──────────────────────────────────────────────
const ProductTab = ({ mix }) => {
    if (!mix || mix.total === 0) {
        return (
            <div className="text-center py-20 text-slate-400 dark:text-slate-500">
                <Package className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">No hay órdenes cerradas en el rango seleccionado.</p>
            </div>
        );
    }

    const paymentLabel = (p) => ({
        mercadopago: 'MercadoPago',
        transferencia: 'Transferencia',
        contrarembolso: 'Contrareembolso',
    }[p] || p);

    const formatArs = (n) => `$${Math.round(n).toLocaleString('es-AR').replace(/,/g, '.')}`;

    // Totales por producto
    const byProduct = mix.mix.reduce((acc, r) => {
        if (!acc[r.product]) acc[r.product] = { count: 0, revenue: 0 };
        acc[r.product].count += r.count;
        acc[r.product].revenue += r.revenue;
        return acc;
    }, {});

    return (
        <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <KpiCard label="Órdenes totales" value={mix.total} />
                {Object.entries(byProduct).slice(0, 3).map(([prod, g]) => (
                    <KpiCard
                        key={prod}
                        label={prod}
                        value={`${g.count} (${((g.count / mix.total) * 100).toFixed(0)}%)`}
                        hint={formatArs(g.revenue)}
                    />
                ))}
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700">
                    <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm">Mix de producto × plan × pago</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400">
                            <tr>
                                <th className="text-left px-4 py-3 font-medium">Producto</th>
                                <th className="text-left px-4 py-3 font-medium">Plan</th>
                                <th className="text-left px-4 py-3 font-medium">Pago</th>
                                <th className="text-right px-4 py-3 font-medium">Órdenes</th>
                                <th className="text-right px-4 py-3 font-medium">Share</th>
                                <th className="text-right px-4 py-3 font-medium">Ticket prom.</th>
                                <th className="text-right px-4 py-3 font-medium">Ingreso</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                            {mix.mix.map((r, i) => (
                                <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-900/30">
                                    <td className="px-4 py-3 text-slate-700 dark:text-slate-200 font-medium">{r.product}</td>
                                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{r.plan}</td>
                                    <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{paymentLabel(r.paymentMethod)}</td>
                                    <td className="text-right px-4 py-3 text-slate-700 dark:text-slate-200 font-medium">{r.count}</td>
                                    <td className="text-right px-4 py-3 text-slate-500 dark:text-slate-400">{r.share}%</td>
                                    <td className="text-right px-4 py-3 text-slate-500 dark:text-slate-400">{formatArs(r.avgTicket)}</td>
                                    <td className="text-right px-4 py-3 text-emerald-600 dark:text-emerald-400 font-medium">{formatArs(r.revenue)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

// ─── TAB: TÉCNICO ───────────────────────────────────────────────
const TechTab = ({ cache, aiFallback }) => {
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
            <div className="text-center py-20 text-slate-400 dark:text-slate-500">
                <Cpu className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">Sin datos técnicos en el rango seleccionado.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-800 rounded-xl p-4 text-xs text-sky-700 dark:text-sky-300">
                <strong>Tip:</strong> Steps con <strong>muchos AI calls</strong> y <strong>pocos cache hits</strong> son candidatos a mover FAQs frecuentes a reglas hardcodeadas
                (o a pre-cachear respuestas). El `hits` del cache es histórico (no filtrado por rango de fechas), se muestra como referencia relativa.
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400">
                            <tr>
                                <th className="text-left px-4 py-3 font-medium">Step</th>
                                <th className="text-right px-4 py-3 font-medium">Mensajes</th>
                                <th className="text-right px-4 py-3 font-medium">AI calls</th>
                                <th className="text-right px-4 py-3 font-medium">Cache entries</th>
                                <th className="text-right px-4 py-3 font-medium">Total hits (histórico)</th>
                                <th className="text-right px-4 py-3 font-medium">Hits / entry</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                            {rows.map(r => (
                                <tr key={r.step} className="hover:bg-slate-50 dark:hover:bg-slate-900/30">
                                    <td className="px-4 py-3 text-slate-700 dark:text-slate-200 font-medium">{STEP_LABELS[r.step] || r.step}</td>
                                    <td className="text-right px-4 py-3 text-slate-600 dark:text-slate-300">{r.messages || 0}</td>
                                    <td className="text-right px-4 py-3 text-indigo-600 dark:text-indigo-400">{r.aiCalls || 0}</td>
                                    <td className="text-right px-4 py-3 text-slate-500 dark:text-slate-400">{r.cachedEntries || 0}</td>
                                    <td className="text-right px-4 py-3 text-emerald-600 dark:text-emerald-400 font-medium">{r.totalHits || 0}</td>
                                    <td className="text-right px-4 py-3 text-slate-500 dark:text-slate-400">{r.avgHitsPerEntry || 0}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

const KpiCard = ({ label, value, hint }) => (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 shadow-sm">
        <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">{label}</div>
        <div className="text-2xl font-bold text-slate-800 dark:text-slate-100 mt-1">{value}</div>
        {hint && <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">{hint}</div>}
    </div>
);

export default FunnelAnalyticsView;
