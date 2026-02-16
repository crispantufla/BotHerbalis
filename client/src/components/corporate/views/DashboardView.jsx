import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { API_URL } from '../../../config/api';
import { useSocket } from '../../../context/SocketContext';
import { useToast } from '../../ui/Toast';

// Icons
const Icons = {
    Alert: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>,
    Users: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
    Dollar: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    Activity: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>,
    Plus: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>,
    Trash: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
    Phone: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>,
};

const CorporateDashboardView = ({ alerts, config, handleQuickAction, status, qrData }) => {
    const { socket } = useSocket();
    const { toast, confirm } = useToast();
    const [stats, setStats] = useState(null);
    const [loadingStats, setLoadingStats] = useState(true);
    const [newPhone, setNewPhone] = useState('');
    const [addingPhone, setAddingPhone] = useState(false);

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
        const interval = setInterval(fetchStats, 30000);
        return () => clearInterval(interval);
    }, []);

    // Admin phone management
    const handleAddPhone = async () => {
        const cleaned = newPhone.replace(/\D/g, '');
        if (!cleaned || cleaned.length < 8) {
            toast.warning('Ingresá un número válido con código de país (ej: 5493411234567)');
            return;
        }
        setAddingPhone(true);
        try {
            await axios.post(`${API_URL}/api/config`, { action: 'add', number: cleaned });
            toast.success(`Número ${cleaned} agregado`);
            setNewPhone('');
            // Force config refresh via parent
            window.dispatchEvent(new Event('config-updated'));
        } catch (e) {
            toast.error('Error agregando número');
        }
        setAddingPhone(false);
    };

    const handleRemovePhone = async (num) => {
        const ok = await confirm(`¿Eliminar el número ${num} de las alertas admin?`);
        if (!ok) return;
        try {
            await axios.post(`${API_URL}/api/config`, { action: 'remove', number: num });
            toast.success(`Número ${num} eliminado`);
            window.dispatchEvent(new Event('config-updated'));
        } catch (e) {
            toast.error('Error eliminando número');
        }
    };

    const adminNumbers = config?.alertNumbers || (config?.alertNumber ? [config.alertNumber] : []);

    // Skeleton
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
                    <><KpiSkeleton /><KpiSkeleton /><KpiSkeleton /><KpiSkeleton /></>
                ) : (
                    <>
                        {/* KPI 1: Revenue */}
                        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
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
                            <h3 className="text-2xl font-bold text-slate-800">{stats?.activeSessions || 0}</h3>
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

                        {/* KPI 4: Conversion */}
                        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden hover:shadow-md transition-shadow">
                            <div className="absolute top-0 right-0 w-1 h-full bg-violet-600"></div>
                            <div className="flex items-center justify-between mb-2">
                                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Tasa Conversión</p>
                                <span className="p-1.5 bg-violet-50 rounded text-violet-600"><Icons.Activity /></span>
                            </div>
                            <h3 className="text-2xl font-bold text-slate-800">{stats?.conversionRate || 0}%</h3>
                            <p className="text-xs text-slate-500 mt-2">pedidos / sesiones hoy</p>
                        </div>
                    </>
                )}
            </div>

            {/* B. MAIN GRID: ALERTS + SYSTEM STATUS */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6" style={{ minHeight: '500px' }}>

                {/* B1. ALERTS TABLE (2 cols) */}
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
                                    <th className="px-6 py-3 border-b border-slate-200">Usuario</th>
                                    <th className="px-6 py-3 border-b border-slate-200">Detonante</th>
                                    <th className="px-6 py-3 border-b border-slate-200 text-right">Acciones</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {alerts.length === 0 ? (
                                    <tr>
                                        <td colSpan="5" className="px-6 py-12 text-center text-slate-400 italic">
                                            No hay alertas de seguridad activas.
                                        </td>
                                    </tr>
                                ) : (
                                    alerts.map(alert => (
                                        <tr key={alert.id} className="hover:bg-slate-50 transition-colors group">
                                            <td className="px-6 py-4">
                                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800 border border-rose-200">CRITICO</span>
                                            </td>
                                            <td className="px-6 py-4 text-slate-500 font-mono text-xs">{new Date(alert.timestamp).toLocaleTimeString()}</td>
                                            <td className="px-6 py-4 font-medium text-slate-700">{alert.userPhone}</td>
                                            <td className="px-6 py-4 text-slate-600 max-w-xs truncate" title={alert.details}>{alert.reason}</td>
                                            <td className="px-6 py-4 text-right opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button onClick={() => handleQuickAction(alert.userPhone, 'confirmar')} className="text-emerald-700 hover:text-emerald-900 text-xs font-bold mr-3 uppercase tracking-wide">Aprobar</button>
                                                <button onClick={() => handleQuickAction(alert.userPhone, 'yo me encargo')} className="text-slate-500 hover:text-slate-800 text-xs font-bold uppercase tracking-wide">Intervenir</button>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* B2. SYSTEM STATUS — EXPANDED (1 col, full height) */}
                <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col">
                    <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
                        <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wide">Estado del Sistema</h3>
                    </div>

                    <div className="p-6 flex-1 flex flex-col gap-6">

                        {/* Connection Status */}
                        <div className="space-y-4">
                            <div className="flex justify-between items-center pb-3 border-b border-slate-100">
                                <div className="flex items-center gap-3">
                                    <div className={`w-2.5 h-2.5 rounded-full ${status === 'ready' ? 'bg-emerald-500 shadow-lg shadow-emerald-200' : 'bg-rose-500 animate-pulse'}`}></div>
                                    <span className="text-sm font-medium text-slate-700">API WhatsApp</span>
                                </div>
                                <span className={`text-xs font-mono px-2 py-0.5 rounded border ${status === 'ready' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                                    {status === 'ready' ? 'CONECTADO' : status === 'scan_qr' ? 'ESPERANDO QR' : 'ERROR'}
                                </span>
                            </div>

                            <div className="flex justify-between items-center pb-3 border-b border-slate-100">
                                <div className="flex items-center gap-3">
                                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-500"></div>
                                    <span className="text-sm font-medium text-slate-700">Google Sheets</span>
                                </div>
                                <span className="text-xs font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">SINCRONIZADO</span>
                            </div>

                            <div className="flex justify-between items-center pb-3 border-b border-slate-100">
                                <div className="flex items-center gap-3">
                                    <div className="w-2.5 h-2.5 rounded-full bg-blue-500"></div>
                                    <span className="text-sm font-medium text-slate-700">Conversaciones</span>
                                </div>
                                <span className="text-xs font-mono text-slate-600">{stats?.activeConversations || 0} activas</span>
                            </div>
                        </div>

                        {/* Admin Phone Numbers */}
                        <div className="flex-1 flex flex-col">
                            <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-2">
                                    <Icons.Phone />
                                    <h4 className="text-sm font-bold text-slate-700">Números Admin</h4>
                                </div>
                                <span className="text-[10px] text-slate-400 font-mono">{adminNumbers.length} configurados</span>
                            </div>

                            {/* Phone List */}
                            <div className="space-y-2 mb-4 flex-1 overflow-auto custom-scrollbar">
                                {adminNumbers.length === 0 ? (
                                    <div className="py-6 text-center text-slate-400 text-xs italic border border-dashed border-slate-200 rounded-lg">
                                        No hay números admin configurados.
                                        <br />Las alertas no se enviarán por WhatsApp.
                                    </div>
                                ) : (
                                    adminNumbers.map((num, idx) => (
                                        <div key={idx} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 group hover:border-slate-300 transition">
                                            <div className="flex items-center gap-2">
                                                <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                                                <span className="text-sm font-mono text-slate-700">+{num}</span>
                                            </div>
                                            <button
                                                onClick={() => handleRemovePhone(num)}
                                                className="text-slate-300 hover:text-rose-500 transition opacity-0 group-hover:opacity-100"
                                                title="Eliminar número"
                                            >
                                                <Icons.Trash />
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>

                            {/* Add Phone */}
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={newPhone}
                                    onChange={(e) => setNewPhone(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleAddPhone()}
                                    placeholder="5493411234567"
                                    className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 outline-none transition"
                                />
                                <button
                                    onClick={handleAddPhone}
                                    disabled={addingPhone || !newPhone.trim()}
                                    className="bg-slate-900 text-white px-3 py-2 rounded-lg hover:bg-black transition disabled:opacity-50 flex items-center gap-1"
                                >
                                    <Icons.Plus />
                                </button>
                            </div>
                            <p className="text-[10px] text-slate-400 mt-1.5">Con código de país, sin + ni espacios</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CorporateDashboardView;
