import React, { useState, useEffect } from 'react';
import {
    LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
    XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend,
    ResponsiveContainer, ComposedChart
} from 'recharts';
import {
    TrendingUp, TrendingDown, DollarSign, ShoppingCart, Package, Activity,
    MessageCircle, Calendar, RefreshCw, MapPin, Clock
} from 'lucide-react';
import api from '../../config/axios';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useSeller } from '../../context/SellerContext';
import { capitalize } from '../../utils/format';
import {
    Card, Button, IconButton, Badge, KpiCard, EmptyState, cn
} from '../ui';

// Paleta de los gráficos — mantenemos hex literal porque recharts no consume
// CSS custom properties / tokens Tailwind (las clases se evaluarían client-side
// antes del re-render del SVG).
const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

const DAY_RANGES = [
    { days: 7,   label: '7 días',     short: '7D' },
    { days: 14,  label: '14 días',    short: '14D' },
    { days: 30,  label: '30 días',    short: '30D' },
    { days: 90,  label: 'Trimestral', short: 'Trim' },
    { days: 365, label: 'Anual',      short: 'Año' },
];

const GrowthBadge = ({ value }) => {
    const isPositive = value >= 0;
    return (
        <Badge tone={isPositive ? 'success' : 'danger'} size="sm">
            {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            <span className="tabular-nums">{Math.abs(value)}%</span>
        </Badge>
    );
};

const SectionHeader = ({ children }) => (
    <h2 className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3 mt-6 first:mt-0">
        {children}
    </h2>
);

const AdvancedAnalyticsView = () => {
    const { isDark } = useTheme();
    const { isAdmin } = useAuth();
    const { sellers } = useSeller();
    const [loading, setLoading] = useState(true);
    const [daysAgoToFetch, setDaysAgoToFetch] = useState(30);
    // Filtro local solo para admin global. "all" = agregado.
    const [analyticsSellerFilter, setAnalyticsSellerFilter] = useState('all');
    const [data, setData] = useState({
        overview: null,
        products: { popularity: [], duration: [] },
        demographics: { provinces: [], heatmap: [] },
        charts: { chartData: [], pieData: [] },
        adPerformance: [],
    });

    const fetchAllData = async () => {
        try {
            setLoading(true);
            const headers = {};
            if (isAdmin) {
                headers['x-seller-id'] = analyticsSellerFilter === 'all' ? '' : analyticsSellerFilter;
            }
            const opts = { headers };
            const [overviewRes, productsRes, demoRes, chartsRes, adPerfRes] = await Promise.all([
                api.get(`/api/analytics/overview?days=${daysAgoToFetch}`, opts),
                api.get(`/api/analytics/products?days=${daysAgoToFetch}`, opts),
                api.get(`/api/analytics/demographics?days=${daysAgoToFetch}`, opts),
                api.get('/api/stats/charts', opts),
                api.get(`/api/analytics/ad-performance?days=${daysAgoToFetch}`, opts).catch(() => ({ data: [] })),
            ]);
            setData({
                overview: overviewRes.data,
                products: productsRes.data,
                demographics: demoRes.data,
                charts: chartsRes.data,
                adPerformance: adPerfRes.data || [],
            });
        } catch (err) {
            console.error('Error fetching analytics:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchAllData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [daysAgoToFetch, analyticsSellerFilter]);

    // Custom tooltip — usa los colores del Card primitive
    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        return (
            <div className={cn(
                'p-3 rounded-control shadow-elevated border text-sm',
                isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-slate-900'
            )}>
                {label && <p className="font-medium text-xs text-slate-500 dark:text-slate-400 mb-1.5">{label}</p>}
                {payload.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 mb-0.5">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                        <span className="text-xs font-medium">{entry.name}:</span>
                        <span className="text-xs font-semibold tabular-nums">
                            {entry.name === 'Ingresos' || entry.dataKey?.includes('revenue') || entry.name === 'Ticket Prom.'
                                || (entry.value > 1000 && !String(entry.name).includes('count') && !String(entry.name).includes('Pedidos'))
                                ? `$${entry.value.toLocaleString('es-AR')}`
                                : entry.value}
                        </span>
                    </div>
                ))}
            </div>
        );
    };

    if (loading && !data.overview) {
        return (
            <div className="h-full flex items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-slate-500 dark:text-slate-400">
                    <div className="w-10 h-10 border-[3px] border-accent-200 dark:border-accent-900 border-t-accent-600 dark:border-t-accent-500 rounded-full animate-spin" />
                    <p className="text-sm font-medium">Analizando métricas del negocio…</p>
                </div>
            </div>
        );
    }

    const cartesianGridColor = isDark ? '#334155' : '#e2e8f0';
    const axisTextColor = isDark ? '#94a3b8' : '#64748b';

    const totalChats = data.demographics?.dailyChats?.reduce((acc, d) => acc + d.chats, 0) || 0;
    const totalOrders = data.overview?.orders?.value || 0;
    const overallConversionRate = totalChats > 0 ? ((totalOrders / totalChats) * 100).toFixed(1) : 0;

    const hasData = data.overview && (data.overview.orders?.value > 0 || data.overview.revenue?.value > 0);

    return (
        <div className="h-full flex flex-col overflow-y-auto custom-scrollbar pb-12 space-y-4">
            {/* Header: título arriba, filtros en su propia fila debajo. Antes
                viajaban en flex-row con justify-between, lo que colapsaba el
                título a 2 líneas cuando había muchos vendedores. */}
            <header>
                <h1 className="text-display text-slate-900 dark:text-slate-100">Business Intelligence</h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                    Análisis de rendimiento, conversión y ventas del bot.
                </p>
            </header>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full flex-wrap">
                <div className="flex items-center gap-2 w-full sm:w-auto flex-wrap">
                    {/* Day-range tabs */}
                    <div className="flex p-1 rounded-control bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 w-full sm:w-auto">
                        {DAY_RANGES.map(({ days, label, short }) => (
                            <button
                                key={days}
                                type="button"
                                onClick={() => setDaysAgoToFetch(days)}
                                className={cn(
                                    'flex-1 sm:flex-none px-3 py-1.5 rounded-[0.5rem] text-xs font-medium transition-colors',
                                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                                    daysAgoToFetch === days
                                        ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300'
                                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                                )}
                            >
                                <span className="sm:hidden">{short}</span>
                                <span className="hidden sm:inline">{label}</span>
                            </button>
                        ))}
                    </div>

                    {isAdmin && sellers.length > 0 && (
                        <div className="flex p-1 rounded-control bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 overflow-x-auto">
                            <button
                                type="button"
                                onClick={() => setAnalyticsSellerFilter('all')}
                                className={cn(
                                    'flex-shrink-0 px-3 py-1.5 rounded-[0.5rem] text-xs font-medium transition-colors',
                                    analyticsSellerFilter === 'all'
                                        ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300'
                                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                                )}
                            >
                                Todos
                            </button>
                            {sellers.map(s => (
                                <button
                                    key={s.sellerId}
                                    type="button"
                                    onClick={() => setAnalyticsSellerFilter(s.sellerId)}
                                    className={cn(
                                        'flex-shrink-0 px-3 py-1.5 rounded-[0.5rem] text-xs font-medium transition-colors whitespace-nowrap',
                                        analyticsSellerFilter === s.sellerId
                                            ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300'
                                            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                                    )}
                                >
                                    {capitalize(s.name)}
                                </button>
                            ))}
                        </div>
                    )}

                    <IconButton
                        label="Actualizar datos"
                        icon={RefreshCw}
                        variant="subtle"
                        onClick={fetchAllData}
                        className={cn('self-end sm:self-auto', loading && '[&_svg]:animate-spin')}
                    />
                </div>
            </div>

            {/* Empty state cuando no hay datos */}
            {!loading && !hasData && (
                <Card padding="lg" className="border-dashed">
                    <EmptyState
                        icon={Activity}
                        title="Sin datos para este período"
                        description={`No hay órdenes ni ingresos registrados en los últimos ${
                            daysAgoToFetch === 90 ? '3 meses' : daysAgoToFetch === 365 ? '12 meses' : `${daysAgoToFetch} días`
                        }. Probá con un rango más amplio.`}
                        action={
                            <div className="flex gap-2">
                                {[7, 30].map(days => (
                                    <Button
                                        key={days}
                                        size="sm"
                                        variant={daysAgoToFetch === days ? 'primary' : 'secondary'}
                                        onClick={() => setDaysAgoToFetch(days)}
                                    >
                                        {days} días
                                    </Button>
                                ))}
                            </div>
                        }
                    />
                </Card>
            )}

            {hasData && (
                <>
                    {/* SECCIÓN A: KPIs */}
                    <SectionHeader>Resumen ejecutivo</SectionHeader>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <KpiCard
                            label="Ingresos brutos"
                            value={`$${data.overview?.revenue?.value?.toLocaleString('es-AR') || 0}`}
                            subtext={data.overview && <GrowthBadge value={data.overview.revenue.growth} />}
                            icon={DollarSign}
                            tone="success"
                        />
                        <KpiCard
                            label="Órdenes cerradas"
                            value={data.overview?.orders?.value?.toLocaleString('es-AR') || 0}
                            subtext={data.overview && <GrowthBadge value={data.overview.orders.growth} />}
                            icon={ShoppingCart}
                            tone="accent"
                        />
                        <KpiCard
                            label="Ticket promedio"
                            value={`$${data.overview?.aov?.value?.toLocaleString('es-AR') || 0}`}
                            subtext={data.overview && <GrowthBadge value={data.overview.aov.growth} />}
                            icon={Activity}
                            tone="purple"
                        />
                        <KpiCard
                            label="Conversión general"
                            value={`${overallConversionRate}%`}
                            subtext="Pedidos / chats nuevos"
                            icon={TrendingUp}
                            tone="info"
                        />
                    </div>

                    {/* SECCIÓN B: Funnel chart */}
                    <SectionHeader>Adquisición y conversión</SectionHeader>
                    <Card padding="md">
                        <div className="mb-4">
                            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                                <MessageCircle className="w-4 h-4 text-info-500" aria-hidden="true" />
                                Rendimiento del embudo
                            </h3>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                Tráfico de nuevos chats vs pedidos confirmados.
                            </p>
                        </div>
                        <div className="h-72 w-full">
                            <ResponsiveContainer width="100%" height="100%">
                                <ComposedChart data={data.demographics?.dailyChats || []} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
                                    <defs>
                                        <linearGradient id="colorChats" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
                                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.2} />
                                        </linearGradient>
                                        <linearGradient id="colorOrders" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.8} />
                                            <stop offset="95%" stopColor="#10b981" stopOpacity={0.2} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke={cartesianGridColor} vertical={false} />
                                    <XAxis
                                        dataKey="date"
                                        stroke={axisTextColor}
                                        fontSize={11}
                                        tickLine={false}
                                        axisLine={false}
                                        tickFormatter={(val) => {
                                            if (!val) return '';
                                            const parts = val.split('-');
                                            return parts.length === 3 ? `${parts[2]}/${parts[1]}` : val;
                                        }}
                                        minTickGap={20}
                                        dy={10}
                                    />
                                    <YAxis yAxisId="left" stroke={axisTextColor} fontSize={11} tickLine={false} axisLine={false} dx={-10} />
                                    <YAxis yAxisId="right" orientation="right" stroke="#ec4899" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} dx={10} />
                                    <RechartsTooltip content={<CustomTooltip />} cursor={{ fill: isDark ? '#334155' : '#f1f5f9' }} />
                                    <Legend verticalAlign="top" height={36} iconType="circle" wrapperStyle={{ fontSize: '12px', color: axisTextColor, fontWeight: '500' }} />
                                    <Bar yAxisId="left" dataKey="chats"  name="Nuevos chats" fill="url(#colorChats)"  radius={[4, 4, 0, 0]} barSize={12} />
                                    <Bar yAxisId="left" dataKey="orders" name="Pedidos"      fill="url(#colorOrders)" radius={[4, 4, 0, 0]} barSize={12} />
                                    <Line yAxisId="right" type="monotone" dataKey="rate" name="Tasa de cierre (%)" stroke="#ec4899" strokeWidth={2.5} dot={{ r: 3, fill: '#ec4899', strokeWidth: 2, stroke: isDark ? '#1e293b' : '#ffffff' }} activeDot={{ r: 6 }} />
                                </ComposedChart>
                            </ResponsiveContainer>
                        </div>
                    </Card>

                    {/* SECCIÓN C: Demografía */}
                    <SectionHeader>Audiencia y comportamiento</SectionHeader>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {/* Top regions */}
                        <Card padding="md">
                            <div className="mb-4">
                                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                                    <MapPin className="w-4 h-4 text-accent-600 dark:text-accent-400" aria-hidden="true" />
                                    Mejores regiones
                                </h3>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                    Provincias con mayor volumen de facturación.
                                </p>
                            </div>

                            <div className="flex justify-between pb-2 border-b border-slate-200 dark:border-slate-700 text-[11px] uppercase tracking-wide font-medium text-slate-500 dark:text-slate-400">
                                <div className="flex-1">Provincia</div>
                                <div className="w-16 text-right">Pedidos</div>
                                <div className="w-28 text-right">Facturación</div>
                            </div>

                            {(data.demographics?.provinces || []).map((prov, i) => {
                                const maxRev = data.demographics?.provinces[0]?.revenue || 1;
                                const percentage = Math.max(5, (prov.revenue / maxRev) * 100);
                                return (
                                    <div key={i} className="flex items-center justify-between py-2.5 border-b border-dashed border-slate-200 dark:border-slate-700 last:border-0 relative">
                                        <div
                                            className="absolute inset-y-1 left-0 z-0 pointer-events-none opacity-10 rounded-md transition-all duration-700"
                                            style={{ width: `${percentage}%`, backgroundColor: COLORS[i % COLORS.length] }}
                                        />
                                        <div className="flex-1 flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-200 relative z-10 min-w-0 pr-2">
                                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                                            <span className="truncate">{prov.name}</span>
                                        </div>
                                        <div className="w-16 text-right text-xs text-slate-600 dark:text-slate-400 relative z-10 flex-shrink-0 tabular-nums">{prov.orders}</div>
                                        <div className="w-28 text-right text-sm font-semibold text-success-600 dark:text-success-500 relative z-10 flex-shrink-0 tabular-nums">
                                            ${prov.revenue.toLocaleString('es-AR')}
                                        </div>
                                    </div>
                                );
                            })}
                            {(!data.demographics?.provinces || data.demographics.provinces.length === 0) && (
                                <p className="py-4 text-center text-xs text-slate-500 dark:text-slate-400">Sin datos geográficos</p>
                            )}
                        </Card>

                        {/* Peak hours */}
                        <Card padding="md">
                            <div className="mb-4">
                                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                                    <Clock className="w-4 h-4 text-warning-500" aria-hidden="true" />
                                    Horarios pico
                                </h3>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                    Actividad de cierre de ventas por hora.
                                </p>
                            </div>
                            <div className="h-56 w-full mt-2">
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={data.demographics?.heatmap || []} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                                        <defs>
                                            <linearGradient id="colorHeatmap" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#f59e0b" stopOpacity={1} />
                                                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.6} />
                                            </linearGradient>
                                        </defs>
                                        <XAxis dataKey="hour" stroke={axisTextColor} fontSize={11} tickLine={false} axisLine={false} interval={3} dy={10} />
                                        <YAxis hide />
                                        <RechartsTooltip content={<CustomTooltip />} cursor={{ fill: isDark ? '#334155' : '#f1f5f9' }} />
                                        <Bar dataKey="count" name="Compras" fill="url(#colorHeatmap)" radius={[4, 4, 0, 0]} />
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        </Card>
                    </div>

                    {/* SECCIÓN D: Productos */}
                    <SectionHeader>Inteligencia de producto</SectionHeader>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Product mix */}
                        <Card padding="md">
                            <div className="mb-4">
                                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                                    <Package className="w-4 h-4 text-purple-500" aria-hidden="true" />
                                    Mix de productos
                                </h3>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                    Distribución de compras por tipo.
                                </p>
                            </div>
                            <div className="h-56 w-full relative mt-2">
                                <ResponsiveContainer width="100%" height="100%">
                                    <PieChart>
                                        <Pie
                                            data={data.products?.popularity || []}
                                            cx="50%" cy="50%"
                                            innerRadius={56} outerRadius={84}
                                            paddingAngle={4}
                                            dataKey="value"
                                            stroke={isDark ? '#1e293b' : '#ffffff'}
                                            strokeWidth={2}
                                        >
                                            {(data.products?.popularity || []).map((_, i) => (
                                                <Cell key={i} fill={COLORS[i % COLORS.length]} />
                                            ))}
                                        </Pie>
                                        <RechartsTooltip content={<CustomTooltip />} />
                                        <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '12px', color: axisTextColor, paddingTop: '16px' }} />
                                    </PieChart>
                                </ResponsiveContainer>
                                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none mt-[-30px]">
                                    <span className="text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                                        {data.products?.popularity?.reduce((a, b) => a + b.value, 0) || 0}
                                    </span>
                                    <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-0.5">Items</span>
                                </div>
                            </div>
                        </Card>

                        {/* Duration */}
                        <Card padding="md">
                            <div className="mb-4">
                                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                                    <Calendar className="w-4 h-4 text-danger-500" aria-hidden="true" />
                                    Patrón de duración
                                </h3>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                    Tamaño del plan elegido (60/120/180 días).
                                </p>
                            </div>
                            <div className="h-56 w-full relative mt-2">
                                <ResponsiveContainer width="100%" height="100%">
                                    <PieChart>
                                        <Pie
                                            data={data.products?.duration || []}
                                            cx="50%" cy="50%"
                                            innerRadius={56} outerRadius={84}
                                            paddingAngle={4}
                                            dataKey="value"
                                            stroke={isDark ? '#1e293b' : '#ffffff'}
                                            strokeWidth={2}
                                        >
                                            {(data.products?.duration || []).map((_, i) => (
                                                <Cell key={i} fill={COLORS[(i + 2) % COLORS.length]} />
                                            ))}
                                        </Pie>
                                        <RechartsTooltip content={<CustomTooltip />} />
                                        <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '12px', color: axisTextColor, paddingTop: '16px' }} />
                                    </PieChart>
                                </ResponsiveContainer>
                                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none mt-[-30px]">
                                    <span className="text-base font-semibold text-slate-900 dark:text-slate-100">Planes</span>
                                    <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-0.5">Duración</span>
                                </div>
                            </div>
                        </Card>
                    </div>
                </>
            )}
        </div>
    );
};

export default AdvancedAnalyticsView;
