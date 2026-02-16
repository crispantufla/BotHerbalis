import React from 'react';
import { Icons } from './Icons';

const StatsPanel = ({ stats, loadingStats, alertsCount = 0 }) => {
    const KpiSkeleton = () => (
        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm animate-pulse">
            <div className="h-3 bg-slate-200 rounded w-24 mb-3"></div>
            <div className="h-7 bg-slate-200 rounded w-20 mb-2"></div>
            <div className="h-3 bg-slate-200 rounded w-16"></div>
        </div>
    );

    if (loadingStats) {
        return (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <KpiSkeleton /><KpiSkeleton /><KpiSkeleton /><KpiSkeleton />
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
                <div className="absolute top-0 right-0 w-1 h-full bg-emerald-600"></div>
                <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Ventas Hoy</p>
                    <span className="p-1.5 bg-emerald-50 rounded text-emerald-600"><Icons.Dollar /></span>
                </div>
                <h3 className="text-2xl font-bold text-slate-800">${stats?.todayRevenue?.toLocaleString('es-AR') || '0'}</h3>
                <p className="text-xs text-slate-500 mt-2">{stats?.todayOrders || 0} pedidos hoy · {stats?.totalOrders || 0} totales</p>
            </div>
            <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
                <div className="absolute top-0 right-0 w-1 h-full bg-blue-600"></div>
                <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Sesiones Activas</p>
                    <span className="p-1.5 bg-blue-50 rounded text-blue-600"><Icons.Users /></span>
                </div>
                <h3 className="text-2xl font-bold text-slate-800">{stats?.activeSessions || 0}</h3>
                <p className="text-xs text-slate-500 mt-2">{stats?.activeConversations || 0} en flujo activo · {stats?.pausedUsers || 0} pausados</p>
            </div>
            <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
                <div className="absolute top-0 right-0 w-1 h-full bg-rose-600"></div>
                <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Alertas Pendientes</p>
                    <span className="p-1.5 bg-rose-50 rounded text-rose-600"><Icons.Alert /></span>
                </div>
                <h3 className="text-2xl font-bold text-slate-800">{alertsCount}</h3>
                <p className="text-xs text-rose-600 mt-2 font-medium">{alertsCount > 0 ? 'Requiere atención' : 'Sin alertas activas'}</p>
            </div>
            <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
                <div className="absolute top-0 right-0 w-1 h-full bg-violet-600"></div>
                <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Tasa Conversión</p>
                    <span className="p-1.5 bg-violet-50 rounded text-violet-600"><Icons.Activity /></span>
                </div>
                <h3 className="text-2xl font-bold text-slate-800">{stats?.conversionRate || 0}%</h3>
                <p className="text-xs text-slate-500 mt-2">pedidos / sesiones hoy</p>
            </div>
        </div>
    );
};

export default StatsPanel;
