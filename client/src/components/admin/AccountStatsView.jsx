import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../config/axios';
import { useToast } from '../ui/Toast';
import {
    BarChart3, Clock, RefreshCw, Users, Grid3x3, Flame,
    HelpCircle, ChevronDown, ChevronUp, Info
} from 'lucide-react';

const WEEKDAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function formatDur(sec) {
    if (!sec || sec <= 0) return '—';
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatDate(ymd) {
    // "2026-04-24" → "24/04"
    const [, m, d] = ymd.split('-');
    return `${d}/${m}`;
}

// Paleta rotativa para diferenciar vendedores.
const PALETTE = [
    'bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500',
    'bg-sky-500', 'bg-purple-500', 'bg-teal-500', 'bg-orange-500',
];
const colorFor = (i) => PALETTE[i % PALETTE.length];

const AccountStatsView = () => {
    const { toast } = useToast();
    const [daysBack, setDaysBack] = useState(7);
    const [loading, setLoading] = useState(false);
    const [daily, setDaily] = useState(null);
    const [totals, setTotals] = useState(null);
    const [heatmap, setHeatmap] = useState(null);
    const [heatmapSeller, setHeatmapSeller] = useState(''); // '' = todos
    const [showHowTo, setShowHowTo] = useState(false);

    const fetchAll = useCallback(async () => {
        setLoading(true);
        try {
            const qs = `?days=${daysBack}`;
            const [d, t, h] = await Promise.all([
                api.get('/api/accounts/stats/daily' + qs),
                api.get('/api/accounts/stats/totals' + qs),
                api.get('/api/accounts/stats/heatmap' + qs),
            ]);
            setDaily(d.data);
            setTotals(t.data);
            setHeatmap(h.data);
        } catch (e) {
            toast.error('Error cargando stats: ' + (e.response?.data?.error || e.message));
        } finally {
            setLoading(false);
        }
    }, [daysBack, toast]);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    return (
        <div className="p-6 md:p-8 w-full max-w-7xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-600 flex items-center justify-center">
                            <BarChart3 className="w-5 h-5 text-white" />
                        </div>
                        Horas de Vendedores
                    </h2>
                    <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
                        Cuánto tiempo cada vendedor tuvo el panel abierto y en qué horarios
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <select
                        value={daysBack}
                        onChange={e => setDaysBack(parseInt(e.target.value))}
                        className="px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-700 dark:text-slate-200"
                    >
                        <option value={7}>Últimos 7 días</option>
                        <option value={14}>Últimos 14 días</option>
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

            {/* Cómo leer */}
            <div className="mb-6">
                <button
                    onClick={() => setShowHowTo(v => !v)}
                    className="w-full flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                >
                    <HelpCircle className="w-4 h-4" />
                    ¿Cómo se calcula esto?
                    {showHowTo ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                {showHowTo && (
                    <div className="mt-3 bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-800/50 rounded-xl p-4 text-sm text-sky-900 dark:text-sky-100 space-y-2">
                        <p>
                            Una <strong>sesión</strong> empieza cuando un vendedor abre el panel web y termina cuando cierra la pestaña
                            o queda más de 10 minutos sin interactuar (pasa a <em>idle</em>). Cada sesión se guarda en la base
                            con inicio, fin y duración.
                        </p>
                        <p>
                            Horario mostrado: <strong>Argentina (UTC-3)</strong>. Sesiones que cruzan de un día al otro se dividen en cada día
                            que les corresponde.
                        </p>
                    </div>
                )}
            </div>

            {loading && !totals ? (
                <div className="flex items-center justify-center py-20">
                    <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                </div>
            ) : (
                <div className="space-y-8">
                    <TotalsSection totals={totals} />
                    <DailySection daily={daily} />
                    <HeatmapSection
                        heatmap={heatmap}
                        selectedSeller={heatmapSeller}
                        onSelectSeller={setHeatmapSeller}
                    />
                </div>
            )}
        </div>
    );
};

// ─── 1. TOTALES (KPI cards) ─────────────────────────────────────
const TotalsSection = ({ totals }) => {
    if (!totals?.accounts?.length) {
        return (
            <section className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 text-center text-sm text-slate-400 dark:text-slate-500">
                <Clock className="w-10 h-10 mx-auto mb-2 opacity-50" />
                Sin sesiones registradas en el rango seleccionado.
            </section>
        );
    }

    return (
        <section>
            <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm flex items-center gap-2">
                    <Users className="w-4 h-4" /> Totales por vendedor
                </h3>
                <span className="text-xs text-slate-400 dark:text-slate-500">{totals.days} días — {totals.accounts.length} usuario(s)</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {totals.accounts.map((a, i) => (
                    <div key={a.id} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 shadow-sm">
                        <div className="flex items-center gap-2 mb-2">
                            <div className={`w-2 h-2 rounded-full ${colorFor(i)}`} />
                            <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm truncate capitalize">{a.name}</span>
                            {a.role === 'admin' && (
                                <span className="text-[10px] bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded">admin</span>
                            )}
                        </div>
                        <div className="text-2xl font-bold text-slate-800 dark:text-slate-100">{formatDur(a.totalSeconds)}</div>
                        <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                            <span title="Cantidad de sesiones">{a.sessionCount} sesiones</span>
                            <span title="Duración promedio por sesión">prom {formatDur(a.avgSessionSeconds)}</span>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
};

// ─── 2. HORAS POR DÍA × VENDEDOR ────────────────────────────────
const DailySection = ({ daily }) => {
    const maxPerDay = useMemo(() => {
        if (!daily?.accounts?.length) return 1;
        let max = 0;
        for (const day of daily.days) {
            let sumDay = 0;
            for (const acc of daily.accounts) sumDay += acc.byDay[day] || 0;
            if (sumDay > max) max = sumDay;
        }
        return Math.max(1, max);
    }, [daily]);

    if (!daily?.accounts?.length) return null;

    return (
        <section className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <div className="flex items-start justify-between mb-1 gap-2">
                <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm flex items-center gap-2">
                    <BarChart3 className="w-4 h-4" /> Horas por día (apiladas por vendedor)
                </h3>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 mb-4">
                Cada barra es un día. Los colores apilados son distintos vendedores. La altura total = suma de todos los que estuvieron conectados ese día.
            </p>

            {/* Gráfico de barras apiladas */}
            <div className="flex items-end gap-1 h-48 mb-3">
                {daily.days.map(day => {
                    const bySeller = daily.accounts.map(acc => ({
                        id: acc.id, name: acc.name, seconds: acc.byDay[day] || 0,
                    }));
                    const totalDay = bySeller.reduce((a, b) => a + b.seconds, 0);
                    const heightPct = (totalDay / maxPerDay) * 100;

                    return (
                        <div key={day} className="flex-1 flex flex-col items-center gap-1 group" title={`${day} — ${formatDur(totalDay)} total`}>
                            <div className="flex-1 w-full flex items-end">
                                <div className="w-full flex flex-col-reverse rounded-t-md overflow-hidden" style={{ height: `${Math.max(2, heightPct)}%` }}>
                                    {bySeller.map((s) => {
                                        const segPct = totalDay > 0 ? (s.seconds / totalDay) * 100 : 0;
                                        return (
                                            <div
                                                key={s.id}
                                                className={`${colorFor(daily.accounts.findIndex(a => a.id === s.id))} transition-opacity group-hover:opacity-90`}
                                                style={{ height: `${segPct}%` }}
                                                title={`${s.name}: ${formatDur(s.seconds)}`}
                                            />
                                        );
                                    })}
                                </div>
                            </div>
                            <div className="text-[10px] text-slate-400 dark:text-slate-500">{formatDate(day)}</div>
                        </div>
                    );
                })}
            </div>

            {/* Leyenda */}
            <div className="flex flex-wrap gap-3 text-xs text-slate-600 dark:text-slate-300 pt-3 border-t border-slate-100 dark:border-slate-700">
                {daily.accounts.map((a, i) => (
                    <div key={a.id} className="flex items-center gap-1.5">
                        <div className={`w-3 h-3 rounded ${colorFor(i)}`} />
                        <span className="capitalize">{a.name}</span>
                        <span className="text-slate-400 dark:text-slate-500">({formatDur(a.total)})</span>
                    </div>
                ))}
            </div>
        </section>
    );
};

// ─── 3. HEATMAP 7 DÍAS × 24 HORAS ───────────────────────────────
const HeatmapSection = ({ heatmap, selectedSeller, onSelectSeller }) => {
    const accounts = heatmap?.accounts || [];

    // Si no hay filtro, sumamos matrices de todos.
    const displayMatrix = useMemo(() => {
        if (!accounts.length) return null;
        if (selectedSeller) {
            const acc = accounts.find(a => a.id === selectedSeller);
            return acc?.matrix || null;
        }
        // Suma agregada
        const agg = Array.from({ length: 7 }, () => Array(24).fill(0));
        for (const acc of accounts) {
            for (let d = 0; d < 7; d++) {
                for (let h = 0; h < 24; h++) {
                    agg[d][h] += acc.matrix[d][h];
                }
            }
        }
        return agg;
    }, [accounts, selectedSeller]);

    const maxCell = useMemo(() => {
        if (!displayMatrix) return 1;
        let max = 0;
        for (let d = 0; d < 7; d++) {
            for (let h = 0; h < 24; h++) {
                if (displayMatrix[d][h] > max) max = displayMatrix[d][h];
            }
        }
        return Math.max(1, max);
    }, [displayMatrix]);

    if (!displayMatrix) {
        return (
            <section className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 text-center text-sm text-slate-400 dark:text-slate-500">
                <Flame className="w-10 h-10 mx-auto mb-2 opacity-50" />
                No hay datos suficientes para el mapa de calor.
            </section>
        );
    }

    return (
        <section className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-1">
                <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm flex items-center gap-2">
                    <Grid3x3 className="w-4 h-4" /> Mapa de calor: día × hora
                </h3>
                <select
                    value={selectedSeller}
                    onChange={e => onSelectSeller(e.target.value)}
                    className="px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-700 dark:text-slate-200"
                >
                    <option value="">Todos los vendedores (agregado)</option>
                    {accounts.map(a => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                </select>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 mb-4">
                Cada celda muestra cuánto tiempo se trabajó en ese día de la semana y esa hora del día (AR). Más oscuro = más horas acumuladas. Útil para ver cobertura: si el sábado a las 11 no hay nadie, se nota.
            </p>

            <div className="overflow-x-auto">
                <div className="inline-block">
                    {/* Header de horas */}
                    <div className="flex gap-[2px] mb-1 pl-10">
                        {Array.from({ length: 24 }, (_, h) => (
                            <div key={h} className="w-[22px] text-[9px] text-center text-slate-400 dark:text-slate-500">
                                {h % 3 === 0 ? h : ''}
                            </div>
                        ))}
                    </div>

                    {/* Filas por día */}
                    {WEEKDAY_LABELS.map((label, d) => (
                        <div key={d} className="flex items-center gap-[2px] mb-[2px]">
                            <div className="w-10 text-xs text-slate-500 dark:text-slate-400">{label}</div>
                            {Array.from({ length: 24 }, (_, h) => {
                                const val = displayMatrix[d][h];
                                const intensity = val / maxCell; // 0..1
                                // Tintado verde a emerald oscuro
                                const style = intensity === 0
                                    ? { backgroundColor: 'rgba(148, 163, 184, 0.1)' } // slate-400/10
                                    : {
                                        backgroundColor: `rgba(16, 185, 129, ${Math.min(1, 0.15 + intensity * 0.85)})`,
                                    };
                                return (
                                    <div
                                        key={h}
                                        className="w-[22px] h-[22px] rounded"
                                        style={style}
                                        title={`${label} ${h}:00 — ${formatDur(val)}`}
                                    />
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>

            <div className="flex items-center justify-between mt-4 text-xs text-slate-400 dark:text-slate-500">
                <div className="flex items-center gap-1">
                    <Info className="w-3 h-3" /> Pasá el mouse para ver valor exacto
                </div>
                <div className="flex items-center gap-2">
                    <span>menos</span>
                    <div className="flex gap-[2px]">
                        {[0.1, 0.3, 0.5, 0.7, 1.0].map(v => (
                            <div key={v} className="w-3 h-3 rounded" style={{ backgroundColor: `rgba(16, 185, 129, ${Math.max(0.1, v)})` }} />
                        ))}
                    </div>
                    <span>más</span>
                </div>
            </div>
        </section>
    );
};

export default AccountStatsView;
