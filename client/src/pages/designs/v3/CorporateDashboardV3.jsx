import React, { useState, useEffect, useCallback } from 'react';
import api from '../../../config/axios';
import { useSocket } from '../../../context/SocketContext';
import { useAuth } from '../../../context/AuthContext';
import { useToast } from '../../../components/ui/Toast';

import DashboardViewV3 from '../../../components/corporate/v3/DashboardViewV3';
import CommsViewV3 from '../../../components/corporate/v3/CommsViewV3';
import SalesViewV3 from '../../../components/corporate/v3/SalesViewV3';
import SettingsViewV3 from '../../../components/corporate/v3/SettingsViewV3';
import ScriptViewV3 from '../../../components/corporate/v3/ScriptViewV3';
import GalleryViewV3 from '../../../components/corporate/v3/GalleryViewV3';

// Iconos estilizados (Duotone / Outline limpio) para V3
const IconsV3 = {
    Chart: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-blue-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>,
    Wifi: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-blue-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" /></svg>,
    Message: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-blue-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>,
    Box: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-blue-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>,
    Sparkles: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-blue-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>,
    Photos: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-blue-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
    Settings: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-blue-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
    Logout: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>,
    Menu: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" /></svg>,
    X: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
};

const CorporateDashboardV3 = () => {
    const { socket } = useSocket();
    const { logout } = useAuth();
    const { toast } = useToast();
    const [status, setStatus] = useState('initializing');
    const [alerts, setAlerts] = useState([]);
    const [activeTab, setActiveTab] = useState('dashboard');
    const [qrData, setQrData] = useState(null);
    const [config, setConfig] = useState({ alertNumbers: [] });
    const [targetChatId, setTargetChatId] = useState(null);
    const [isMobile, setIsMobile] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    // Detección de Mobile
    useEffect(() => {
        const checkMobile = () => {
            setIsMobile(window.innerWidth < 1024);
        };
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    const fetchConfig = useCallback(async () => {
        try {
            const res = await api.get('/api/status');
            if (res.data.config) setConfig(res.data.config);
        } catch (e) { }
    }, []);

    useEffect(() => {
        if (socket) {
            socket.on('qr', (data) => { setStatus('scan_qr'); setQrData(data); });
            socket.on('ready', () => { setStatus('ready'); setQrData(null); });
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
            } catch (e) { }
        }
        loadData();

        const handleConfigUpdate = () => fetchConfig();
        window.addEventListener('config-updated', handleConfigUpdate);
        return () => window.removeEventListener('config-updated', handleConfigUpdate);
    }, [socket, fetchConfig]);

    const handleQuickAction = async (chatId, action) => {
        if (action === 'chat') {
            setTargetChatId(chatId);
            setActiveTab('comms');
            return;
        }

        if (action === 'descartar') {
            setAlerts(prev => prev.filter(a => a.userPhone !== chatId));
            return;
        }

        try {
            await api.post('/api/admin-command', { chatId, command: action });
            setAlerts(prev => prev.filter(a => a.userPhone !== chatId));
            toast.success(`Acción ejecutada: ${action}`);
        } catch (e) { toast.error('Error ejecutando acción'); }
    };

    const renderContent = () => {
        switch (activeTab) {
            case 'dashboard': return <DashboardViewV3 alerts={alerts} config={config} handleQuickAction={handleQuickAction} status={status} qrData={qrData} />;
            case 'comms': return <CommsViewV3 initialChatId={targetChatId} onChatSelected={() => setTargetChatId(null)} />;
            case 'logistics': return <SalesViewV3 onGoToChat={(chatId) => handleQuickAction(chatId, 'chat')} />;
            case 'script': return <ScriptViewV3 />;
            case 'gallery': return <GalleryViewV3 />;
            case 'settings': return <SettingsViewV3 status={status} />;
            default: return <DashboardViewV3 alerts={alerts} config={config} handleQuickAction={handleQuickAction} status={status} qrData={qrData} />;
        }
    };

    const NavItem = ({ tab, icon: Icon, label, badgeCount }) => {
        const isActive = activeTab === tab;
        return (
            <button
                onClick={() => { setActiveTab(tab); if (isMobile) setMobileMenuOpen(false); }}
                className={`w-full flex items-center justify-between px-4 py-3 mb-1.5 rounded-2xl transition-all duration-300 group
                ${isActive
                        ? 'bg-blue-600/10 text-blue-700 font-semibold shadow-sm'
                        : 'text-slate-500 hover:bg-slate-100/50 hover:text-slate-800'}`}
            >
                <div className="flex items-center gap-3">
                    <div className="transition-transform duration-300 group-hover:scale-110">
                        <Icon active={isActive} />
                    </div>
                    <span className="text-sm tracking-wide">{label}</span>
                </div>
                {badgeCount > 0 && (
                    <span className="bg-rose-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                        {badgeCount}
                    </span>
                )}
            </button>
        );
    };

    return (
        <div className="flex h-screen bg-[#FDFDFD] font-sans text-slate-800 overflow-hidden w-full relative">

            {/* Background Blur Spheres para darle un toque Apple/Stripe */}
            <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full bg-blue-100/40 blur-[100px] pointer-events-none hidden lg:block"></div>
            <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] rounded-full bg-indigo-100/40 blur-[120px] pointer-events-none hidden lg:block"></div>

            {/* Overlay para Mobile */}
            {isMobile && mobileMenuOpen && (
                <div
                    className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-40 transition-opacity"
                    onClick={() => setMobileMenuOpen(false)}
                />
            )}

            {/* SIDEBAR V3 - Glassmorphism Light */}
            <aside className={`
                fixed lg:relative z-50 lg:z-10 flex flex-col h-full bg-white/80 backdrop-blur-2xl border-r border-slate-200/50
                transition-transform duration-300 ease-out w-72 lg:w-[280px]
                ${isMobile && !mobileMenuOpen ? '-translate-x-full' : 'translate-x-0'}
            `}>
                {/* Logo Area */}
                <div className="h-20 flex items-center justify-between px-6">
                    <div className="flex items-center gap-3 w-full">
                        <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center shadow-md shadow-blue-500/20">
                            <span className="text-white font-extrabold text-lg">H</span>
                        </div>
                        <div>
                            <h1 className="font-bold text-slate-900 tracking-tight leading-none text-[17px]">Herbalis Dashboard</h1>
                            <p className="text-[11px] font-semibold text-slate-500 mt-1 uppercase tracking-wider">Workspace V3</p>
                        </div>
                    </div>
                    {isMobile && (
                        <button onClick={() => setMobileMenuOpen(false)} className="text-slate-400 hover:text-slate-700 p-2">
                            <IconsV3.X />
                        </button>
                    )}
                </div>

                {/* Nav Links */}
                <div className="flex-1 px-4 py-6 space-y-1 overflow-y-auto hide-scrollbar">
                    <p className="px-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Principal</p>
                    <NavItem tab="dashboard" icon={IconsV3.Wifi} label="Resumen General" badgeCount={alerts.length} />
                    <NavItem tab="comms" icon={IconsV3.Message} label="Comunicaciones" />
                    <NavItem tab="logistics" icon={IconsV3.Box} label="Ventas & Envíos" />

                    <div className="mt-8 mb-3">
                        <p className="px-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Ventas IA</p>
                    </div>
                    <NavItem tab="script" icon={IconsV3.Sparkles} label="Guiones & Comportamiento" />
                    <NavItem tab="gallery" icon={IconsV3.Photos} label="Galería Multimedia" />

                    <div className="mt-8 mb-3">
                        <p className="px-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Sistema</p>
                    </div>
                    <NavItem tab="settings" icon={IconsV3.Settings} label="Configuración" />
                </div>

                {/* Logout Footer */}
                <div className="p-4 mt-auto">
                    <button
                        onClick={logout}
                        className="w-full flex items-center px-4 py-3 rounded-2xl text-slate-500 hover:bg-rose-50 hover:text-rose-600 transition-all duration-300 group"
                    >
                        <div className="mr-3 group-hover:-translate-x-1 transition-transform">
                            <IconsV3.Logout />
                        </div>
                        <span className="font-medium text-sm">Cerrar Sesión</span>
                    </button>
                </div>
            </aside>

            {/* MAIN CONTENT CONTAINER */}
            <div className="flex-1 flex flex-col relative z-0 h-full w-full">
                {/* Topbar Light V3 */}
                <header className="h-16 lg:h-20 bg-transparent flex justify-between items-center px-6 lg:px-10 shrink-0">
                    <div className="flex items-center gap-4">
                        {isMobile && (
                            <button
                                onClick={() => setMobileMenuOpen(true)}
                                className="p-2 -ml-2 rounded-xl text-slate-600 hover:bg-white hover:shadow-sm transition-all"
                            >
                                <IconsV3.Menu />
                            </button>
                        )}
                        <h2 className="text-xl font-bold text-slate-800 tracking-tight capitalize hidden sm:block">
                            {activeTab === 'dashboard' ? 'Resumen' :
                                activeTab === 'comms' ? 'Comunicaciones' :
                                    activeTab === 'logistics' ? 'Ventas' :
                                        activeTab === 'script' ? 'Guión y Prompts' :
                                            activeTab === 'gallery' ? 'Galería' : 'Configuración'}
                        </h2>
                    </div>

                    <div className="flex items-center gap-4 lg:gap-6 bg-white/60 backdrop-blur-xl px-4 py-2 rounded-2xl border border-slate-200/60 shadow-sm">
                        <div className="flex items-center gap-2 border-r border-slate-200 pr-4">
                            <div className="relative flex items-center justify-center">
                                {status === 'ready' && <div className="absolute w-2 h-2 bg-emerald-400 rounded-full animate-ping opacity-75"></div>}
                                <div className={`relative w-2 h-2 rounded-full ${status === 'ready' ? 'bg-emerald-500' : 'bg-rose-500'}`}></div>
                            </div>
                            <span className={`text-[11px] font-bold tracking-widest uppercase ${status === 'ready' ? 'text-emerald-700' : 'text-rose-600'}`}>
                                {status === 'ready' ? 'Online' : 'Offline'}
                            </span>
                        </div>

                        <div className="flex items-center gap-3">
                            <div className="text-right hidden sm:block">
                                <p className="text-[13px] font-bold text-slate-800 leading-tight">Administrador</p>
                            </div>
                            <div className="w-8 h-8 rounded-full bg-slate-900 flex items-center justify-center">
                                <span className="text-white font-bold text-xs">AD</span>
                            </div>
                        </div>
                    </div>
                </header>

                {/* Sub-view Content Area */}
                <main className="flex-1 overflow-y-auto px-4 lg:px-10 pb-10 hide-scrollbar">
                    {renderContent()}
                </main>
            </div>
        </div>
    );
};

export default CorporateDashboardV3;
