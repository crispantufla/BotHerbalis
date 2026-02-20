import React, { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import api from '../../../config/axios';

import { useSocket } from '../../../context/SocketContext';
import { useToast } from '../../ui/Toast';

// Refactored Components
import StatsPanel from '../dashboard/StatsPanel';
import AlertsPanel from '../dashboard/AlertsPanel';
import SystemStatusPanel from '../dashboard/SystemStatusPanel';

const CorporateDashboardView = ({ alerts, config, handleQuickAction, status, qrData }) => {
    const { toast, confirm } = useToast();
    const [stats, setStats] = useState(null);
    const [loadingStats, setLoadingStats] = useState(true);

    // Fetch real KPIs
    useEffect(() => {
        const fetchStats = async () => {
            try {
                const res = await api.get('/api/stats');
                setStats(res.data);
            } catch (e) {
                console.error('Failed to load stats:', e);
            } finally {
                setLoadingStats(false);
            }
        };
        fetchStats();
        const interval = setInterval(fetchStats, 30000);
        return () => clearInterval(interval);
    }, []);

    // Admin phone management (State moved to SystemStatusPanel, logic remains here)
    const handleAddPhone = async (phoneInput) => {
        const cleaned = phoneInput.replace(/\D/g, '');
        if (!cleaned || cleaned.length < 8) {
            toast.warning('Ingresá un número válido con código de país (ej: 5493411234567)');
            return;
        }
        try {
            await api.post('/api/config', { action: 'add', number: cleaned });
            toast.success(`Número ${cleaned} agregado`);
            window.dispatchEvent(new Event('config-updated'));
        } catch (e) {
            toast.error('Error agregando número');
        }
    };

    const handleRemovePhone = async (num) => {
        const ok = await confirm(`¿Eliminar el número ${num} de las alertas admin?`);
        if (!ok) return;
        try {
            await api.post('/api/config', { action: 'remove', number: num });
            toast.success(`Número ${num} eliminado`);
            window.dispatchEvent(new Event('config-updated'));
        } catch (e) {
            toast.error('Error eliminando número');
        }
    };

    // Admin command to an alert (State moved to AlertsPanel)
    const handleAdminCommand = async (alert, command) => {
        if (!command.trim()) return;
        try {
            const res = await api.post('/api/admin-command', {
                chatId: alert.userPhone,
                command: command
            });
            toast.success(res.data?.result || `Comando enviado a ${alert.userPhone}`);
        } catch (e) {
            toast.error('Error enviando comando');
        }
    };

    const handleRegenerateQR = async () => {
        const ok = await confirm('¿Desconectar WhatsApp y generar un nuevo código QR?');
        if (!ok) return;
        try {
            await api.post('/api/logout');
            toast.success('Desconectado. Generando nuevo QR...');
        } catch (e) {
            toast.error('Error al desconectar');
        }
    };

    const adminNumbers = config?.alertNumbers || (config?.alertNumber ? [config.alertNumber] : []);

    return (
        <div className="space-y-6 animate-fade-in">

            {/* QR CODE OVERLAY - Kept here as it's a high-level interrupt */}
            {status === 'scan_qr' && qrData && (
                <div className="bg-white rounded-lg border-2 border-blue-500 shadow-lg p-8 text-center">
                    <h3 className="text-lg font-bold text-slate-800 mb-2">📱 Escanea el código QR</h3>
                    <p className="text-sm text-slate-500 mb-4">Abrí WhatsApp → Configuración → Dispositivos vinculados → Vincular un dispositivo</p>
                    <div className="inline-block p-4 bg-white rounded-lg border border-slate-200 shadow-sm">
                        <QRCodeSVG value={qrData} size={256} level="M" />
                    </div>
                </div>
            )}

            {status === 'scan_qr' && !qrData && (
                <div className="bg-amber-50 rounded-lg border border-amber-200 p-6 text-center">
                    <div className="flex items-center justify-center gap-3 text-amber-700">
                        <div className="w-5 h-5 border-2 border-amber-700 border-t-transparent rounded-full animate-spin"></div>
                        <span className="font-bold">Generando código QR... Esperá unos segundos.</span>
                    </div>
                </div>
            )}

            {/* A. KPI DECK */}
            <StatsPanel
                stats={stats}
                loadingStats={loadingStats}
                alertsCount={alerts.length}
            />

            {/* B. MAIN GRID */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* B1. ALERTS */}
                <AlertsPanel
                    alerts={alerts}
                    onCommand={handleAdminCommand}
                    onQuickAction={handleQuickAction}
                />

                {/* B2. SYSTEM STATUS */}
                <SystemStatusPanel
                    status={status}
                    qrData={qrData}
                    activeConversations={stats?.activeConversations}
                    adminNumbers={adminNumbers}
                    onAddPhone={handleAddPhone}
                    onRemovePhone={handleRemovePhone}
                    onRegenerateQR={handleRegenerateQR}
                />

            </div>
        </div>
    );
};

export default CorporateDashboardView;
