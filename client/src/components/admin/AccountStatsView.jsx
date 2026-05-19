import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    BarChart3, Clock, RefreshCw, Users, Grid3x3, Flame,
    HelpCircle, ChevronDown, ChevronUp, Info
} from 'lucide-react';
import api from '../../config/axios';
import {
    Card, Button, IconButton, Badge, Select, EmptyState, useToast
} from '../ui';

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
    const [, m, d] = ymd.split('-');
    return `${d}/${m}`;
}

// Paleta rotativa hex literal — usada por bars/leyenda en estilos inline (las
// clases Tailwind dinámicas no se purgan correctamente).
const PALETTE = [
    '#6366f1', '#10b981', '#f59e0b', '#f43f5e',
    '#0ea5e9', '#a855f7', '#14b8a6', '#f97316',
];
const colorFor = (i) => PALETTE[i % PALETTE.length];

const AccountStatsView = () => {
    const { toast } = useToast();
    const [daysBack, setDaysBack] = useState(7);
    const [loading, setLoading] = useState(false);
    const [daily, setDaily] = useState(null);
    const [totals, setTotals] = useState(null);
    const [heatmap, setHeatmap] = useState(null);
    const [heatmapSeller, setHeatmapSeller] = useState('');
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
        <div className="w-full max-w-7xl mx-auto space-y-4">
            <header className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-11 h-11 rounded-card bg-success-50 dark:bg-success-900/30 text-success-600 dark:text-success-500 flex items-center justify-center flex-shrink-0">
                        <BarChart3 className="w-5 h-5" aria-hidden="true" />
                    </div>
                    <div>
                        <h1 className="text-h2 text-slate-900 dark:text-slate-100">Horas de vendedores</h1>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            Cuánto tiempo cada vendedor tuvo el panel abierto y en qué horarios.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Select
                        value={daysBack}
                        onChange={e => setDaysBack(parseInt(e.target.value, 10))}
                        aria-label="Rango de días"
                        className="!w-44"
                    >
                        <option value={7}>Últimos 7 días</option>
                        <option value={14}>Últimos 14 días</option>
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

            {/* Cómo se calcula (collapsible) */}
            <div>
                <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={HelpCircle}
                    rightIcon={showHowTo ? ChevronUp : ChevronDown}
                    onClick={() => setShowHowTo(v => !v)}
                >
                    ¿Cómo se calcula esto?
                </Button>
                {showHowTo && (
                    <Card padding="md" className="mt-2 border-info-200 dark:border-info-900/40 bg-info-50/40 dark:bg-info-900/10">
                        <div className="text-sm text-slate-700 dark:text-slate-300 space-y-2">
                            <p>
                                Una <strong>sesión</strong> empieza cuando un vendedor abre el panel web y termina cuando cierra la pestaña o queda más de 10 minutos sin interactuar.
                                Cada sesión se guarda en la base con inicio, fin y duración.
                            </p>
                            <p>
                                Horario mostrado: <strong>Argentina (UTC-3)</strong>. Sesiones que cruzan de un día al otro se dividen entre los días correspondientes.
                            </p>
                        </div>
                    </Card>
                )}
            </div>

            {loading && !totals ? (
                <Card padding="lg" className="flex items-center justify-center min-h-[200px]">
                    <div className="w-8 h-8 border-[3px] border-accent-200 dark:border-accent-900 border-t-accent-600 dark:border-t-accent-500 rounded-full animate-spin" />
                </Card>
            ) : (
                <div className="space-y-4">
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
function TotalsSection({ totals }) {
    if (!totals?.accounts?.length) {
        return (
            <Card padding="lg">
                <EmptyState
                    icon={Clock}
                    title="Sin sesiones"
                    description="Sin sesiones registradas en el rango seleccionado."
                />
            </Card>
        );
    }

    return (
        <section>
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <Users className="w-4 h-4" aria-hidden="true" />
                    Totales por vendedor
                </h3>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    {totals.days} días · {totals.accounts.length} usuario(s)
                </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {totals.accounts.map((a, i) => (
                    <Card key={a.id} padding="md">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: colorFor(i) }} />
                            <span className="font-semibold text-slate-900 dark:text-slate-100 text-sm truncate capitalize">{a.name}</span>
                            {a.role === 'admin' && <Badge tone="warning" size="sm">admin</Badge>}
                        </div>
                        <p className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                            {formatDur(a.totalSeconds)}
                        </p>
                        <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                            <span title="Cantidad de sesiones">{a.sessionCount} sesiones</span>
                            <span title="Duración promedio">prom {formatDur(a.avgSessionSeconds)}</span>
                        </div>
                    </Card>
                ))}
            </div>
        </section>
    );
}

// ─── 2. HORAS POR DÍA × VENDEDOR ────────────────────────────────
function DailySection({ daily }) {
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
        <Card padding="md">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2 mb-1">
                <BarChart3 className="w-4 h-4" aria-hidden="true" />
                Horas por día (apiladas por vendedor)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                Cada barra es un día. Los colores apilados son distintos vendedores. La altura total = suma de los que estuvieron conectados ese día.
            </p>

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
                                <div className="w-full flex flex-col-reverse rounded-t overflow-hidden" style={{ height: `${Math.max(2, heightPct)}%` }}>
                                    {bySeller.map((s) => {
                                        const segPct = totalDay > 0 ? (s.seconds / totalDay) * 100 : 0;
                                        const sellerIdx = daily.accounts.findIndex(a => a.id === s.id);
                                        return (
                                            <div
                                                key={s.id}
                                                className="transition-opacity group-hover:opacity-90"
                                                style={{ height: `${segPct}%`, backgroundColor: colorFor(sellerIdx) }}
                                                title={`${s.name}: ${formatDur(s.seconds)}`}
                                            />
                                        );
                                    })}
                                </div>
                            </div>
                            <span className="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">{formatDate(day)}</span>
                        </div>
                    );
                })}
            </div>

            <div className="flex flex-wrap gap-3 text-xs text-slate-600 dark:text-slate-300 pt-3 border-t border-slate-100 dark:border-slate-700">
                {daily.accounts.map((a, i) => (
                    <div key={a.id} className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded" style={{ backgroundColor: colorFor(i) }} />
                        <span className="capitalize">{a.name}</span>
                        <span className="text-slate-400 dark:text-slate-500 tabular-nums">({formatDur(a.total)})</span>
                    </div>
                ))}
            </div>
        </Card>
    );
}

// ─── 3. HEATMAP 7 DÍAS × 24 HORAS ───────────────────────────────
function HeatmapSection({ heatmap, selectedSeller, onSelectSeller }) {
    const accounts = heatmap?.accounts || [];

    const displayMatrix = useMemo(() => {
        if (!accounts.length) return null;
        if (selectedSeller) {
            const acc = accounts.find(a => a.id === selectedSeller);
            return acc?.matrix || null;
        }
        const agg = Array.from({ length: 7 }, () => Array(24).fill(0));
        for (const acc of accounts) {
            for (let d = 0; d < 7; d++) {
                for (let h = 0; h < 24; h++) agg[d][h] += acc.matrix[d][h];
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
            <Card padding="lg">
                <EmptyState
                    icon={Flame}
                    title="Datos insuficientes"
                    description="No hay datos suficientes para el mapa de calor."
                />
            </Card>
        );
    }

    return (
        <Card padding="md">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-1">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <Grid3x3 className="w-4 h-4" aria-hidden="true" />
                    Mapa de calor: día × hora
                </h3>
                <Select
                    value={selectedSeller}
                    onChange={e => onSelectSeller(e.target.value)}
                    size="sm"
                    aria-label="Filtrar por vendedor"
                    className="!w-64"
                >
                    <option value="">Todos los vendedores (agregado)</option>
                    {accounts.map(a => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                </Select>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                Cada celda muestra cuánto tiempo se trabajó en ese día de la semana y esa hora del día (AR). Más oscuro = más horas acumuladas.
            </p>

            <div className="overflow-x-auto">
                <div className="inline-block">
                    <div className="flex gap-[2px] mb-1 pl-10">
                        {Array.from({ length: 24 }, (_, h) => (
                            <div key={h} className="w-[22px] text-[9px] text-center text-slate-400 dark:text-slate-500 tabular-nums">
                                {h % 3 === 0 ? h : ''}
                            </div>
                        ))}
                    </div>
                    {WEEKDAY_LABELS.map((label, d) => (
                        <div key={d} className="flex items-center gap-[2px] mb-[2px]">
                            <div className="w-10 text-xs text-slate-500 dark:text-slate-400">{label}</div>
                            {Array.from({ length: 24 }, (_, h) => {
                                const val = displayMatrix[d][h];
                                const intensity = val / maxCell;
                                const style = intensity === 0
                                    ? { backgroundColor: 'rgba(148, 163, 184, 0.1)' }
                                    : { backgroundColor: `rgba(16, 185, 129, ${Math.min(1, 0.15 + intensity * 0.85)})` };
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

            <div className="flex items-center justify-between mt-4 text-xs text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-1">
                    <Info className="w-3 h-3" aria-hidden="true" />
                    Pasá el mouse para ver valor exacto
                </span>
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
        </Card>
    );
}

export default AccountStatsView;
