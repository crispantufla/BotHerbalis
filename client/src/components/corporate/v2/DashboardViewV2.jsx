import React, { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import api from '../../../config/axios';
import { useToast } from '../../ui/Toast';

import StatsPanelV2 from './dashboard/StatsPanelV2';
import AlertsPanelV2 from './dashboard/AlertsPanelV2';
import SystemStatusPanelV2 from './dashboard/SystemStatusPanelV2';

const DashboardViewV2 = ({ alerts = [], config, handleQuickAction, status, qrData }) => {
    const { toast, confirm } = useToast();
    const [stats, setStats] = useState(null);
    const [loadingStats, setLoadingStats] = useState(true);

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
        } catch (e) { toast.error('Error agregando número'); }
    };

    const handleRemovePhone = async (num) => {
        const ok = await confirm(`¿Eliminar el número ${num} de las alertas admin?`);
        if (!ok) return;
        try {
            await api.post('/api/config', { action: 'remove', number: num });
            toast.success(`Número ${num} eliminado`);
            window.dispatchEvent(new Event('config-updated'));
        } catch (e) { toast.error('Error eliminando número'); }
    };

    const handleAdminCommand = async (alert, command) => {
        if (!command.trim()) return;
        try {
            const res = await api.post('/api/admin-command', { chatId: alert.userPhone, command });
            toast.success(res.data?.result || `Comando enviado a ${alert.userPhone}`);
        } catch (e) { toast.error('Error enviando comando'); }
    };

    const handleRegenerateQR = async () => {
        const ok = await confirm('¿Desconectar WhatsApp y generar un nuevo código QR?');
        if (!ok) return;
        try {
            await api.post('/api/logout');
            toast.success('Desconectado. Generando nuevo QR...');
        } catch (e) { toast.error('Error al desconectar'); }
    };

    const adminNumbers = config?.alertNumbers || (config?.alertNumber ? [config.alertNumber] : []);

    return (
        <div className="space-y-8 animate-fade-in relative z-10 w-full">
            {/* Header de la vista */}
            <div className="mb-8">
                <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-700 to-purple-600">
                    Dashboard Overview
                </h1>
                <p className="text-slate-500 mt-1 font-medium">Resumen del sistema y métricas en tiempo real</p>
            </div>

            {/* QR CODE OVERLAY - Glassmorphism style */}
            {status === 'scan_qr' && qrData && (
                <div className="bg-white/80 backdrop-blur-xl border border-white/40 shadow-2xl rounded-3xl p-10 text-center max-w-lg mx-auto transform transition-all hover:scale-[1.02]">
                    <div className="w-16 h-16 bg-gradient-to-tr from-blue-500 to-indigo-500 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-500/30">
                        <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                    </div>
                    <h3 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-800 to-slate-600 mb-3">Vincular Dispositivo</h3>
                    <p className="text-slate-500 mb-8 font-medium">Abrí WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p>
                    <div className="inline-block p-4 bg-white rounded-2xl border border-slate-100 shadow-inner">
                        <QRCodeSVG value={qrData} size={256} level="M" />
                    </div>
                </div>
            )}

            {status === 'scan_qr' && !qrData && (
                <div className="bg-white/60 backdrop-blur-lg border border-white rounded-3xl p-8 text-center max-w-lg mx-auto shadow-xl">
                    <div className="flex flex-col items-center justify-center gap-4">
                        <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
                        <span className="font-bold text-indigo-800 text-lg">Generando código QR seguro...</span>
                        <span className="text-slate-500 text-sm">Esto puede demorar unos segundos</span>
                    </div>
                </div>
            )}

            {/* A. KPI DECK V2 */}
            <StatsPanelV2 stats={stats} loadingStats={loadingStats} alertsCount={alerts.length} />

            {/* B. MAIN GRID V2 */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* B1. ALERTS V2 */}
                <AlertsPanelV2 alerts={alerts} onCommand={handleAdminCommand} onQuickAction={handleQuickAction} />

                {/* B2. SYSTEM STATUS V2 */}
                <SystemStatusPanelV2 status={status} activeConversations={stats?.activeConversations} adminNumbers={adminNumbers} onAddPhone={handleAddPhone} onRemovePhone={handleRemovePhone} onRegenerateQR={handleRegenerateQR} />
            </div>
        </div>
    );
};

export default DashboardViewV2;
