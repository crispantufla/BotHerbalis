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
    { id: 'friction', label: 'Fricción', icon: AlertTriangle, disabled: true, soon: 'Fase 2' },
    { id: 'conversion', label: 'Conversión', icon: Timer },
    { id: 'product', label: 'Producto', icon: Package, disabled: true, soon: 'Fase 4' },
    { id: 'tech', label: 'Técnico', icon: Cpu, disabled: true, soon: 'Fase 5' },
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

    const fetchAll = useCallback(async () => {
        setLoading(true);
        try {
            const qs = `?days=${daysBack}`;
            const [f, p, t, r] = await Promise.all([
                api.get('/api/analytics/funnel' + qs),
                api.get('/api/analytics/pause-alerts' + qs),
                api.get('/api/analytics/time-to-close' + qs),
                api.get('/api/analytics/reentries' + qs),
            ]);
            setFunnel(f.data);
            setPauseAlerts(p.data);
            setTtc(t.data);
            setReentries(r.data);
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
            ) : tab === 'conversion' ? (
                <ConversionTab ttc={ttc} />
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
const ConversionTab = ({ ttc }) => {
    if (!ttc || ttc.total === 0) {
        return (
            <div className="text-center py-20 text-slate-400 dark:text-slate-500">
                <Clock className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">Aún no hay cierres en el rango seleccionado.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* KPI cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <KpiCard label="Cierres totales" value={ttc.total} />
                <KpiCard label="Tiempo mediano (p50)" value={formatDur(ttc.p50)} hint="Mitad cerró antes" />
                <KpiCard label="p90" value={formatDur(ttc.p90)} hint="90% cerró antes" />
                <KpiCard label="p99" value={formatDur(ttc.p99)} hint="Casos más largos" />
            </div>

            {/* Histogram */}
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
