import React, { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import api from '../../../config/axios';
import { useToast } from '../../../components/ui/Toast';

import StatsPanelV3 from './dashboard/StatsPanelV3';
import AlertsPanelV3 from './dashboard/AlertsPanelV3';
import SystemStatusPanelV3 from './dashboard/SystemStatusPanelV3';

const DashboardViewV3 = ({ alerts = [], config, handleQuickAction, status, qrData }) => {
    const { toast, confirm } = useToast();
    const [stats, setStats] = useState(null);
    const [loadingStats, setLoadingStats] = useState(true);

    // Pairing code states
    const [pairingPhone, setPairingPhone] = useState('');
    const [pairingCode, setPairingCode] = useState('');
    const [loadingPairing, setLoadingPairing] = useState(false);

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

    const handleRequestPairingCode = async () => {
        const cleaned = pairingPhone.replace(/\D/g, '');
        if (!cleaned || cleaned.length < 8) {
            toast.warning('Ingresa un número válido con código de país (ej: 5493411234567)');
            return;
        }
        setLoadingPairing(true);
        try {
            const res = await api.post('/api/pairing-code', { phoneNumber: cleaned });
            if (res.data?.code) {
                setPairingCode(res.data.code);
                toast.success('Código de vinculación generado con éxito');
            } else {
                toast.error('No se pudo generar el código');
            }
        } catch (e) {
            toast.error(e.response?.data?.error || 'Error solicitando código');
        } finally {
            setLoadingPairing(false);
        }
    };

    const handleRegenerateQR = async () => {
        const ok = await confirm('¿Desconectar la cuenta actúal y generar un nuevo código QR?');
        if (!ok) return;
        try {
            await api.post('/api/logout');
            toast.success('Desconectado. Generando nueva sesión...');
        } catch (e) { toast.error('Error al desconectar'); }
    };

    const adminNumbers = config?.alertNumbers || (config?.alertNumber ? [config.alertNumber] : []);

    return (
        <div className="space-y-6 sm:space-y-10 animate-fade-in relative z-10 w-full max-w-7xl mx-auto">

            {/* Header / Titular */}
            <div className="flex flex-col gap-1 items-start justify-center">
                <h1 className="text-3xl lg:text-4xl font-black text-slate-800 tracking-tight">
                    Resumen <span className="text-blue-600">General</span>
                </h1>
                <p className="text-slate-500 font-medium text-sm lg:text-base">Métricas de rendimiento en tiempo real y alertas de asistencia.</p>
            </div>

            {/* WA LINKING OVERLAY (QR o PAIRING) - Frosted Glass Super Premium */}
            {status === 'scan_qr' && qrData && (
                <div className="bg-white/70 backdrop-blur-2xl border border-white/80 shadow-2xl rounded-[3rem] p-10 lg:p-14 text-center max-w-2xl mx-auto transform transition-all duration-500 hover:shadow-blue-500/20 w-full">

                    <div className="w-20 h-20 bg-gradient-to-tr from-blue-600 to-indigo-500 rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-xl shadow-blue-500/30">
                        <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                    </div>

                    <h3 className="text-3xl font-extrabold text-slate-900 tracking-tight mb-3">Conectar Cuenta</h3>
                    <p className="text-slate-500 mb-8 font-medium">Vincula el sistema bot abriendo WhatsApp y dirigiéndote a <span className="text-slate-700 font-bold">Dispositivos vinculados</span></p>

                    {pairingCode ? (
                        <div className="mb-8 animate-fade-in">
                            <p className="text-xs font-bold text-blue-600 mb-3 uppercase tracking-widest">Código de Confirmación</p>
                            <div className="bg-blue-50/50 backdrop-blur-sm rounded-3xl p-8 text-5xl font-mono font-black tracking-[0.3em] text-blue-700 border-2 border-blue-200/50 shadow-inner">
                                {pairingCode}
                            </div>
                            <p className="text-sm text-slate-500 mt-6 font-medium">Una vez recibas el aviso de conexión, escribe este código allí.</p>
                            <button
                                onClick={() => setPairingCode('')}
                                className="mt-8 text-slate-400 hover:text-slate-700 text-sm font-bold transition-colors inline-flex items-center gap-2"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
                                Ecanear QR (Clásico)
                            </button>
                        </div>
                    ) : (
                        <div className="animate-fade-in">
                            <div className="inline-block p-4 sm:p-5 bg-white rounded-3xl shadow-md border border-slate-100 mb-8">
                                <QRCodeSVG value={qrData} size={260} level="M" />
                            </div>

                            <div className="relative flex items-center py-6">
                                <div className="flex-grow border-t border-slate-200"></div>
                                <span className="flex-shrink-0 mx-4 text-xs font-bold text-slate-400 uppercase tracking-widest">O en su defecto</span>
                                <div className="flex-grow border-t border-slate-200"></div>
                            </div>

                            <div className="bg-slate-50 border border-slate-200/60 rounded-3xl p-6 relative overflow-hidden">
                                <p className="text-sm font-bold text-slate-700 mb-4 text-left">Vincular con Número (Pairing Code)</p>
                                <div className="flex flex-col sm:flex-row gap-3">
                                    <input
                                        type="text"
                                        placeholder="Ej: 54911..."
                                        value={pairingPhone}
                                        onChange={(e) => setPairingPhone(e.target.value)}
                                        className="flex-1 rounded-2xl border-none ring-1 ring-slate-200 px-5 py-3 focus:ring-2 focus:ring-blue-500 outline-none transition-all placeholder-slate-400 font-medium text-slate-800 bg-white"
                                    />
                                    <button
                                        onClick={handleRequestPairingCode}
                                        disabled={loadingPairing || !pairingPhone}
                                        className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white px-6 py-3 rounded-2xl font-bold transition-all shadow-lg hover:shadow-blue-500/25"
                                    >
                                        {loadingPairing ? 'Consultando...' : 'Obtener Código'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* WA WAITING OVERLAY */}
            {status === 'scan_qr' && !qrData && (
                <div className="bg-white/70 backdrop-blur-2xl border border-white/80 rounded-[3rem] p-12 text-center max-w-lg mx-auto shadow-2xl flex flex-col items-center justify-center gap-6">
                    <div className="w-16 h-16 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin"></div>
                    <div>
                        <span className="block font-extrabold text-slate-800 text-xl tracking-tight mb-1">Arrancando motor WhatsApp...</span>
                        <span className="block text-slate-500 text-sm font-medium">En breves segundos estará listo.</span>
                    </div>
                </div>
            )}

            {/* A. KPI DECK V3 - Glassmorphism Edition */}
            <StatsPanelV3 stats={stats} loadingStats={loadingStats} alertsCount={alerts.length} />

            {/* B. MAIN GRID V3 */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8 pb-10">
                {/* B1. ALERTS V3 - Col Span 2 */}
                <AlertsPanelV3 alerts={alerts} onCommand={handleAdminCommand} onQuickAction={handleQuickAction} />

                {/* B2. SYSTEM STATUS V3 - Col Span 1 */}
                <SystemStatusPanelV3 status={status} activeConversations={stats?.activeConversations} adminNumbers={adminNumbers} onAddPhone={handleAddPhone} onRemovePhone={handleRemovePhone} onRegenerateQR={handleRegenerateQR} />
            </div>

        </div>
    );
};

export default DashboardViewV3;
