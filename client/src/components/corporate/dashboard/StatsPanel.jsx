import React from 'react';
import { DollarSign as Dollar, Users, AlertCircle as Alert, Activity } from 'lucide-react';
import { KpiCard } from '../../ui';

const StatsPanel = ({ stats, loadingStats, alertsCount = 0 }) => {
    if (loadingStats) {
        return (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                <KpiCard loading /><KpiCard loading /><KpiCard loading /><KpiCard loading />
            </div>
        );
    }

    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <KpiCard
                label="Ventas Hoy"
                value={`$${stats?.todayRevenue?.toLocaleString('es-AR') || '0'}`}
                subtext={`${stats?.todayOrders || 0} pedidos hoy · ${stats?.totalOrders || 0} totales`}
                icon={Dollar}
                tone="success"
            />
            <KpiCard
                label="Sesiones"
                value={stats?.activeSessions || 0}
                subtext={`+${stats?.newChatsToday || 0} chats nuevos · ${stats?.activeConversations || 0} en flujo · ${stats?.pausedUsers || 0} pausados`}
                icon={Users}
                tone="accent"
            />
            <KpiCard
                label="Alertas"
                value={alertsCount}
                subtext={alertsCount > 0
                    ? <span className="text-danger-600 dark:text-danger-500 font-medium">Requiere atención</span>
                    : 'Todo en orden'}
                icon={Alert}
                tone={alertsCount > 0 ? 'danger' : 'neutral'}
            />
            <KpiCard
                label="Conversión"
                value={`${stats?.conversionRate ?? 0}%`}
                subtext="pedidos / chats nuevos hoy"
                icon={Activity}
                tone="info"
            />
        </div>
    );
};

export default StatsPanel;
