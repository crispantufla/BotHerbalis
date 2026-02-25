import React from 'react';

// Reuse original icons where possible or redefine smooth ones
const IconsV2 = {
    Dollar: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    Users: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>,
    Alert: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>,
    Activity: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
};

const StatsPanelV2 = ({ stats, loadingStats, alertsCount = 0 }) => {
    const KpiSkeleton = () => (
        <div className="bg-white/40 backdrop-blur-md p-4 lg:p-5 rounded-3xl border border-white/60 shadow-lg animate-pulse">
            <div className="h-4 bg-slate-200/50 rounded w-28 mb-3"></div>
            <div className="h-7 bg-slate-200/50 rounded w-24 mb-2"></div>
            <div className="h-3 bg-slate-200/50 rounded w-20"></div>
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
        <div className="relative overflow-hidden bg-white/60 backdrop-blur-xl p-4 lg:p-5 rounded-[1.25rem] border border-white/80 shadow-[0_8px_30px_rgb(0,0,0,0.04)] hover:shadow-[0_8px_30px_rgb(0,0,0,0.08)] transition-all duration-300 group hover:-translate-y-1">
            {/* Soft background glow */}
            <div className={`absolute -right-6 -top-6 w-24 h-24 rounded-full blur-2xl opacity-20 ${gradientClass} group-hover:opacity-40 transition-opacity duration-500`}></div>

            <div className="flex items-start justify-between mb-2 relative z-10">
                <p className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">{title}</p>
                <div className={`w-8 h-8 rounded-xl ${gradientClass} flex items-center justify-center text-white shadow-lg shadow-${colorClass}-500/30 transform group-hover:scale-110 transition-transform duration-300`}>
                    <Icon className="w-4 h-4" />
                </div>
            </div>

            <div className="relative z-10">
                <h3 className="text-2xl font-extrabold text-slate-800 tracking-tight">{value}</h3>
                <p className="text-[13px] text-slate-500 mt-1 font-medium leading-tight">{subtext}</p>
            </div>
        </div>
    );

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            <StatCard
                title="Ventas Hoy"
                value={`$${stats?.todayRevenue?.toLocaleString('es-AR') || '0'}`}
                subtext={`${stats?.todayOrders || 0} pedidos hoy · ${stats?.totalOrders || 0} totales`}
                icon={IconsV2.Dollar}
                colorClass="emerald"
                gradientClass="bg-gradient-to-br from-emerald-400 to-teal-500"
            />
            <StatCard
                title="Sesiones"
                value={stats?.activeSessions || 0}
                subtext={`${stats?.activeConversations || 0} en flujo · ${stats?.pausedUsers || 0} pausados`}
                icon={IconsV2.Users}
                colorClass="blue"
                gradientClass="bg-gradient-to-br from-blue-400 to-indigo-500"
            />
            <StatCard
                title="Alertas"
                value={alertsCount}
                subtext={alertsCount > 0 ? <span className="text-rose-500 font-bold tracking-wide">Requiere atención</span> : 'Todo en orden'}
                icon={IconsV2.Alert}
                colorClass="rose"
                gradientClass="bg-gradient-to-br from-rose-400 to-pink-500"
            />
            <StatCard
                title="Conversión"
                value={`${stats?.conversionRate || 0}%`}
                subtext="pedidos / sesiones hoy"
                icon={IconsV2.Activity}
                colorClass="violet"
                gradientClass="bg-gradient-to-br from-violet-400 to-purple-500"
            />
        </div>
    );
};

export default StatsPanelV2;
