import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { API_URL } from '../../../config/api';
import { useSocket } from '../../../context/SocketContext';

// Icons
const Icons = {
    Wifi: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" /></svg>,
    Alert: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>,
    TrendUp: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>,
    Users: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
    Dollar: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    Activity: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>,
};

const CorporateDashboardView = ({ alerts, config, handleQuickAction, status, qrData }) => {
    const { socket } = useSocket();
    const [stats, setStats] = useState(null);
    const [liveFeed, setLiveFeed] = useState([]);
    const [loadingStats, setLoadingStats] = useState(true);

    // Fetch real KPIs
    useEffect(() => {
        const fetchStats = async () => {
            try {
                const res = await axios.get(`${API_URL}/api/stats`);
                setStats(res.data);
            } catch (e) {
                console.error('Failed to load stats:', e);
            } finally {
                setLoadingStats(false);
            }
        };
        fetchStats();
        const interval = setInterval(fetchStats, 30000); // Refresh every 30s
        return () => clearInterval(interval);
    }, []);

    // Live Feed from Socket.IO
    useEffect(() => {
        if (!socket) return;

        const addFeedItem = (type, text, detail) => {
            const item = {
                id: Date.now() + Math.random(),
                type,
                text,
                detail,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            };
            setLiveFeed(prev => [item, ...prev].slice(0, 50)); // Keep last 50
        };

        socket.on('new_message', (data) => {
            addFeedItem('message', `Nuevo mensaje de ${data.chatId?.slice(-4) || '????'}`, data.preview || '');
        });
        socket.on('new_order', (data) => {
            addFeedItem('order', `Nuevo pedido: ${data.nombre || 'Sin nombre'}`, `${data.producto} — $${data.precio}`);
        });
        socket.on('new_alert', (data) => {
            addFeedItem('alert', `Alerta: ${data.reason}`, data.userPhone);
        });
        socket.on('bot_status_change', (data) => {
            addFeedItem('status', `Bot ${data.paused ? 'pausado' : 'reactivado'}`, data.chatId?.slice(-4));
        });

        return () => {
            socket.off('new_message');
            socket.off('new_order');
            socket.off('new_alert');
            socket.off('bot_status_change');
        };
    }, [socket]);

    const feedTypeConfig = {
        message: { color: 'text-blue-600', bg: 'bg-blue-50', icon: '💬' },
        order: { color: 'text-emerald-600', bg: 'bg-emerald-50', icon: '🛒' },
        alert: { color: 'text-rose-600', bg: 'bg-rose-50', icon: '⚠️' },
        status: { color: 'text-amber-600', bg: 'bg-amber-50', icon: '🤖' },
    };

    // Skeleton for loading state
    const KpiSkeleton = () => (
        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm animate-pulse">
            <div className="h-3 bg-slate-200 rounded w-24 mb-3"></div>
            <div className="h-7 bg-slate-200 rounded w-20 mb-2"></div>
            <div className="h-3 bg-slate-200 rounded w-16"></div>
        </div>
    );

    return (
        <div className="space-y-6 animate-fade-in">

            {/* QR CODE OVERLAY */}
            {status === 'scan_qr' && qrData && (
                <div className="bg-white rounded-lg border-2 border-blue-500 shadow-lg p-8 text-center">
                    <h3 className="text-lg font-bold text-slate-800 mb-2">📱 Escanea el código QR</h3>
                    <p className="text-sm text-slate-500 mb-4">Abrí WhatsApp → Configuración → Dispositivos vinculados → Vincular un dispositivo</p>
                    <div className="inline-block p-4 bg-white rounded-lg border border-slate-200 shadow-sm">
                        <img src={qrData} alt="QR Code" className="w-64 h-64" />
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
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                {loadingStats ? (
                    <>
                        <KpiSkeleton /><KpiSkeleton /><KpiSkeleton /><KpiSkeleton />
                    </>
                ) : (
                    <>
                        {/* KPI 1: Revenue */}
                        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden group hover:shadow-md transition-shadow">
                            <div className="absolute top-0 right-0 w-1 h-full bg-emerald-600"></div>
                            <div className="flex items-center justify-between mb-2">
                                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Ventas Hoy</p>
                                <span className="p-1.5 bg-emerald-50 rounded text-emerald-600"><Icons.Dollar /></span>
                            </div>
                            <h3 className="text-2xl font-bold text-slate-800">
                                ${stats?.todayRevenue?.toLocaleString('es-AR') || '0'}
                            </h3>
                            <p className="text-xs text-slate-500 mt-2">
                                {stats?.todayOrders || 0} pedidos hoy · {stats?.totalOrders || 0} totales
                            </p>
                        </div>

                        {/* KPI 2: Active Sessions */}
                        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
                            <div className="absolute top-0 right-0 w-1 h-full bg-blue-600"></div>
                            <div className="flex items-center justify-between mb-2">
                                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Sesiones Activas</p>
                                <span className="p-1.5 bg-blue-50 rounded text-blue-600"><Icons.Users /></span>
                            </div>
                            <h3 className="text-2xl font-bold text-slate-800">
                                {stats?.activeSessions || 0}
                            </h3>
                            <p className="text-xs text-slate-500 mt-2">
                                {stats?.activeConversations || 0} en flujo activo · {stats?.pausedUsers || 0} pausados
                            </p>
                        </div>

                        {/* KPI 3: Alerts */}
                        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
                            <div className="absolute top-0 right-0 w-1 h-full bg-rose-600"></div>
                            <div className="flex items-center justify-between mb-2">
                                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Alertas Pendientes</p>
                                <span className="p-1.5 bg-rose-50 rounded text-rose-600"><Icons.Alert /></span>
                            </div>
                            <h3 className="text-2xl font-bold text-slate-800">{alerts.length}</h3>
                            <p className="text-xs text-rose-600 mt-2 font-medium">
                                {alerts.length > 0 ? 'Requiere atención' : 'Sin alertas activas'}
                            </p>
                        </div>

                        {/* KPI 4: Admin Sync */}
                        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
                            <div className="absolute top-0 right-0 w-1 h-full bg-slate-600"></div>
                            <div className="flex items-center justify-between mb-2">
                                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Sinc. Admin</p>
                                <span className="p-1.5 bg-slate-100 rounded text-slate-600"><Icons.Activity /></span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className={`w-2 h-2 rounded-full ${config.alertNumber ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`}></div>
                                <span className="font-mono text-sm font-medium">{config.alertNumber ? `+${config.alertNumber}` : 'No Configurado'}</span>
                            </div>
                            <p className="text-xs text-slate-400 mt-2">Dispositivo destino</p>
                        </div>
                    </>
                )}
            </div>

            {/* B. MAIN GRID SPLIT */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[600px]">

                {/* B1. ALERTS TABLE (Takes 2 cols) */}
                <div className="lg:col-span-2 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col">
                    <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                        <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wide flex items-center gap-2">
                            <Icons.Alert /> Logs de Seguridad e Intervención
                        </h3>
                        <span className="text-xs text-slate-400 font-mono">{alerts.length} registros</span>
                    </div>

                    <div className="flex-1 overflow-auto custom-scrollbar">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 text-slate-500 font-medium text-xs uppercase sticky top-0 shadow-sm z-10">
                                <tr>
                                    <th className="px-6 py-3 border-b border-slate-200">Severidad</th>
                                    <th className="px-6 py-3 border-b border-slate-200">Hora</th>
                                    <th className="px-6 py-3 border-b border-slate-200">Usuario / Fuente</th>
                                    <th className="px-6 py-3 border-b border-slate-200">Mensaje / Detonante</th>
                                    <th className="px-6 py-3 border-b border-slate-200 text-right">Acciones</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {alerts.length === 0 ? (
                                    <tr>
                                        <td colSpan="5" className="px-6 py-12 text-center text-slate-400 italic">
                                            No hay alertas de seguridad activas. El sistema opera normalmente.
                                        </td>
                                    </tr>
                                ) : (
                                    alerts.map(alert => (
                                        <tr key={alert.id} className="hover:bg-slate-50 transition-colors group">
                                            <td className="px-6 py-4 border-b border-slate-50">
                                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800 border border-rose-200">
                                                    CRITICO
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-slate-500 font-mono text-xs border-b border-slate-50">
                                                {new Date(alert.timestamp).toLocaleTimeString()}
                                            </td>
                                            <td className="px-6 py-4 font-medium text-slate-700 border-b border-slate-50">
                                                {alert.userPhone}
                                            </td>
                                            <td className="px-6 py-4 text-slate-600 max-w-xs truncate border-b border-slate-50" title={alert.details}>
                                                {alert.reason}
                                            </td>
                                            <td className="px-6 py-4 text-right border-b border-slate-50 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    onClick={() => handleQuickAction(alert.userPhone, 'confirmar')}
                                                    className="text-emerald-700 hover:text-emerald-900 text-xs font-bold mr-3 uppercase tracking-wide"
                                                >
                                                    Aprobar
                                                </button>
                                                <button
                                                    onClick={() => handleQuickAction(alert.userPhone, 'yo me encargo')}
                                                    className="text-slate-500 hover:text-slate-800 text-xs font-bold uppercase tracking-wide"
                                                >
                                                    Intervenir
                                                </button>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* B2. SYSTEM HEALTH & LIVE FEED */}
                <div className="flex flex-col gap-6">
                    {/* System Status Panel */}
                    <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-6">
                        <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wide mb-4">Estado del Sistema</h3>

                        <div className="space-y-4">
                            <div className="flex justify-between items-center pb-3 border-b border-slate-100">
                                <div className="flex items-center gap-3">
                                    <div className={`w-2 h-2 rounded-full ${status === 'ready' ? 'bg-emerald-500 shadow-lg shadow-emerald-200' : 'bg-rose-500 animate-pulse'}`}></div>
                                    <span className="text-sm font-medium text-slate-700">API WhatsApp</span>
                                </div>
                                <span className={`text-xs font-mono px-2 py-0.5 rounded border ${status === 'ready' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                                    {status === 'ready' ? 'CONECTADO' : status === 'scan_qr' ? 'ESPERANDO QR' : 'ERR_CONEX'}
                                </span>
                            </div>

                            <div className="flex justify-between items-center pb-3 border-b border-slate-100">
                                <div className="flex items-center gap-3">
                                    <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                                    <span className="text-sm font-medium text-slate-700">Sinc. Google Sheets</span>
                                </div>
                                <span className="text-xs font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">SINCRONIZADO</span>
                            </div>

                            <div className="flex justify-between items-center">
                                <div className="flex items-center gap-3">
                                    <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                                    <span className="text-sm font-medium text-slate-700">Conversaciones Activas</span>
                                </div>
                                <span className="text-xs font-mono text-slate-500">{stats?.activeConversations || 0}</span>
                            </div>
                        </div>
                    </div>

                    {/* Live Activity Feed (REAL) */}
                    <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex-1 flex flex-col">
                        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                            <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wide">Feed en Vivo</h3>
                            <div className="flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                                <span className="text-[10px] text-slate-400 font-mono">LIVE</span>
                            </div>
                        </div>
                        <div className="p-4 space-y-3 overflow-auto flex-1 h-0 custom-scrollbar">
                            {liveFeed.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-full text-slate-400 text-sm">
                                    <div className="text-3xl mb-2">📡</div>
                                    <p className="text-xs">Esperando actividad...</p>
                                    <p className="text-[10px] mt-1 opacity-50">Los eventos aparecerán aquí en tiempo real</p>
                                </div>
                            ) : (
                                liveFeed.map(item => {
                                    const cfg = feedTypeConfig[item.type] || feedTypeConfig.message;
                                    return (
                                        <div key={item.id} className={`flex gap-3 text-xs border-b border-slate-50 last:border-0 pb-2 last:pb-0 animate-fade-in`}>
                                            <span className="text-slate-400 font-mono whitespace-nowrap">{item.time}</span>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-1.5">
                                                    <span className={`${cfg.bg} ${cfg.color} px-1.5 py-0.5 rounded text-[10px] font-bold`}>{cfg.icon}</span>
                                                    <span className="font-bold text-slate-700 truncate">{item.text}</span>
                                                </div>
                                                {item.detail && (
                                                    <p className="text-slate-400 truncate mt-0.5 ml-6">{item.detail}</p>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CorporateDashboardView;
