import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import { useTheme } from '../../../context/ThemeContext';
import {
    LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
    XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, ComposedChart
} from 'recharts';
import {
    TrendingUp,
    TrendingDown,
    DollarSign,
    ShoppingCart,
    Package,
    Activity,
    MessageCircle,
    Calendar,
    RefreshCw,
    MapPin,
    Clock
} from 'lucide-react';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

const AdvancedAnalyticsViewV2 = () => {
    const { isDark } = useTheme();
    const [loading, setLoading] = useState(true);
    const [daysAgoToFetch, setDaysAgoToFetch] = useState(30);
    const [instanceScope, setInstanceScope] = useState('current'); // 'current' or 'all'
    const [data, setData] = useState({
        overview: null,
        products: { popularity: [], duration: [] },
        demographics: { provinces: [], heatmap: [] },
        charts: { chartData: [], pieData: [] } // From original basic stats
    });

    const fetchAllData = async () => {
        try {
            setLoading(true);

            // Fetch all 4 endpoints in parallel
            const [overviewRes, productsRes, demoRes, chartsRes] = await Promise.all([
                api.get(`/api/analytics/overview?days=${daysAgoToFetch}&instance=${instanceScope}`),
                api.get(`/api/analytics/products?days=${daysAgoToFetch}&instance=${instanceScope}`),
                api.get(`/api/analytics/demographics?days=${daysAgoToFetch}&instance=${instanceScope}`),
                api.get('/api/stats/charts') // Kept for the daily revenue line chart
            ]);

            setData({
                overview: overviewRes.data,
                products: productsRes.data,
                demographics: demoRes.data,
                charts: chartsRes.data
            });

        } catch (err) {
            console.error('Error fetching analytics:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchAllData();
    }, [daysAgoToFetch, instanceScope]);

    // Custom Tooltip for charts
    const CustomTooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            return (
                <div className={`p-4 rounded-xl shadow-lg border ${isDark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-100 text-slate-900'} backdrop-blur-sm bg-opacity-90`}>
                    <p className={`font-semibold mb-2 ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>{label}</p>
                    {payload.map((entry, index) => (
                        <div key={index} className="flex items-center gap-2 mb-1">
                            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
                            <span className="font-medium">{entry.name}: </span>
                            <span className="font-bold">
                                {entry.name === 'Ingresos' || entry.name === 'revenue' || entry.dataKey?.includes('revenue') || entry.name === 'Ticket Prom.' || (entry.value > 1000 && !entry.name.includes('count') && !entry.name.includes('Pedidos'))
                                    ? `$${entry.value.toLocaleString('es-AR')}`
                                    : entry.value}
                            </span>
                        </div>
                    ))}
                </div>
            );
        }
        return null;
    };

    const GrowthBadge = ({ value }) => {
        const isPositive = value >= 0;
        return (
            <div className={`flex items-center gap-1 text-sm font-medium px-2 py-1 rounded-full ${isPositive
                ? (isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-100 text-emerald-700')
                : (isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-100 text-red-700')
                }`}>
                {isPositive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                <span>{Math.abs(value)}%</span>
            </div>
        );
    };

    if (loading && !data.overview) {
        return (
            <div className="h-full flex items-center justify-center">
                <div className="flex flex-col items-center gap-4 text-slate-500 dark:text-slate-400">
                    <div className="w-12 h-12 border-4 border-indigo-500/30 border-t-indigo-600 rounded-full animate-spin"></div>
                    <p className="font-medium animate-pulse">Analizando métricas del negocio...</p>
                </div>
            </div>
        );
    }

    const cartesianGridColor = isDark ? '#334155' : '#e2e8f0';
    const axisTextColor = isDark ? '#94a3b8' : '#64748b';

    // Calculate Overall Conversion Rate
    const totalChats = data.demographics?.dailyChats?.reduce((acc, d) => acc + d.chats, 0) || 0;
    const totalOrders = data.overview?.orders?.value || 0;
    const overallConversionRate = totalChats > 0 ? ((totalOrders / totalChats) * 100).toFixed(1) : 0;

    return (
        <div className={`h-full flex flex-col ${isDark ? 'bg-slate-900' : 'bg-slate-50'} overflow-y-auto scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-600`}>
            <div className="p-4 sm:p-6 lg:p-8 flex-1 flex flex-col min-h-0">

                {/* Header & Global Filters */}
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
                    <div>
                        <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-3">
                            <Activity className="text-indigo-500" /> Business Intelligence
                        </h1>
                        <p className="text-slate-500 dark:text-slate-400 mt-1">
                            Análisis de rendimiento, conversión y ventas detallado del bot.
                        </p>
                    </div>

                    <div className="flex items-center gap-3">
                        <div className={`flex p-1 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                            <button
                                onClick={() => setInstanceScope('current')}
                                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${instanceScope === 'current'
                                    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
                                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700'
                                    }`}
                            >
                                Sólo este Bot
                            </button>
                            <button
                                onClick={() => setInstanceScope('all')}
                                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${instanceScope === 'all'
                                    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
                                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700'
                                    }`}
                            >
                                Todos
                            </button>
                        </div>

                        <div className={`flex p-1 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                            {[1, 7, 14, 30].map(days => (
                                <button
                                    key={days}
                                    onClick={() => setDaysAgoToFetch(days)}
                                    className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors sm:px-3 sm:py-1 ${daysAgoToFetch === days
                                        ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
                                        : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700'
                                        }`}
                                >
                                    {days === 1 ? 'Ayer' : `${days} Días`}
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={fetchAllData}
                            className={`p-2 rounded-xl border transition-colors ${isDark ? 'bg-slate-800 border-slate-700 hover:bg-slate-700 text-slate-300' : 'bg-white border-slate-200 hover:bg-slate-100 text-slate-600 shadow-sm'}`}
                            title="Actualizar datos"
                        >
                            <RefreshCw size={20} className={loading ? "animate-spin" : ""} />
                        </button>
                    </div>
                </div>

                {/* --- SECCIÓN A: RESUMEN EJECUTIVO --- */}
                <h2 className={`text-sm font-bold uppercase tracking-widest mb-4 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Resumen Ejecutivo</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-8">
                    {/* Revenue */}
                    <div className={`p-5 md:p-6 rounded-3xl border shadow-sm ${isDark ? 'bg-slate-800/40 border-slate-700/50' : 'bg-white border-slate-200'} relative overflow-hidden group`}>
                        <div className="absolute -right-6 -top-6 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl group-hover:bg-emerald-500/10 transition-colors"></div>
                        <div className="flex justify-between items-start mb-3 md:mb-4 relative">
                            <div className="p-2 md:p-3 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                                <DollarSign size={20} className="md:w-6 md:h-6" />
                            </div>
                            {data.overview && <GrowthBadge value={data.overview.revenue.growth} />}
                        </div>
                        <h3 className="font-semibold text-slate-500 dark:text-slate-400 text-xs md:text-sm mb-1 relative">Ingresos Brutos</h3>
                        <p className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white tracking-tight relative">
                            ${data.overview?.revenue?.value?.toLocaleString('es-AR') || 0}
                        </p>
                    </div>

                    {/* Orders */}
                    <div className={`p-5 md:p-6 rounded-3xl border shadow-sm ${isDark ? 'bg-slate-800/40 border-slate-700/50' : 'bg-white border-slate-200'} relative overflow-hidden group`}>
                        <div className="absolute -right-6 -top-6 w-24 h-24 bg-blue-500/5 rounded-full blur-2xl group-hover:bg-blue-500/10 transition-colors"></div>
                        <div className="flex justify-between items-start mb-3 md:mb-4 relative">
                            <div className="p-2 md:p-3 rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
                                <ShoppingCart size={20} className="md:w-6 md:h-6" />
                            </div>
                            {data.overview && <GrowthBadge value={data.overview.orders.growth} />}
                        </div>
                        <h3 className="font-semibold text-slate-500 dark:text-slate-400 text-xs md:text-sm mb-1 relative">Órdenes Cerradas</h3>
                        <p className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white tracking-tight relative">
                            {data.overview?.orders?.value?.toLocaleString('es-AR') || 0}
                        </p>
                    </div>

                    {/* AOV */}
                    <div className={`p-5 md:p-6 rounded-3xl border shadow-sm ${isDark ? 'bg-slate-800/40 border-slate-700/50' : 'bg-white border-slate-200'} relative overflow-hidden group`}>
                        <div className="absolute -right-6 -top-6 w-24 h-24 bg-purple-500/5 rounded-full blur-2xl group-hover:bg-purple-500/10 transition-colors"></div>
                        <div className="flex justify-between items-start mb-3 md:mb-4 relative">
                            <div className="p-2 md:p-3 rounded-2xl bg-purple-500/10 text-purple-600 dark:text-purple-400">
                                <Activity size={20} className="md:w-6 md:h-6" />
                            </div>
                            {data.overview && <GrowthBadge value={data.overview.aov.growth} />}
                        </div>
                        <h3 className="font-semibold text-slate-500 dark:text-slate-400 text-xs md:text-sm mb-1 relative">Ticket Promedio (AOV)</h3>
                        <p className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white tracking-tight relative">
                            ${data.overview?.aov?.value?.toLocaleString('es-AR') || 0}
                        </p>
                    </div>

                    {/* Conversion Rate */}
                    <div className={`p-5 md:p-6 rounded-3xl border shadow-sm ${isDark ? 'bg-slate-800/40 border-slate-700/50' : 'bg-white border-slate-200'} relative overflow-hidden group`}>
                        <div className="absolute -right-6 -top-6 w-24 h-24 bg-pink-500/5 rounded-full blur-2xl group-hover:bg-pink-500/10 transition-colors"></div>
                        <div className="flex justify-between items-start mb-3 md:mb-4 relative">
                            <div className="p-2 md:p-3 rounded-2xl bg-pink-500/10 text-pink-600 dark:text-pink-400">
                                <TrendingUp size={20} className="md:w-6 md:h-6" />
                            </div>
                        </div>
                        <h3 className="font-semibold text-slate-500 dark:text-slate-400 text-xs md:text-sm mb-1 relative">Conversión General</h3>
                        <p className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white tracking-tight relative">
                            {overallConversionRate}%
                        </p>
                    </div>
                </div>

                {/* --- SECCIÓN B: ADQUISICIÓN Y CONVERSIÓN --- */}
                <h2 className={`text-sm font-bold uppercase tracking-widest mb-4 mt-8 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Adquisición y Conversión</h2>
                <div className="mb-8">
                    <div className={`p-5 sm:p-6 lg:p-7 rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800/40 border-slate-700/50' : 'bg-white border-slate-200'}`}>
                        <div className="mb-6 flex flex-col sm:flex-row justify-between sm:items-end gap-4">
                            <div>
                                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                    <MessageCircle size={20} className="text-blue-500" /> Rendimiento del Embudo
                                </h3>
                                <p className="text-sm text-slate-500 dark:text-slate-400">Tráfico de nuevos chats vs Pedidos confirmados diarios</p>
                            </div>
                        </div>
                        <div className="h-72 w-full mt-2">
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
                                    <Bar yAxisId="left" dataKey="chats" name="Nuevos Chats" fill="url(#colorChats)" radius={[4, 4, 0, 0]} barSize={12} />
                                    <Bar yAxisId="left" dataKey="orders" name="Pedidos" fill="url(#colorOrders)" radius={[4, 4, 0, 0]} barSize={12} />
                                    <Line yAxisId="right" type="monotone" dataKey="rate" name="Tasa de Cierre (%)" stroke="#ec4899" strokeWidth={3} dot={{ r: 3, fill: '#ec4899', strokeWidth: 2, stroke: isDark ? '#1e293b' : '#ffffff' }} activeDot={{ r: 6 }} />
                                </ComposedChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>

                {/* --- SECCIÓN C: COMPORTAMIENTO Y DEMOGRAFÍA --- */}
                <h2 className={`text-sm font-bold uppercase tracking-widest mb-4 mt-8 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Audiencia y Comportamiento</h2>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
                    {/* Top Regions Table */}
                    <div className={`p-5 sm:p-6 lg:p-7 rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800/40 border-slate-700/50' : 'bg-white border-slate-200'} flex flex-col`}>
                        <div className="mb-6">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                <MapPin size={20} className="text-indigo-500" /> Mejores Regiones
                            </h3>
                            <p className="text-sm text-slate-500 dark:text-slate-400">Provincias con mayor volumen de facturación</p>
                        </div>
                        <div className="flex-1 flex flex-col mt-2">
                            {/* Header */}
                            <div className={`flex justify-between pb-3 border-b ${isDark ? 'border-slate-700 text-slate-400' : 'border-slate-200 text-slate-500'} text-xs uppercase tracking-wider font-semibold`}>
                                <div className="flex-1">Provincia</div>
                                <div className="w-20 text-right">Pedidos</div>
                                <div className="w-28 text-right">Facturación</div>
                            </div>

                            {/* Body */}
                            <div className="flex flex-col flex-1 mt-2">
                                {(data.demographics?.provinces || []).map((prov, i) => {
                                    // Calc max revenue for progress bar
                                    const maxRev = data.demographics?.provinces[0]?.revenue || 1;
                                    const percentage = Math.max(5, (prov.revenue / maxRev) * 100);
                                    return (
                                        <div key={i} className={`flex items-center justify-between py-3 border-b border-dashed last:border-0 relative ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                                            {/* Background Progress Bar (scoped inside the relative row) */}
                                            <div className="absolute inset-y-1 left-0 z-0 pointer-events-none opacity-10 rounded-md transition-all duration-1000" style={{ width: `${percentage}%`, backgroundColor: COLORS[i % COLORS.length] }}></div>

                                            <div className="flex-1 flex items-center gap-2 font-medium text-slate-900 dark:text-slate-200 relative z-10 min-w-0 pr-2">
                                                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }}></div>
                                                <span className="truncate">{prov.name}</span>
                                            </div>
                                            <div className="w-20 text-right text-slate-600 dark:text-slate-400 relative z-10 shrink-0">{prov.orders}</div>
                                            <div className="w-28 text-right font-bold text-emerald-600 dark:text-emerald-400 relative z-10 shrink-0">${prov.revenue.toLocaleString('es-AR')}</div>
                                        </div>
                                    );
                                })}
                                {(!data.demographics?.provinces || data.demographics.provinces.length === 0) && (
                                    <div className="py-4 text-center text-slate-500">No hay datos geográficos</div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Peak Hours Heatmap */}
                    <div className={`p-5 sm:p-6 lg:p-7 rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800/40 border-slate-700/50' : 'bg-white border-slate-200'} flex flex-col`}>
                        <div className="mb-6">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                <Clock size={20} className="text-amber-500" /> Horarios Pico
                            </h3>
                            <p className="text-sm text-slate-500 dark:text-slate-400">Actividad de cierre de ventas por hora</p>
                        </div>
                        <div className="h-56 w-full flex-1 mt-4">
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
                    </div>
                </div>

                {/* --- SECCIÓN D: INTELIGENCIA DE PRODUCTO --- */}
                <h2 className={`text-sm font-bold uppercase tracking-widest mb-4 mt-8 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Inteligencia de Producto</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
                    {/* Product Mix (Type) */}
                    <div className={`p-5 sm:p-6 lg:p-7 rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800/40 border-slate-700/50' : 'bg-white border-slate-200'}`}>
                        <div className="mb-6">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                <Package size={20} className="text-purple-500" /> Mix de Productos
                            </h3>
                            <p className="text-sm text-slate-500 dark:text-slate-400">Distribución de compras por tipo de producto</p>
                        </div>
                        <div className="h-56 w-full relative mt-2">
                            <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                    <Pie
                                        data={data.products?.popularity || []}
                                        cx="50%"
                                        cy="50%"
                                        innerRadius={60}
                                        outerRadius={90}
                                        paddingAngle={5}
                                        dataKey="value"
                                        stroke={isDark ? '#1e293b' : '#ffffff'}
                                        strokeWidth={2}
                                    >
                                        {(data.products?.popularity || []).map((entry, index) => (
                                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                        ))}
                                    </Pie>
                                    <RechartsTooltip content={<CustomTooltip />} />
                                    <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '12px', color: axisTextColor, paddingTop: '20px' }} />
                                </PieChart>
                            </ResponsiveContainer>
                            {/* Inner Circle Label Overlay */}
                            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none mt-[-36px]">
                                <span className={`text-2xl font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{data.products?.popularity?.reduce((a, b) => a + b.value, 0) || 0}</span>
                                <span className={`text-[10px] font-bold uppercase tracking-widest ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Items</span>
                            </div>
                        </div>
                    </div>

                    {/* Product Duration (Size) */}
                    <div className={`p-5 sm:p-6 lg:p-7 rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800/40 border-slate-700/50' : 'bg-white border-slate-200'}`}>
                        <div className="mb-6">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                <Calendar size={20} className="text-pink-500" /> Patrón de Duración
                            </h3>
                            <p className="text-sm text-slate-500 dark:text-slate-400">Tamaño del plan elegido (60, 120, 180 días)</p>
                        </div>
                        <div className="h-56 w-full relative mt-2">
                            <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                    <Pie
                                        data={data.products?.duration || []}
                                        cx="50%"
                                        cy="50%"
                                        innerRadius={60}
                                        outerRadius={90}
                                        paddingAngle={5}
                                        dataKey="value"
                                        stroke={isDark ? '#1e293b' : '#ffffff'}
                                        strokeWidth={2}
                                    >
                                        {(data.products?.duration || []).map((entry, index) => (
                                            <Cell key={`cell-${index}`} fill={COLORS[(index + 2) % COLORS.length]} />
                                        ))}
                                    </Pie>
                                    <RechartsTooltip content={<CustomTooltip />} />
                                    <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '12px', color: axisTextColor, paddingTop: '20px' }} />
                                </PieChart>
                            </ResponsiveContainer>
                            {/* Inner Circle Label Overlay */}
                            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none mt-[-36px]">
                                <span className={`text-2xl font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>Tipos</span>
                                <span className={`text-[10px] font-bold uppercase tracking-widest ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Planes</span>
                            </div>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
};

export default AdvancedAnalyticsViewV2;
