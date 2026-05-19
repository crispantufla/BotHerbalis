import React, { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Pause, Play, CreditCard, Copy, Check, Smartphone, Clock } from 'lucide-react';
import api from '../../config/axios';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../context/AuthContext';
import { Button, Card, Input, IconButton } from '../ui';

import StatsPanel from './dashboard/StatsPanel';
import AlertsPanel from './dashboard/AlertsPanel';
import SystemStatusPanel from './dashboard/SystemStatusPanel';

const DashboardView = ({ alerts = [], config, handleQuickAction, status, qrData }) => {
    const { toast, confirm } = useToast();
    const { isAdmin, user } = useAuth();
    // "Pausar todos" lo puede usar:
    //   - Admin global (sin sellerId), Y/O
    //   - El dueño explícito Horacio (tenant admin con sellerId='horacio')
    // Acordado con el cliente: Horacio es el único tenant admin con poder
    // sobre toda la flota.
    const userName = (user?.name || '').toLowerCase();
    const userSellerId = (user?.sellerId || '').toLowerCase();
    const canPauseAll = isAdmin && (!user?.sellerId || userName === 'horacio' || userSellerId === 'horacio');
    const [stats, setStats] = useState(null);
    const [loadingStats, setLoadingStats] = useState(true);
    const [pausingAll, setPausingAll] = useState(false);

    // Pairing code states
    const [pairingPhone, setPairingPhone] = useState('');
    const [pairingCode, setPairingCode] = useState('');
    const [loadingPairing, setLoadingPairing] = useState(false);

    useEffect(() => {
        const fetchStats = async () => {
            try {
                // Admins: vista agregada de todos los vendedores (header vacío
                // → backend interpreta como "todos"). Sellers: scoped.
                const opts = isAdmin ? { headers: { 'x-seller-id': '' } } : {};
                const res = await api.get('/api/stats', opts);
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
    }, [isAdmin]);

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

    // Pausa SOLO el bot del vendedor seleccionado (o del usuario logueado si es
    // un seller). El endpoint /api/global-pause respeta el x-seller-id del header.
    const handleToggleThisBot = async () => {
        try {
            const res = await api.post('/api/global-pause');
            setStats(prev => ({ ...prev, globalPause: res.data.globalPause }));
            toast.success(`Bot ${res.data.globalPause ? 'pausado' : 'reactivado'}`);
        } catch (e) {
            toast.error('Error cambiando el estado del bot');
        }
    };

    // Pausa TODOS los bots (todos los sellers activos). Solo admin global.
    const handlePauseAll = async () => {
        const ok = await confirm('¿Pausar el bot de TODOS los vendedores?\n\nEsta acción afecta a todos los sellers activos. Para reactivar, repetí la operación o destrabá cada uno individualmente.');
        if (!ok) return;
        setPausingAll(true);
        try {
            const res = await api.post('/api/global-pause-all', { pause: true });
            toast.success(`${res.data.affected || 0} bots pausados`);
            // Recargamos stats para reflejar el nuevo estado global.
            const opts = isAdmin ? { headers: { 'x-seller-id': '' } } : {};
            const fresh = await api.get('/api/stats', opts);
            setStats(fresh.data);
        } catch (e) {
            toast.error(e.response?.data?.error || 'Error pausando todos los bots');
        } finally {
            setPausingAll(false);
        }
    };

    const handleReactivateAll = async () => {
        const ok = await confirm('¿Reactivar el bot de TODOS los vendedores?');
        if (!ok) return;
        setPausingAll(true);
        try {
            const res = await api.post('/api/global-pause-all', { pause: false });
            toast.success(`${res.data.affected || 0} bots reactivados`);
            const opts = isAdmin ? { headers: { 'x-seller-id': '' } } : {};
            const fresh = await api.get('/api/stats', opts);
            setStats(fresh.data);
        } catch (e) {
            toast.error(e.response?.data?.error || 'Error reactivando todos los bots');
        } finally {
            setPausingAll(false);
        }
    };

    return (
        <div className="space-y-5 sm:space-y-7 animate-fade-in relative z-10 w-full">
            {/* Header de la vista */}
            <header className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 sm:gap-4">
                <div className="min-w-0">
                    <h1 className="text-display text-slate-900 dark:text-slate-100">Dashboard</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        Resumen del sistema y métricas en tiempo real.
                    </p>
                </div>

                {/* Botones de pausa: "Este bot" (siempre) + "Todos" (solo admin global) */}
                <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                    <Button
                        variant={isGlobalPause ? 'subtle' : 'secondary'}
                        leftIcon={isGlobalPause ? Play : Pause}
                        onClick={handleToggleThisBot}
                        className={isGlobalPause ? '!bg-warning-50 dark:!bg-warning-900/20 !text-warning-700 dark:!text-warning-500 !border-warning-100 dark:!border-warning-900/50 hover:!bg-warning-100 dark:hover:!bg-warning-900/40' : ''}
                    >
                        {isGlobalPause ? 'Reactivar este bot' : 'Pausar este bot'}
                    </Button>

                    {canPauseAll && (
                        <Button
                            variant="secondary"
                            leftIcon={Pause}
                            onClick={handlePauseAll}
                            loading={pausingAll}
                            className="!text-danger-700 dark:!text-danger-500 !border-danger-100 dark:!border-danger-900/50 hover:!bg-danger-50 dark:hover:!bg-danger-900/20"
                        >
                            Pausar TODOS
                        </Button>
                    )}
                </div>
            </header>

            {/* QR / Loading / Timeout */}
            {status === 'scan_qr' && qrData && (
                <Card padding="lg" className="max-w-lg mx-auto text-center">
                    <div className="w-12 h-12 rounded-card bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400 flex items-center justify-center mx-auto mb-4">
                        <Smartphone className="w-6 h-6" aria-hidden="true" />
                    </div>
                    <h2 className="text-h2 text-slate-900 dark:text-slate-100 mb-1">Vincular dispositivo</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">
                        Abrí WhatsApp → Dispositivos vinculados
                    </p>

                    {pairingCode ? (
                        <div>
                            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
                                Código de vinculación
                            </p>
                            <div className="bg-slate-100 dark:bg-slate-900/60 rounded-card px-6 py-5 text-3xl font-mono font-semibold tracking-[0.2em] text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700">
                                {pairingCode}
                            </div>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-3">
                                Ingresá este código en tu celular cuando llegue la notificación.
                            </p>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setPairingCode('')}
                                className="mt-3"
                            >
                                ← Volver al código QR
                            </Button>
                        </div>
                    ) : (
                        <>
                            <div className="inline-block p-4 bg-white rounded-card border border-slate-200 mb-5">
                                <QRCodeSVG value={qrData} size={224} level="M" />
                            </div>
                            <div className="pt-5 border-t border-slate-200 dark:border-slate-700/70">
                                <p className="text-sm text-slate-600 dark:text-slate-300 mb-3 font-medium">
                                    ¿No podés escanear el QR?
                                </p>
                                <div className="flex gap-2">
                                    <Input
                                        value={pairingPhone}
                                        onChange={(e) => setPairingPhone(e.target.value)}
                                        placeholder="Ej: 5493415555555"
                                        aria-label="Teléfono para código de vinculación"
                                    />
                                    <Button
                                        onClick={handleRequestPairingCode}
                                        loading={loadingPairing}
                                        disabled={!pairingPhone}
                                        className="flex-shrink-0"
                                    >
                                        Generar código
                                    </Button>
                                </div>
                            </div>
                        </>
                    )}
                </Card>
            )}

            {((status === 'scan_qr' && !qrData) || status === 'initializing') && (
                <Card padding="lg" className="max-w-lg mx-auto text-center">
                    <div className="flex flex-col items-center justify-center gap-3">
                        <div className="w-10 h-10 border-[3px] border-accent-200 dark:border-accent-900 border-t-accent-600 dark:border-t-accent-500 rounded-full animate-spin" />
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Preparando WhatsApp…</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">El código QR aparecerá en unos segundos</p>
                    </div>
                </Card>
            )}

            {status === 'qr_timeout' && (
                <Card padding="lg" className="max-w-lg mx-auto text-center border-warning-200 dark:border-warning-900/50">
                    <div className="w-12 h-12 rounded-card bg-warning-50 dark:bg-warning-900/30 text-warning-600 dark:text-warning-500 flex items-center justify-center mx-auto mb-3">
                        <Clock className="w-6 h-6" aria-hidden="true" />
                    </div>
                    <p className="text-sm font-semibold text-warning-700 dark:text-warning-500">QR expirado</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 max-w-sm mx-auto">
                        El código no fue escaneado a tiempo. Presioná "Regenerar QR" para volver a generar uno nuevo.
                    </p>
                </Card>
            )}

            {/* KPI deck */}
            <StatsPanel stats={stats} loadingStats={loadingStats} alertsCount={alerts.length} />

            {/* Main grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 2xl:grid-cols-5 gap-4 sm:gap-6">
                <div className="lg:col-span-2 2xl:col-span-3">
                    <AlertsPanel alerts={alerts} onCommand={handleAdminCommand} onQuickAction={handleQuickAction} />
                </div>

                <div className="lg:col-span-1 2xl:col-span-2 flex flex-col gap-4 sm:gap-6">
                    <SystemStatusPanel
                        status={status}
                        activeConversations={stats?.activeConversations}
                        adminNumbers={adminNumbers}
                        onAddPhone={handleAddPhone}
                        onRemovePhone={handleRemovePhone}
                        onRegenerateQR={handleRegenerateQR}
                    />

                    {/* MercadoPago Link Generator */}
                    <Card padding="md">
                        <div className="flex items-center gap-2 mb-3">
                            <div className="w-8 h-8 rounded-control bg-info-50 dark:bg-info-900/30 text-info-600 dark:text-info-500 flex items-center justify-center flex-shrink-0">
                                <CreditCard className="w-4 h-4" aria-hidden="true" />
                            </div>
                            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                                Enlace de pago — MP
                            </h3>
                        </div>
                        <div className="flex gap-2">
                            <Input
                                type="number"
                                min="1"
                                placeholder="Monto"
                                value={mpAmount}
                                onChange={e => { setMpAmount(e.target.value); setMpLink(''); }}
                                onKeyDown={e => e.key === 'Enter' && handleGenerateMpLink()}
                                aria-label="Monto en pesos"
                                leftIcon={() => <span className="text-slate-400 font-medium">$</span>}
                            />
                            <Button
                                onClick={handleGenerateMpLink}
                                loading={mpLoading}
                                disabled={!mpAmount}
                                className="flex-shrink-0"
                            >
                                Generar
                            </Button>
                        </div>
                        {mpLink && (
                            <div className="mt-3 flex items-center gap-2 bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700/70 rounded-control px-3 py-2">
                                <a
                                    href={mpLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex-1 text-info-600 dark:text-info-500 text-xs font-medium truncate hover:underline"
                                >
                                    {mpLink}
                                </a>
                                <IconButton
                                    label={mpCopied ? 'Copiado' : 'Copiar enlace'}
                                    icon={mpCopied ? Check : Copy}
                                    variant={mpCopied ? 'subtle' : 'ghost'}
                                    size="sm"
                                    onClick={handleCopyMpLink}
                                    className={mpCopied ? '!bg-success-50 dark:!bg-success-900/30 !text-success-600 dark:!text-success-500' : ''}
                                />
                            </div>
                        )}
                    </Card>
                </div>
            </div>
        </div>
    );
};

export default DashboardView;
