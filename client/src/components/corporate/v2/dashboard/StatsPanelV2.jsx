import React from 'react';

// Reuse original icons where possible or redefine smooth ones
import { DollarSign as Dollar, Users, AlertCircle as Alert, Activity } from 'lucide-react';

const StatsPanelV2 = ({ stats, loadingStats, alertsCount = 0 }) => {
    const KpiSkeleton = () => (
        <div className="bg-white/4 dark:bg-slate-800/40 dark:bg-slate-800/40 backdrop-blur-md p-4 lg:p-5 rounded-3xl border border-white/6 dark:border-slate-700/60 dark:border-slate-700/60 shadow-lg animate-pulse">
            <div className="h-4 bg-slate-200/50 dark:bg-slate-700/50 rounded w-28 mb-3"></div>
            <div className="h-7 bg-slate-200/50 dark:bg-slate-700/50 rounded w-24 mb-2"></div>
            <div className="h-3 bg-slate-200/50 dark:bg-slate-700/50 rounded w-20"></div>
        </div>
    );

    if (loadingStats) {
        return (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
                <KpiSkeleton /><KpiSkeleton /><KpiSkeleton /><KpiSkeleton />
            </div>
        );
    }

    const StatCard = ({ title, value, subtext, icon: Icon, colorClass, gradientClass }) => (
        <div className="relative overflow-hidden bg-white/6 dark:bg-slate-800/60 dark:bg-slate-800/60 backdrop-blur-xl p-4 lg:p-5 2xl:p-7 rounded-[1.25rem] border border-white/8 dark:border-slate-700/80 dark:border-slate-700/80 shadow-[0_8px_30px_rgb(0,0,0,0.04)] hover:shadow-[0_8px_30px_rgb(0,0,0,0.08)] transition-all duration-300 group hover:-translate-y-1">
            {/* Soft background glow */}
            <div className={`absolute -right-6 -top-6 w-24 h-24 2xl:w-32 2xl:h-32 rounded-full blur-2xl opacity-20 ${gradientClass} group-hover:opacity-40 transition-opacity duration-500`}></div>

            <div className="flex items-start justify-between mb-2 relative z-10">
                <p className="text-[11px] 2xl:text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">{title}</p>
                <div className={`w-8 h-8 2xl:w-11 2xl:h-11 rounded-xl ${gradientClass} flex items-center justify-center text-white shadow-lg shadow-${colorClass}-500/30 transform group-hover:scale-110 transition-transform duration-300`}>
                    <Icon className="w-4 h-4 2xl:w-5 2xl:h-5" />
                </div>
            </div>

            <div className="relative z-10">
                <h3 className="text-2xl 2xl:text-3xl font-extrabold text-slate-800 dark:text-white tracking-tight">{value}</h3>
                <p className="text-[13px] 2xl:text-sm text-slate-500 dark:text-slate-400 mt-1 font-medium leading-tight">{subtext}</p>
            </div>
        </div>
    );

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            <StatCard
                title="Ventas Hoy"
                value={`$${stats?.todayRevenue?.toLocaleString('es-AR') || '0'}`}
                subtext={`${stats?.todayOrders || 0} pedidos hoy · ${stats?.totalOrders || 0} totales`}
                icon={Dollar}
                colorClass="emerald"
                gradientClass="bg-gradient-to-br from-emerald-400 to-teal-500"
            />
            <StatCard
                title="Sesiones"
                value={stats?.activeSessions || 0}
                subtext={`${stats?.activeConversations || 0} en flujo · ${stats?.pausedUsers || 0} pausados`}
                icon={Users}
                colorClass="blue"
                gradientClass="bg-gradient-to-br from-blue-400 to-indigo-500"
            />
            <StatCard
                title="Alertas"
                value={alertsCount}
                subtext={alertsCount > 0 ? <span className="text-rose-500 dark:text-rose-400 font-bold tracking-wide">Requiere atención</span> : 'Todo en orden'}
                icon={Alert}
                colorClass="rose"
                gradientClass="bg-gradient-to-br from-rose-400 to-pink-500"
            />
            <StatCard
                title="Conversión"
                value={`${stats?.conversionRate || 0}%`}
                subtext="pedidos / sesiones hoy"
                icon={Activity}
                colorClass="violet"
                gradientClass="bg-gradient-to-br from-violet-400 to-purple-500"
            />
        </div>
    );
};

export default StatsPanelV2;
