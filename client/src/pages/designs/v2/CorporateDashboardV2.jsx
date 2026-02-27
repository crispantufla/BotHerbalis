import React, { useState, useEffect, useCallback } from 'react';
import api from '../../../config/axios';
import { useSocket } from '../../../context/SocketContext';
import { useAuth } from '../../../context/AuthContext';
import { Link } from 'react-router-dom';
import { useToast } from '../../../components/ui/Toast';
import { useTheme } from '../../../context/ThemeContext';

import DashboardViewV2 from '../../../components/corporate/v2/DashboardViewV2';
import CommsViewV2 from '../../../components/corporate/v2/CommsViewV2';
import SalesViewV2 from '../../../components/corporate/v2/SalesViewV2';
import SettingsViewV2 from '../../../components/corporate/v2/SettingsViewV2';
import ScriptViewV2 from '../../../components/corporate/v2/ScriptViewV2';
import GalleryViewV2 from '../../../components/corporate/v2/GalleryViewV2';

import { Wifi, MessageCircle, Database, Settings, FileText, ImageIcon, LogOut, Menu, X, Moon, Sun } from 'lucide-react';

const CorporateDashboardV2 = () => {
    const { socket } = useSocket();
    const { logout } = useAuth();
    const { toast } = useToast();
    const { isDark, toggleTheme } = useTheme();
    const [status, setStatus] = useState('initializing');
    const [alerts, setAlerts] = useState([]);
    const [activeTab, setActiveTab] = useState('dashboard');
    const [qrData, setQrData] = useState(null);
    const [config, setConfig] = useState({ alertNumbers: [] });
    const [connectedPhone, setConnectedPhone] = useState(null);
    const [targetChatId, setTargetChatId] = useState(null);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    // Detección de Mobile
    useEffect(() => {
        const checkMobile = () => {
            setIsMobile(window.innerWidth < 1024);
            if (window.innerWidth < 1024) {
                setSidebarCollapsed(true);
            }
        };
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    const fetchConfig = useCallback(async () => {
        try {
            const res = await api.get('/api/status');
            if (res.data.config) setConfig(res.data.config);
            if (res.data.info?.wid?.user) setConnectedPhone(res.data.info.wid.user);
        } catch (e) { }
    }, []);

    useEffect(() => {
        if (socket) {
            socket.on('qr', (data) => { setStatus('scan_qr'); setQrData(data); });
            socket.on('ready', () => { setStatus('ready'); setQrData(null); fetchConfig(); });
            socket.on('status_change', ({ status: newStatus }) => {
                if (newStatus === 'disconnected') {
                    setStatus('scan_qr');
                    setQrData(null);
                } else {
                    setStatus(newStatus);
                }
            });
            socket.on('new_alert', (newAlert) => {
                setAlerts(prev => [newAlert, ...prev]);
            });
            socket.on('alerts_updated', (updated) => setAlerts(updated));
        }

        const loadData = async () => {
            try {
                const [alertRes, statusRes] = await Promise.all([
                    api.get('/api/alerts'),
                    api.get('/api/status')
                ]);
                setAlerts(alertRes.data);
                if (statusRes.data.config) setConfig(statusRes.data.config);
                if (statusRes.data.info?.wid?.user) setConnectedPhone(statusRes.data.info.wid.user);
            } catch (e) { }
        }
        loadData();

        const handleConfigUpdate = () => fetchConfig();
        window.addEventListener('config-updated', handleConfigUpdate);
        return () => window.removeEventListener('config-updated', handleConfigUpdate);
    }, [socket, fetchConfig]);

    const [processingAction, setProcessingAction] = useState(null); // Prevent double-click

    const handleQuickAction = async (chatId, action, sellerPhone) => {
        if (action === 'chat') {
            const toastId = toast.info('Buscando chat...');
            try {
                const statusRes = await api.get('/api/status');
                const connectedPhoneInfo = statusRes.data?.info?.wid?.user;
                const connectedPhone = connectedPhoneInfo || config.alertNumber; // Fallback

                if (sellerPhone && connectedPhone) {
                    const cleanedSeller = sellerPhone.replace(/\D/g, '');
                    const cleanedConnected = connectedPhone.replace(/\D/g, '');
                    // Only block if we have both values perfectly and they differ
                    if (!cleanedSeller.endsWith(cleanedConnected) && !cleanedConnected.endsWith(cleanedSeller)) {
                        toast.dismiss(toastId);
                        toast.warning('Esta venta se hizo desde otro \u00fanumero.');
                        return; // Prevent redirecting
                    }
                }
            } catch (e) {
                // non-fatal, proceed
            }

            toast.dismiss(toastId);
            setTargetChatId(chatId);
            setActiveTab('comms');
            return;
        }

        if (action === 'descartar') {
            setAlerts(prev => prev.filter(a => a.userPhone !== chatId && a.userPhone !== `${chatId}@c.us`));
            try { await api.delete(`/api/alerts/${chatId}`); } catch (e) { /* silent */ }
            return;
        }

        // Prevent double-click
        const actionKey = `${chatId}_${action}`;
        if (processingAction === actionKey) return;
        setProcessingAction(actionKey);

        try {
            if (action === 'confirmar') {
                await api.post('/api/orders/manual-complete', { chatId });
            } else {
                await api.post('/api/admin-command', { chatId, command: action });
            }
            setAlerts(prev => prev.filter(a => a.userPhone !== chatId));
            toast.success(`Acción ejecutada: ${action}`);
        } catch (e) {
            toast.error('Error ejecutando acción: ' + (e.response?.data?.error || e.message));
        } finally {
            setProcessingAction(null);
        }
    };

    const renderContent = () => {
        switch (activeTab) {
            case 'dashboard': return <DashboardViewV2 alerts={alerts} config={config} handleQuickAction={handleQuickAction} status={status} qrData={qrData} />;
            case 'comms': return <CommsViewV2 initialChatId={targetChatId} onChatSelected={() => setTargetChatId(null)} />;
            case 'logistics': return <SalesViewV2 onGoToChat={(chatId) => handleQuickAction(chatId, 'chat')} />;
            case 'script': return <ScriptViewV2 />;
            case 'gallery': return <GalleryViewV2 />;
            case 'settings': return <SettingsViewV2 status={status} />;
            default: return <DashboardViewV2 alerts={alerts} config={config} handleQuickAction={handleQuickAction} status={status} qrData={qrData} />;
        }
    };

    const NavItem = ({ tab, icon: Icon, label }) => {
        const isActive = activeTab === tab;
        return (
            <button
                onClick={() => { setActiveTab(tab); if (isMobile) setMobileMenuOpen(false); }}
                className={`w-full flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center px-0' : 'px-4'} py-3 mb-2 rounded-xl transition-all duration-300 group
                ${isActive
                        ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-md shadow-indigo-500/30 border border-transparent'
                        : 'text-slate-600 hover:bg-white hover:text-indigo-600 hover:shadow-sm border border-transparent'}`}
                title={(sidebarCollapsed && !isMobile) ? label : ''}
            >
                <div className={`${(sidebarCollapsed && !isMobile) ? '' : 'mr-4'} transition-transform duration-300 group-hover:scale-110`}>
                    <Icon className={`w-5 h-5 ${isActive ? 'text-white' : 'text-slate-400'}`} strokeWidth={isActive ? 2.5 : 2} />
                </div>
                {(!sidebarCollapsed || isMobile) && <span className={`font-medium ${isActive ? 'text-white font-bold tracking-wide' : ''}`}>{label}</span>}
            </button>
        );
    };

    return (
        <div className="flex flex-col lg:flex-row h-[100dvh] bg-slate-50 dark:bg-slate-900 font-sans text-slate-800 dark:text-slate-100 overflow-hidden selection:bg-indigo-100 dark:selection:bg-indigo-900/50 selection:text-indigo-900 dark:selection:text-indigo-100 relative transition-colors duration-300">

            {/* Overlay para fondo oscurecido en Mobile al abrir el menú */}
            {isMobile && mobileMenuOpen && (
                <div
                    className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-30 transition-opacity"
                    onClick={() => setMobileMenuOpen(false)}
                />
            )}

            {/* 1. GLASSMORPHISM SIDEBAR V2 */}
            <aside className={`
                fixed lg:relative z-40 lg:z-20 flex flex-col h-full bg-white/95 dark:bg-slate-900/95 lg:bg-white/70 dark:lg:bg-slate-900/70 backdrop-blur-3xl border-r border-slate-200/60 dark:border-slate-700/60 shadow-[4px_0_24px_-12px_rgba(0,0,0,0.1)] dark:shadow-[4px_0_24px_-12px_rgba(0,0,0,0.5)] 
                transition-transform duration-300 ease-in-out lg:translate-x-0
                ${isMobile ? 'w-72 left-0 top-0 bottom-0' : (sidebarCollapsed ? 'w-20' : 'w-72')}
                ${isMobile && !mobileMenuOpen ? '-translate-x-full' : 'translate-x-0'}
            `}>

                {/* Logo & Toggle */}
                <div className="h-14 flex items-center justify-between px-6 border-b border-slate-200/50 dark:border-slate-700/50">
                    {(!sidebarCollapsed || isMobile) && (
                        <div className="flex items-center gap-3 animate-fade-in w-full justify-between lg:justify-start">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 shadow-lg shadow-indigo-500/30 flex items-center justify-center">
                                    <span className="text-white font-bold text-lg">H</span>
                                </div>
                                <div>
                                    <h1 className="font-bold text-slate-800 dark:text-slate-100 leading-tight">Herbalis</h1>
                                    <p className="text-[10px] font-semibold tracking-widest text-indigo-500 dark:text-indigo-400 uppercase">Workspace</p>
                                </div>
                            </div>
                            {isMobile && (
                                <button onClick={() => setMobileMenuOpen(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-2">
                                    <X className="w-5 h-5" />
                                </button>
                            )}
                        </div>
                    )}
                    {sidebarCollapsed && !isMobile && (
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 shadow-lg shadow-indigo-500/30 flex items-center justify-center mx-auto animate-fade-in">
                            <span className="text-white font-bold text-lg">H</span>
                        </div>
                    )}
                    {!isMobile && (
                        <button
                            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                            className={`p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-slate-100 transition-colors ${sidebarCollapsed ? 'hidden' : 'block'}`}
                        >
                            <Menu className="w-5 h-5" />
                        </button>
                    )}
                </div>

                <div className="flex-1 py-6 px-4 space-y-1 overflow-y-auto hide-scrollbar">
                    <NavItem tab="dashboard" icon={Wifi} label="Inicio" />
                    <NavItem tab="comms" icon={MessageCircle} label="Chat & Atencion" />
                    <NavItem tab="logistics" icon={Database} label="Ventas & Logística" />
                    <NavItem tab="script" icon={FileText} label="Guión & Prompts" />
                    <NavItem tab="gallery" icon={ImageIcon} label="Galería de Medios" />

                    <div className="pt-6 mt-6 border-t border-slate-200/50 dark:border-slate-700/50">
                        {(!sidebarCollapsed || isMobile) && <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-4 px-4">Administración</p>}
                        <NavItem tab="settings" icon={Settings} label="Configuración" />
                    </div>
                </div>

                {/* User Profile & Logout (Bottom) */}
                <div className="p-4 border-t border-slate-200/50 dark:border-slate-700/50 bg-white/40 dark:bg-slate-800/40">
                    {/* Theme Toggle */}
                    <button
                        onClick={toggleTheme}
                        className={`w-full flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center p-2' : 'px-4 py-3'} mb-2 rounded-xl transition-all duration-300 border border-transparent hover:border-indigo-200 dark:hover:border-indigo-800/50 group
                            ${isDark
                                ? 'bg-gradient-to-r from-indigo-500/10 to-purple-500/10 text-amber-400 hover:from-indigo-500/20 hover:to-purple-500/20'
                                : 'text-slate-500 hover:bg-slate-100 hover:text-indigo-600'
                            }`}
                        title={(sidebarCollapsed && !isMobile) ? (isDark ? 'Modo Claro' : 'Modo Oscuro') : ''}
                    >
                        <div className={`${(sidebarCollapsed && !isMobile) ? '' : 'mr-3'} group-hover:scale-110 transition-transform duration-300`}>
                            {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                        </div>
                        {(!sidebarCollapsed || isMobile) && <span className="font-medium text-sm">{isDark ? 'Modo Claro' : 'Modo Oscuro'}</span>}
                    </button>
                    <button
                        onClick={() => { logout(); if (isMobile) setMobileMenuOpen(false); }}
                        className={`w-full flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center p-2' : 'px-4 py-3'} rounded-xl bg-gradient-to-r hover:from-rose-50 hover:to-orange-50 text-rose-600 transition-all duration-300 border border-transparent hover:border-rose-200 group`}
                        title={(sidebarCollapsed && !isMobile) ? "Cerrar Sesión" : ""}
                    >
                        <div className={`${(sidebarCollapsed && !isMobile) ? '' : 'mr-3'} group-hover:scale-110 transition-transform`}>
                            <LogOut className="w-5 h-5" />
                        </div>
                        {(!sidebarCollapsed || isMobile) && <span className="font-medium text-sm">Cerrar Sesión</span>}
                    </button>
                </div>
            </aside>

            {/* 2. MAIN CONTENT AREA V2 */}
            <div className={`flex-1 flex flex-col overflow-hidden bg-gradient-to-br from-slate-50 dark:from-slate-900 to-blue-50/30 dark:to-indigo-900/10 w-full relative transition-all duration-300 ${!isMobile && !sidebarCollapsed ? '' : ''}`}>
                {/* Header Superior V2 */}
                <header className="flex-shrink-0 h-14 bg-white/60 dark:bg-slate-900/60 backdrop-blur-md border-b border-white dark:border-slate-800 flex justify-between items-center px-4 lg:px-8 z-10 shadow-sm shadow-slate-200/20 dark:shadow-black/20">
                    <div className="flex items-center gap-3 w-full lg:w-auto">
                        <button
                            onClick={() => isMobile ? setMobileMenuOpen(true) : setSidebarCollapsed(false)}
                            className={`p-2 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-white shadow-sm transition-colors border border-slate-200/50 block lg:hidden`}
                        >
                            <Menu className="w-5 h-5" />
                        </button>
                        {!isMobile && sidebarCollapsed && (
                            <button
                                onClick={() => setSidebarCollapsed(false)}
                                className={`p-2 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-white shadow-sm transition-colors border border-slate-200/50 block`}
                            >
                                <Menu className="w-5 h-5" />
                            </button>
                        )}

                        <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 lg:w-2.5 lg:h-2.5 rounded-full ${status === 'ready' ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-rose-500 animate-pulse'}`}></div>
                            <span className={`text-xs lg:text-sm font-semibold tracking-wide ${status === 'ready' ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'} whitespace-nowrap`}>
                                {status === 'ready' ? 'ONLINE' : 'OFFLINE'}
                            </span>
                            {status === 'ready' && connectedPhone && (
                                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-wider bg-slate-100 dark:bg-slate-800/80 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 ml-1">
                                    +{connectedPhone}
                                </span>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-2 lg:gap-6">
                        <div className="flex items-center gap-3 pl-6">
                            <div className="text-right hidden md:block">
                                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">Administrador</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">Root Access</p>
                            </div>
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center shadow-md shadow-indigo-500/30 border border-white/20">
                                <span className="text-white font-bold text-sm tracking-widest">AD</span>
                            </div>
                        </div>
                    </div>
                </header>

                {/* Área de Contenido Principal */}
                <main className="flex-1 relative flex flex-col min-h-0 overflow-hidden" onClick={() => { if (isMobile && mobileMenuOpen) setMobileMenuOpen(false); }}>
                    {/* Elementos decorativos de fondo (Blur Orbs) */}
                    <div className="absolute top-[-10%] right-[-5%] w-[60%] lg:w-[40%] h-[60%] lg:h-[40%] rounded-full bg-purple-300/20 dark:bg-purple-900/20 blur-[80px] lg:blur-[100px] pointer-events-none hidden sm:block"></div>
                    <div className="absolute bottom-[-10%] left-[-10%] w-[70%] lg:w-[50%] h-[70%] lg:h-[50%] rounded-full bg-blue-300/20 dark:bg-indigo-900/20 blur-[100px] lg:blur-[120px] pointer-events-none hidden sm:block"></div>

                    <div className="flex-1 p-3 sm:p-6 lg:p-8 relative z-0 w-full flex flex-col min-h-0 overflow-hidden overflow-y-auto custom-scrollbar">
                        {renderContent()}
                    </div>
                </main>
            </div>
        </div>
    );
};

export default CorporateDashboardV2;
