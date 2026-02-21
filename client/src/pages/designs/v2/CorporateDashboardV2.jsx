import React, { useState, useEffect, useCallback } from 'react';
import api from '../../../config/axios';
import { useSocket } from '../../../context/SocketContext';
import { useAuth } from '../../../context/AuthContext';
import { Link } from 'react-router-dom';
import { useToast } from '../../../components/ui/Toast';

import DashboardViewV2 from '../../../components/corporate/v2/DashboardViewV2';
import CommsViewV2 from '../../../components/corporate/v2/CommsViewV2';
import SalesViewV2 from '../../../components/corporate/v2/SalesViewV2';
import SettingsViewV2 from '../../../components/corporate/v2/SettingsViewV2';
import ScriptViewV2 from '../../../components/corporate/v2/ScriptViewV2';
import GalleryViewV2 from '../../../components/corporate/v2/GalleryViewV2';

// Iconos estilizados para V2
const IconsV2 = {
    Wifi: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-indigo-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" /></svg>,
    Message: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-indigo-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>,
    Database: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-indigo-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" /></svg>,
    Cog: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-indigo-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
    Scroll: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-indigo-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
    Photo: ({ active }) => <svg className={`w-5 h-5 ${active ? 'text-indigo-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? "2.5" : "2"} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
    Logout: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>,
    Menu: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" /></svg>,
    X: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
};

const CorporateDashboardV2 = () => {
    const { socket } = useSocket();
    const { logout } = useAuth();
    const { toast } = useToast();
    const [status, setStatus] = useState('initializing');
    const [alerts, setAlerts] = useState([]);
    const [activeTab, setActiveTab] = useState('dashboard');
    const [qrData, setQrData] = useState(null);
    const [config, setConfig] = useState({ alertNumbers: [] });
    const [targetChatId, setTargetChatId] = useState(null);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false); // Nuevo estado

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
                onClick={() => setActiveTab(tab)}
                className={`w-full flex items-center ${sidebarCollapsed ? 'justify-center px-0' : 'px-4'} py-3 mb-2 rounded-xl transition-all duration-300 group
                ${isActive
                        ? 'bg-gradient-to-r from-blue-500/10 to-indigo-500/10 text-indigo-700 shadow-sm border border-indigo-200/50'
                        : 'text-slate-600 hover:bg-white hover:shadow-sm border border-transparent'}`}
                title={sidebarCollapsed ? label : ''}
            >
                <div className={`${sidebarCollapsed ? '' : 'mr-4'} transition-transform duration-300 group-hover:scale-110`}>
                    <Icon active={isActive} />
                </div>
                {!sidebarCollapsed && <span className={`font-medium ${isActive ? 'text-indigo-700 font-semibold' : ''}`}>{label}</span>}
            </button>
        );
    };

    return (
        <div className="flex h-screen bg-slate-50 font-sans text-slate-800 overflow-hidden selection:bg-indigo-100 selection:text-indigo-900">
            {/* 1. GLASSMORPHISM SIDEBAR V2 */}
            <aside className={`relative z-20 flex flex-col backdrop-blur-2xl bg-white/70 border-r border-slate-200/60 shadow-[4px_0_24px_-12px_rgba(0,0,0,0.1)] transition-all duration-300 ease-in-out ${sidebarCollapsed ? 'w-20' : 'w-72'}`}>

                {/* Logo & Toggle */}
                <div className="h-20 flex items-center justify-between px-6 border-b border-slate-200/50">
                    {!sidebarCollapsed && (
                        <div className="flex items-center gap-3 animate-fade-in">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 shadow-lg shadow-indigo-500/30 flex items-center justify-center">
                                <span className="text-white font-bold text-lg">H</span>
                            </div>
                            <div>
                                <h1 className="font-bold text-slate-800 leading-tight">Herbalis</h1>
                                <p className="text-[10px] font-semibold tracking-widest text-indigo-500 uppercase">Workspace</p>
                            </div>
                        </div>
                    )}
                    {sidebarCollapsed && (
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 shadow-lg shadow-indigo-500/30 flex items-center justify-center mx-auto animate-fade-in">
                            <span className="text-white font-bold text-lg">H</span>
                        </div>
                    )}
                    <button
                        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                        className={`p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-slate-100 transition-colors ${sidebarCollapsed ? 'hidden' : 'block'}`}
                    >
                        <IconsV2.Menu />
                    </button>
                </div>

                <div className="flex-1 py-6 px-4 space-y-1 overflow-y-auto hide-scrollbar">
                    <NavItem tab="dashboard" icon={IconsV2.Wifi} label="Inicio" />
                    <NavItem tab="comms" icon={IconsV2.Message} label="Chat & Atencion" />
                    <NavItem tab="logistics" icon={IconsV2.Database} label="Ventas & Logística" />
                    <NavItem tab="script" icon={IconsV2.Scroll} label="Guión & Prompts" />
                    <NavItem tab="gallery" icon={IconsV2.Photo} label="Galería de Medios" />

                    <div className="pt-6 mt-6 border-t border-slate-200/50">
                        {!sidebarCollapsed && <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4 px-4">Administración</p>}
                        <NavItem tab="settings" icon={IconsV2.Cog} label="Configuración" />
                    </div>
                </div>

                {/* User Profile & Logout (Bottom) */}
                <div className="p-4 border-t border-slate-200/50 bg-white/40">
                    <button
                        onClick={logout}
                        className={`w-full flex items-center ${sidebarCollapsed ? 'justify-center p-2' : 'px-4 py-3'} rounded-xl bg-gradient-to-r hover:from-rose-50 hover:to-orange-50 text-rose-600 transition-all duration-300 border border-transparent hover:border-rose-200 group`}
                        title={sidebarCollapsed ? "Cerrar Sesión" : ""}
                    >
                        <div className={`${sidebarCollapsed ? '' : 'mr-3'} group-hover:scale-110 transition-transform`}>
                            <IconsV2.Logout />
                        </div>
                        {!sidebarCollapsed && <span className="font-medium text-sm">Cerrar Sesión</span>}
                    </button>
                </div>
            </aside>

            {/* 2. MAIN CONTENT AREA V2 */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-gradient-to-br from-slate-50 to-blue-50/30">
                {/* Header Superior V2 */}
                <header className="flex-shrink-0 h-20 bg-white/60 backdrop-blur-md border-b border-white flex justify-between items-center px-8 z-20 shadow-sm shadow-slate-200/20">
                    <div className="flex items-center gap-4">
                        {sidebarCollapsed && (
                            <button
                                onClick={() => setSidebarCollapsed(false)}
                                className="p-2 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-white shadow-sm transition-colors border border-slate-200/50 mr-2"
                            >
                                <IconsV2.Menu />
                            </button>
                        )}
                        <div className="flex items-center gap-2">
                            <div className={`w-2.5 h-2.5 rounded-full ${status === 'ready' ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-rose-500 animate-pulse'}`}></div>
                            <span className={`text-sm font-semibold tracking-wide ${status === 'ready' ? 'text-emerald-700' : 'text-rose-600'}`}>
                                {status === 'ready' ? 'SISTEMA ONLINE' : 'SISTEMA OFFLINE'}
                            </span>
                        </div>
                    </div>

                    <div className="flex items-center gap-6">
                        <Link to="/" className="text-xs font-semibold text-slate-500 hover:text-indigo-600 px-3 py-1.5 rounded-full hover:bg-indigo-50 transition-colors">
                            Volver a V1
                        </Link>

                        <div className="flex items-center gap-3 pl-6 border-l border-slate-200">
                            <div className="text-right hidden md:block">
                                <p className="text-sm font-bold text-slate-800">Administrador</p>
                                <p className="text-xs text-slate-500 font-medium">Root Access</p>
                            </div>
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-800 to-slate-700 flex items-center justify-center shadow-md">
                                <span className="text-white font-bold text-sm">AD</span>
                            </div>
                        </div>
                    </div>
                </header>

                {/* Área de Contenido Principal */}
                <main className="flex-1 relative flex flex-col min-h-0 overflow-hidden">
                    {/* Elementos decorativos de fondo (Blur Orbs) */}
                    <div className="absolute top-[-10%] right-[-5%] w-[40%] h-[40%] rounded-full bg-purple-300/20 blur-[100px] pointer-events-none"></div>
                    <div className="absolute bottom-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-blue-300/20 blur-[120px] pointer-events-none"></div>

                    <div className="flex-1 p-6 xl:p-8 relative z-10 w-full flex flex-col min-h-0 overflow-hidden">
                        {renderContent()}
                    </div>
                </main>
            </div>
        </div>
    );
};

export default CorporateDashboardV2;
