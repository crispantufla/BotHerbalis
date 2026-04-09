import React, { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import api from '../../config/axios';
import { useToast } from '../ui/Toast';

import StatsPanel from './dashboard/StatsPanel';
import AlertsPanel from './dashboard/AlertsPanel';
import SystemStatusPanel from './dashboard/SystemStatusPanel';

const DashboardView = ({ alerts = [], config, handleQuickAction, status, qrData }) => {
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
                toast.success('Código de vinculación generado');
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
        if (status === 'ready') {
            const ok = await confirm('¿Desconectar WhatsApp y generar un nuevo código QR?');
            if (!ok) return;
            try {
                await api.post('/api/whatsapp-logout');
                toast.success('Desconectado. Generando nuevo QR...');
            } catch (e) { toast.error('Error al desconectar'); }
        } else {
            // Not connected — just trigger a fresh start
            try {
                await api.post('/api/whatsapp-logout');
                toast.success('Generando código QR...');
            } catch (e) { toast.error('Error al generar QR'); }
        }
    };

    // MercadoPago link generator
    const [mpAmount, setMpAmount] = useState('');
    const [mpLink, setMpLink] = useState('');
    const [mpLoading, setMpLoading] = useState(false);
    const [mpCopied, setMpCopied] = useState(false);

    const handleGenerateMpLink = async () => {
        const amount = parseFloat(mpAmount.replace(',', '.'));
        if (!amount || amount <= 0) { toast.warning('Ingresá un monto válido'); return; }
        setMpLoading(true);
        setMpLink('');
        try {
            const res = await api.post('/api/mp-link', { amount });
            setMpLink(res.data.link);
        } catch (e) {
            toast.error(e.response?.data?.error || 'Error generando enlace');
        } finally {
            setMpLoading(false);
        }
    };

    const handleCopyMpLink = () => {
        navigator.clipboard.writeText(mpLink);
        setMpCopied(true);
        setTimeout(() => setMpCopied(false), 2000);
    };

    const adminNumbers = config?.alertNumbers || (config?.alertNumber ? [config.alertNumber] : []);

    const isGlobalPause = !!stats?.globalPause;

    const handleToggleGlobalPause = async () => {
        try {
            const res = await api.post('/api/global-pause');
            setStats(prev => ({ ...prev, globalPause: res.data.globalPause }));
            toast.success(`Bot ${res.data.globalPause ? 'pausado' : 'reactivado'} globalmente`);
        } catch (e) {
            toast.error('Error cambiando el estado global del bot');
        }
    };

    return (
        <div className="space-y-4 sm:space-y-8 animate-fade-in relative z-10 w-full">
            {/* Header de la vista */}
            <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:justify-between sm:items-stretch gap-3 sm:gap-6 sm:h-[5.5rem]">
                <div className="flex flex-col justify-center">
                    <h1 className="text-xl sm:text-3xl 2xl:text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-700 to-purple-600 dark:from-indigo-400 dark:to-purple-400 leading-none mb-1 sm:mb-2">
                        Dashboard Overview
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 text-sm font-medium 2xl:text-lg m-0 leading-none">Resumen del sistema y métricas en tiempo real</p>
                </div>

                {/* Global Pause Button */}
                <button
                    onClick={handleToggleGlobalPause}
                    className={`flex items-center justify-center gap-3 sm:gap-4 px-4 sm:px-6 py-3 sm:py-0 rounded-[1.25rem] font-bold transition-all shadow-sm w-full sm:w-72 sm:h-full ${isGlobalPause
                        ? 'bg-amber-100/90 dark:bg-amber-900/30 text-amber-800 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-800/50 border-2 border-amber-200 dark:border-amber-800/50 shadow-amber-500/20'
                        : 'bg-white dark:bg-slate-800/80 border-2 border-slate-100/80 dark:border-slate-700/80 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-100 dark:hover:border-indigo-800/50 hover:shadow-indigo-500/10'
                        }`}
                >
                    {isGlobalPause ? (
                        <>
                            <div className="w-10 h-10 sm:w-12 sm:h-12 flex items-center justify-center rounded-2xl bg-amber-500 text-white shadow-md shadow-amber-500/40 flex-shrink-0">
                                <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            </div>
                            <span className="text-left leading-tight text-[13px] sm:text-[15px] tracking-wide font-extrabold">Reactivar Bot<br />Global</span>
                        </>
                    ) : (
                        <>
                            <div className="w-10 h-10 sm:w-12 sm:h-12 flex items-center justify-center rounded-2xl bg-amber-50 dark:bg-amber-900/40 text-amber-500 shadow-inner border border-amber-100 dark:border-amber-800/50 flex-shrink-0">
                                <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            </div>
                            <span className="text-left leading-tight text-[13px] sm:text-[15px] tracking-wide font-extrabold">Pausar Bot<br />Global</span>
                        </>
                    )}
                </button>
            </div>

            {/* QR CODE OVERLAY - Glassmorphism style */}
            {status === 'scan_qr' && qrData && (
                <div className="bg-white/8 dark:bg-slate-800/80 dark:bg-slate-800/80 backdrop-blur-xl border border-white/4 dark:border-slate-700/40 dark:border-slate-700/40 shadow-2xl rounded-3xl p-10 text-center max-w-lg mx-auto transform transition-all hover:scale-[1.02]">
                    <div className="w-16 h-16 bg-gradient-to-tr from-blue-500 to-indigo-500 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-500/30">
                        <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                    </div>
                    <h3 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-700 to-purple-600 dark:from-indigo-400 dark:to-purple-400 mb-3">Vincular Dispositivo</h3>
                    <p className="text-slate-500 dark:text-slate-400 mb-4 font-medium">Abrí WhatsApp → Dispositivos vinculados</p>

                    {pairingCode ? (
                        <div className="mb-8">
                            <p className="text-sm font-bold text-indigo-600 dark:text-indigo-400 mb-2 uppercase tracking-wide">Código de Vinculación</p>
                            <div className="bg-slate-100 dark:bg-slate-900 rounded-xl p-6 text-4xl font-mono font-black tracking-[0.2em] text-slate-800 dark:text-slate-200 border-2 border-indigo-200 dark:border-indigo-800">
                                {pairingCode}
                            </div>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-4">Ingresa este código en tu celular principal de WhatsApp cuando te llegue la notificación.</p>
                            <button
                                onClick={() => setPairingCode('')}
                                className="mt-4 text-indigo-600 dark:text-indigo-400 text-sm font-semibold hover:underline"
                            >
                                ← Volver al código QR
                            </button>
                        </div>
                    ) : (
                        <>
                            <div className="inline-block p-4 bg-white dark:bg-white rounded-2xl border border-slate-100 dark:border-slate-700 shadow-inner mb-6">
                                <QRCodeSVG value={qrData} size={256} level="M" />
                            </div>

                            <div className="border-t border-slate-200 dark:border-slate-700/50 pt-6 mt-2">
                                <p className="text-sm font-medium text-slate-600 dark:text-slate-300 mb-3">¿No podés escanear el QR?</p>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        placeholder="Ej: 5493415555555"
                                        value={pairingPhone}
                                        onChange={(e) => setPairingPhone(e.target.value)}
                                        className="flex-1 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all placeholder-slate-400 dark:placeholder-slate-500 text-slate-800 dark:text-slate-100"
                                    />
                                    <button
                                        onClick={handleRequestPairingCode}
                                        disabled={loadingPairing || !pairingPhone}
                                        className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 disabled:opacity-50 text-white px-6 py-2 rounded-xl font-bold transition-all shadow-md shadow-indigo-500/30"
                                    >
                                        {loadingPairing ? '...' : 'Generar Código'}
                                    </button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            )}

            {((status === 'scan_qr' && !qrData) || status === 'initializing') && (
                <div className="bg-white/6 dark:bg-slate-800/60 dark:bg-slate-800/60 backdrop-blur-lg border border-white dark:border-slate-700/50 rounded-3xl p-8 text-center max-w-lg mx-auto shadow-xl">
                    <div className="flex flex-col items-center justify-center gap-4">
                        <div className="w-12 h-12 border-4 border-indigo-200 dark:border-indigo-900 border-t-indigo-600 dark:border-t-indigo-500 rounded-full animate-spin"></div>
                        <span className="font-bold text-indigo-800 dark:text-indigo-400 text-lg">Preparando WhatsApp...</span>
                        <span className="text-slate-500 dark:text-slate-400 text-sm">El código QR aparecerá en unos segundos</span>
                    </div>
                </div>
            )}

            {/* A. KPI DECK V2 */}
            <StatsPanel stats={stats} loadingStats={loadingStats} alertsCount={alerts.length} />

            {/* B. MAIN GRID V2 */}
            <div className="grid grid-cols-1 lg:grid-cols-3 2xl:grid-cols-5 gap-4 sm:gap-8">
                {/* B1. ALERTS V2 — takes 2/3 on lg, 3/5 on 2xl */}
                <div className="lg:col-span-2 2xl:col-span-3">
                    <AlertsPanel alerts={alerts} onCommand={handleAdminCommand} onQuickAction={handleQuickAction} />
                </div>

                {/* B2. SYSTEM STATUS + MP WIDGET — takes 1/3 on lg, 2/5 on 2xl */}
                <div className="lg:col-span-1 2xl:col-span-2 flex flex-col gap-4 sm:gap-8">
                    <SystemStatusPanel status={status} activeConversations={stats?.activeConversations} adminNumbers={adminNumbers} onAddPhone={handleAddPhone} onRemovePhone={handleRemovePhone} onRegenerateQR={handleRegenerateQR} />

                    {/* C. MERCADOPAGO LINK GENERATOR */}
                    <div className="bg-white dark:bg-slate-800/80 border border-slate-100/80 dark:border-slate-700/80 rounded-2xl p-4 shadow-sm">
                        <div className="flex items-center gap-2 mb-3">
                            <div className="w-7 h-7 flex items-center justify-center rounded-lg bg-sky-50 dark:bg-sky-900/30 text-sky-500 border border-sky-100 dark:border-sky-800/50 flex-shrink-0">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>
                            </div>
                            <span className="font-bold text-slate-700 dark:text-slate-200 text-xs uppercase tracking-wide">Enlace de Pago · MP</span>
                        </div>
                        <div className="flex gap-2">
                            <div className="relative flex-1">
                                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold text-xs">$</span>
                                <input
                                    type="number"
                                    min="1"
                                    placeholder="Monto"
                                    value={mpAmount}
                                    onChange={e => { setMpAmount(e.target.value); setMpLink(''); }}
                                    onKeyDown={e => e.key === 'Enter' && handleGenerateMpLink()}
                                    className="w-full pl-6 pr-2 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-900/50 text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500 transition-all text-xs"
                                />
                            </div>
                            <button
                                onClick={handleGenerateMpLink}
                                disabled={mpLoading || !mpAmount}
                                className="px-3 py-2 rounded-lg bg-sky-500 hover:bg-sky-600 disabled:opacity-50 text-white font-bold text-xs transition-all shadow-sm shadow-sky-500/30 flex-shrink-0"
                            >
                                {mpLoading ? (
                                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                                ) : 'Generar'}
                            </button>
                        </div>
                        {mpLink && (
                            <div className="mt-2 flex items-center gap-2 bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5">
                                <a href={mpLink} target="_blank" rel="noopener noreferrer" className="flex-1 text-sky-600 dark:text-sky-400 text-xs truncate hover:underline">{mpLink}</a>
                                <button
                                    onClick={handleCopyMpLink}
                                    className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold transition-all flex-shrink-0 ${mpCopied ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-sky-100 dark:hover:bg-sky-900/30 hover:text-sky-600'}`}
                                >
                                    {mpCopied ? (
                                        <><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7"/></svg>OK</>
                                    ) : (
                                        <><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3"/></svg>Copiar</>
                                    )}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default DashboardView;
