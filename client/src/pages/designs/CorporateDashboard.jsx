import React, { useState, useEffect, useCallback } from 'react';
import api from '../../config/axios';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';
import { Link } from 'react-router-dom';

import { useToast } from '../../components/ui/Toast';

// View Imports
import DashboardView from '../../components/corporate/views/DashboardView';
import CommsView from '../../components/corporate/views/CommsView';
import SalesView from '../../components/corporate/views/SalesView';
import SettingsView from '../../components/corporate/views/SettingsView';
import ScriptView from '../../components/corporate/views/ScriptView';
import GalleryView from '../../components/corporate/views/GalleryView';

// Icons (Simple SVGs for Corporate Look)
const Icons = {
    Wifi: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" /></svg>,
    Alert: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>,
    Check: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>,
    Message: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>,
    Database: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" /></svg>,
    Cog: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
    Scroll: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
    Photo: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
    Logout: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
};


const CorporateDashboard = () => {
    const { socket } = useSocket();
    const { logout } = useAuth();
    const { toast } = useToast();
    const [status, setStatus] = useState('initializing');
    const [alerts, setAlerts] = useState([]);
    const [activeTab, setActiveTab] = useState('dashboard');
    const [qrData, setQrData] = useState(null);
    const [config, setConfig] = useState({ alertNumbers: [] });

    const fetchConfig = useCallback(async () => {
        try {
            const res = await api.get('/api/status');
            if (res.data.config) setConfig(res.data.config);
        } catch (e) { }
    }, []);

    useEffect(() => {
        if (socket) {
            socket.on('qr', (data) => { setStatus('scan_qr'); setQrData(data); });
            socket.on('ready', () => setStatus('ready'));
            socket.on('status_change', ({ status }) => setStatus(status));
            socket.on('new_alert', (newAlert) => setAlerts(prev => [newAlert, ...prev]));
            socket.on('alerts_updated', (updated) => setAlerts(updated)); // Listen for updates
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

        // Listen for config updates from child components
        const handleConfigUpdate = () => fetchConfig();
        window.addEventListener('config-updated', handleConfigUpdate);
        return () => window.removeEventListener('config-updated', handleConfigUpdate);
    }, [socket, fetchConfig]);

    const handleQuickAction = async (chatId, action) => {
        if (action === 'chat') {
            setActiveTab('comms');
            // setTimeout to allow tab switch, then emit event or use context to select chat
            // For now, just switching tab is the first step. Enhanced implementation requires context.
            return;
        }

        if (action === 'descartar') {
            // Just remove from UI
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
            case 'dashboard':
                return <DashboardView alerts={alerts} config={config} handleQuickAction={handleQuickAction} status={status} qrData={qrData} />;
            case 'comms':
                return <CommsView />;
            case 'logistics':
                return <SalesView />;
            case 'script':
                return <ScriptView />;
            case 'gallery':
                return <GalleryView />;
            case 'settings':
                return <SettingsView status={status} />;
            case 'security':
                return <DashboardView alerts={alerts} config={config} handleQuickAction={handleQuickAction} status={status} qrData={qrData} />; // Re-use for now or specific view
            default:
                return <DashboardView alerts={alerts} config={config} handleQuickAction={handleQuickAction} status={status} qrData={qrData} />;
        }
    };

    return (
        <div className="flex h-screen bg-[#f1f5f9] font-sans text-slate-800">
            {/* 1. SIDEBAR NAVIGATION */}
            <aside className="w-64 bg-[#0f172a] text-slate-300 flex flex-col shadow-xl z-20">
                <div className="h-16 flex items-center px-6 border-b border-slate-700/50">
                    <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold mr-3">H</div>
                    <span className="font-semibold text-white tracking-wide">HERBALIS<span className="text-blue-500">CORP</span></span>
                </div>

                <nav className="flex-1 py-6 px-3 space-y-1">
                    <button onClick={() => setActiveTab('dashboard')} className={`w-full flex items-center px-3 py-2 rounded-md transition-colors ${activeTab === 'dashboard' ? 'bg-blue-600 text-white shadow-sm' : 'hover:bg-slate-800 hover:text-white'}`}>
                        <span className="mr-3"><Icons.Wifi /></span> Inicio
                    </button>
                    <button onClick={() => setActiveTab('comms')} className={`w-full flex items-center px-3 py-2 rounded-md transition-colors ${activeTab === 'comms' ? 'bg-blue-600 text-white shadow-sm' : 'hover:bg-slate-800 hover:text-white'}`}>
                        <span className="mr-3"><Icons.Message /></span> Chat
                    </button>
                    <button onClick={() => setActiveTab('logistics')} className={`w-full flex items-center px-3 py-2 rounded-md transition-colors ${activeTab === 'logistics' ? 'bg-blue-600 text-white shadow-sm' : 'hover:bg-slate-800 hover:text-white'}`}>
                        <span className="mr-3"><Icons.Database /></span> Ventas
                    </button>
                    <button onClick={() => setActiveTab('script')} className={`w-full flex items-center px-3 py-2 rounded-md transition-colors ${activeTab === 'script' ? 'bg-blue-600 text-white shadow-sm' : 'hover:bg-slate-800 hover:text-white'}`}>
                        <span className="mr-3"><Icons.Scroll /></span> Guión
                    </button>
                    <button onClick={() => setActiveTab('gallery')} className={`w-full flex items-center px-3 py-2 rounded-md transition-colors ${activeTab === 'gallery' ? 'bg-blue-600 text-white shadow-sm' : 'hover:bg-slate-800 hover:text-white'}`}>
                        <span className="mr-3"><Icons.Photo /></span> Galería
                    </button>
                    <div className="pt-4 mt-4 border-t border-slate-700/50">
                        <button onClick={() => setActiveTab('security')} className={`w-full flex items-center px-3 py-2 rounded-md transition-colors ${activeTab === 'security' ? 'bg-blue-600 text-white shadow-sm' : 'hover:bg-slate-800 hover:text-white'}`}>
                            <span className="mr-3"><Icons.Alert /></span> Logs / Seguridad
                        </button>
                        <button onClick={() => setActiveTab('settings')} className={`w-full flex items-center px-3 py-2 rounded-md transition-colors ${activeTab === 'settings' ? 'bg-blue-600 text-white shadow-sm' : 'hover:bg-slate-800 hover:text-white'}`}>
                            <span className="mr-3"><Icons.Cog /></span> Configuración
                        </button>
                        <button onClick={logout} className="w-full flex items-center px-3 py-2 rounded-md transition-colors text-rose-400 hover:bg-rose-900/20 hover:text-rose-300 mt-4 border border-rose-900/30">
                            <span className="mr-3"><Icons.Logout /></span> Cerrar Sesión
                        </button>
                    </div>
                </nav>

                <div className="p-4 border-t border-slate-700/50">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold text-white">AD</div>
                        <div>
                            <p className="text-sm font-medium text-white">Administrador</p>
                            <p className="text-xs text-slate-500">Sistema Root</p>
                        </div>
                    </div>
                </div>
            </aside>

            {/* 2. MAIN CONTENT AREA */}
            <main className="flex-1 flex flex-col overflow-hidden">
                {/* Header */}
                <header className="h-16 bg-white border-b border-slate-200 flex justify-between items-center px-8 shadow-sm z-10">
                    <div className="flex items-center text-sm breadcrumbs text-slate-500">
                        <span className="hover:text-slate-800 cursor-pointer">Sistema</span>
                        <span className="mx-2">/</span>
                        <span className="font-semibold text-slate-800 uppercase">
                            {activeTab === 'dashboard' ? 'Inicio' :
                                activeTab === 'comms' ? 'Chat' :
                                    activeTab === 'logistics' ? 'Ventas' :
                                        activeTab === 'script' ? 'Guión' :
                                            activeTab === 'settings' ? 'Configuración' : 'Seguridad'}
                        </span>
                        <span className="mx-2">/</span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-bold border ${status === 'ready' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                            {status === 'ready' ? 'SISTEMA ONLINE' : 'SISTEMA OFFLINE'}
                        </span>
                    </div>

                    <div className="flex items-center gap-4">
                        <button className="bg-slate-100 hover:bg-slate-200 text-slate-600 px-4 py-2 rounded-md text-sm font-medium transition-colors">Documentación</button>
                    </div>
                </header>

                {/* Dashboard Scrollable Area */}
                <div className="flex-1 overflow-y-auto p-8 relative">
                    {renderContent()}
                </div>
            </main>
        </div>
    );
};


export default CorporateDashboard;
