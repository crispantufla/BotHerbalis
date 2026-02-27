import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import { jsPDF } from "jspdf";
import { useSocket } from '../../../context/SocketContext';
import PriceEditor from '../../PriceEditor';
import { useToast } from '../../ui/Toast';

import { Settings, Download, FileText, Power, Trash2, HardDrive, RefreshCw } from 'lucide-react';

const SettingsViewV2 = ({ status }) => {
    const { socket } = useSocket();
    const { toast, confirm } = useToast();
    const [config, setConfig] = useState({ alertNumber: '' });
    const [activeScript, setActiveScript] = useState('v1');
    const [scriptStats, setScriptStats] = useState({});
    const [switchingScript, setSwitchingScript] = useState(false);

    // Memory stats
    const [memStats, setMemStats] = useState(null);
    const [loadingMem, setLoadingMem] = useState(false);
    const [resetting, setResetting] = useState(false);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const confRes = await api.get('/api/status');
                if (confRes.data.config) setConfig(confRes.data.config);
            } catch (e) { console.error("Error loading settings:", e); }
            try {
                const scriptRes = await api.get('/api/script/active');
                if (scriptRes.data.active) setActiveScript(scriptRes.data.active);
                if (scriptRes.data.stats) setScriptStats(scriptRes.data.stats);
            } catch (e) { console.error("Error loading script info:", e); }
        };
        fetchData();
        fetchMemoryStats();
    }, []);

    const fetchMemoryStats = async () => {
        setLoadingMem(true);
        try {
            const res = await api.get('/api/memory-stats');
            setMemStats(res.data);
        } catch (e) { console.error("Error loading memory stats:", e); }
        setLoadingMem(false);
    };

    useEffect(() => {
        if (!socket) return;
        const handler = (data) => { if (data.active) setActiveScript(data.active); };
        socket.on('script_changed', handler);
        const memHandler = () => fetchMemoryStats();
        socket.on('memory_reset', memHandler);
        return () => { socket.off('script_changed', handler); socket.off('memory_reset', memHandler); };
    }, [socket]);

    const handleLogout = async () => {
        const ok = await confirm("ATENCIÓN: Esto desconectará el bot de WhatsApp.\n\nEl sistema dejará de responder mensajes automáticamente y deberás escanear el QR nuevamente desde la vista de Dashboard para reconectar.\n\n¿Estás seguro?");
        if (!ok) return;
        try {
            await api.post('/api/logout');
            toast.success('Sesión cerrada. Debes escanear el QR para reconectar.');
        } catch (e) { toast.error('Error al intentar cerrar sesión'); }
    };

    const handleResetMemory = async () => {
        const ok = await confirm("⚠️ ¿Estás seguro?\n\nEsto borrará TODOS los estados de conversación de los clientes. El bot olvidará en qué paso estaba cada uno.\n\n✅ Las ventas y pedidos NO se borran nunca.");
        if (!ok) return;
        setResetting(true);
        try {
            const res = await api.post('/api/reset-memory');
            toast.success(`Memoria limpiada. ${res.data.deletedUsers} estados eliminados.`);
            fetchMemoryStats();
        } catch (e) { toast.error('Error al limpiar la memoria'); }
        setResetting(false);
    };

    const handleTestReport = async () => {
        try {
            toast.info('Generando informe con IA...');
            const response = await api.post('/api/admin-command', { chatId: "API_TEST", command: '!resumen' });
            const reportText = response.data.message;

            if (!reportText || reportText.includes("No hay logs")) {
                toast.warning('Datos insuficientes para generar el reporte de hoy.');
                return;
            }

            const doc = new jsPDF();
            doc.setFontSize(22);
            doc.text("Reporte Diario V2", 20, 20);
            doc.setFontSize(10);
            doc.text(`Generado: ${new Date().toLocaleString()}`, 20, 28);
            doc.line(20, 32, 190, 32);

            doc.setFontSize(11);
            const splitText = doc.splitTextToSize(reportText, 170);
            doc.text(splitText, 20, 45);
            doc.save(`reporte_v2_${new Date().toISOString().split('T')[0]}.pdf`);

            toast.success('Reporte PDF descargado');
        } catch (e) { toast.error('Error generando el reporte PDF'); }
    };

    const handleSwitchScript = async (scriptKey) => {
        if (scriptKey === activeScript || switchingScript) return;
        setSwitchingScript(true);
        try {
            await api.post('/api/script/switch', { script: scriptKey });
            setActiveScript(scriptKey);
            toast.success(`Modelo de IA cambiado exitosamente.`);
        } catch (e) { toast.error('Error al cambiar el guión'); }
        setSwitchingScript(false);
    };

    // Memory gauge helpers
    const getMemoryPercent = () => {
        if (!memStats) return 0;
        return Math.min(100, Math.round((memStats.totalUsersDB / memStats.thresholds.danger) * 100));
    };

    const getMemoryGradient = () => {
        if (!memStats) return 'from-slate-300 to-slate-400';
        if (memStats.recommendation === 'critical') return 'from-rose-500 to-red-600';
        if (memStats.recommendation === 'warning') return 'from-amber-400 to-orange-500';
        return 'from-emerald-400 to-teal-500';
    };

    const getMemoryLabel = () => {
        if (!memStats) return { text: 'Cargando...', color: 'text-slate-400', glow: '' };
        if (memStats.recommendation === 'critical') return { text: '🔴 Limpieza Recomendada', color: 'text-rose-600', glow: 'shadow-[0_0_20px_rgba(244,63,94,0.15)]' };
        if (memStats.recommendation === 'warning') return { text: '🟡 Memoria Moderada', color: 'text-amber-600', glow: 'shadow-[0_0_20px_rgba(245,158,11,0.15)]' };
        return { text: '🟢 Memoria Saludable', color: 'text-emerald-600', glow: 'shadow-[0_0_20px_rgba(16,185,129,0.15)]' };
    };

    return (
        <div className="h-full flex flex-col animate-fade-in relative z-10 w-full overflow-hidden">

            {/* Ambient Background */}
            <div className="absolute top-0 right-0 w-full h-full bg-gradient-to-br from-indigo-50/50 via-transparent to-purple-50/50 pointer-events-none z-0"></div>

            {/* Header V2 */}
            <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-200 dark:border-slate-700 shadow-[0_8px_30px_rgb(0,0,0,0.04)] p-8 mb-8 relative z-10">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                    <div>
                        <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-700 to-purple-600 dark:from-indigo-400 dark:to-purple-400 tracking-tight">
                            Configuración Base
                        </h1>
                        <p className="text-slate-500 dark:text-slate-400 mt-2 font-medium">Parámetros del sistema, precios y modelos AI operando.</p>
                    </div>

                    <div className={`px-5 py-2.5 rounded-xl border flex items-center gap-3 backdrop-blur-md shadow-sm ${status === 'ready' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700' : 'bg-rose-500/10 border-rose-500/20 text-rose-700'}`}>
                        <div className={`w-2.5 h-2.5 rounded-full ${status === 'ready' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)] animate-pulse' : 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]'}`}></div>
                        <span className="font-extrabold text-xs tracking-widest uppercase">{status === 'ready' ? 'System Online' : 'System Offline / Error'}</span>
                    </div>
                </div>
            </div>

            {/* Content Display */}
            <div className="flex-1 overflow-y-auto custom-scrollbar pb-20 px-1 relative z-10">
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
                    {/* Left Column: Editor & Tools */}
                    <div className="space-y-8">
                        {/* Wrapper for original PriceEditor to adapt it to Glassmorphism */}
                        <div className="bg-white dark:bg-slate-800 p-8 rounded-[2rem] border border-slate-200 dark:border-slate-700 shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden">
                            <div className="absolute -top-32 -left-32 w-64 h-64 bg-indigo-400/10 blur-[60px] rounded-full pointer-events-none"></div>
                            <div className="relative z-10">
                                <PriceEditor />
                            </div>
                        </div>
                    </div>

                    {/* Right Column: Scripts & Danger */}
                    <div className="space-y-8">
                        {/* Script Switcher V2 */}
                        <div className="bg-white dark:bg-slate-800 p-8 rounded-[2rem] border border-slate-200 dark:border-slate-700 shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden">
                            <div className="absolute -bottom-20 -right-20 w-80 h-80 bg-purple-400/10 blur-[80px] rounded-full pointer-events-none"></div>
                            <div className="flex items-center gap-4 mb-8 relative z-10">
                                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-500 to-fuchsia-600 text-white flex items-center justify-center shadow-lg shadow-purple-500/20">
                                    <FileText className="w-6 h-6" />
                                </div>
                                <div>
                                    <h3 className="font-extrabold text-slate-800 dark:text-slate-100 text-lg">Modelos de Venta (A/B)</h3>
                                    <p className="text-xs font-bold text-slate-500 dark:text-slate-300 uppercase tracking-widest">Rotación & Asignación</p>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 relative z-10">
                                {[
                                    { id: 'v3', name: 'Flujo V3 Estándar', desc: 'Directo y profesional.', color: 'blue', stats: scriptStats.v3 },
                                    { id: 'v4', name: 'Flujo V4 Psicológico', desc: 'Escasez y Urgencia.', color: 'purple', stats: scriptStats.v4 },
                                    { id: 'rotacion', name: 'A/B Testing (50/50)', desc: 'Distribuye equitativamente.', color: 'orange', stats: null }
                                ].map((script) => (
                                    <div
                                        key={script.id}
                                        onClick={() => handleSwitchScript(script.id)}
                                        className={`p-5 rounded-2xl border-2 cursor-pointer transition-all duration-300 flex flex-col items-start relative overflow-hidden ${activeScript === script.id
                                            ? `bg-white dark:bg-slate-800 border-${script.color}-500 shadow-lg shadow-${script.color}-500/20 transform scale-105 z-10`
                                            : `bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 hover:border-${script.color}-300 hover:bg-white dark:hover:bg-slate-800`
                                            } ${script.id === 'rotacion' ? 'sm:col-span-2 sm:flex-row sm:items-center sm:justify-between' : ''}`}
                                    >
                                        <div className="flex items-start gap-4 flex-1">
                                            <div className={`w-3 h-3 rounded-full mt-1.5 flex-shrink-0 ${activeScript === script.id ? `bg-${script.color}-500 shadow-[0_0_8px_currentColor] animate-pulse` : 'bg-slate-300'}`}></div>
                                            <div>
                                                <h4 className={`font-extrabold text-sm ${activeScript === script.id ? `text-${script.color}-700 dark:text-${script.color}-400` : 'text-slate-700 dark:text-slate-200'}`}>{script.name}</h4>
                                                <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mt-1 leading-relaxed pr-2">{script.desc}</p>
                                            </div>
                                        </div>

                                        {/* Status Tag */}
                                        {activeScript === script.id && (
                                            <div className={`absolute top-0 right-0 px-3 py-1 bg-${script.color}-500 text-white text-[9px] font-extrabold uppercase tracking-widest rounded-bl-xl`}>
                                                En Uso
                                            </div>
                                        )}

                                        {/* Stats Display */}
                                        {script.stats && (
                                            <div className="mt-4 w-full bg-slate-50 dark:bg-slate-700/30 border border-slate-100 dark:border-slate-700 p-2.5 rounded-xl flex items-center justify-between">
                                                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Conversión</span>
                                                <span className={`text-xs font-mono font-extrabold ${activeScript === script.id ? `text-${script.color}-600 dark:text-${script.color}-400` : 'text-slate-700 dark:text-slate-300'}`}>
                                                    {script.stats.started > 0 ? Math.round((script.stats.completed / script.stats.started) * 100) : 0}%
                                                    <span className="text-[10px] text-slate-400 font-medium ml-1">({script.stats.completed}/{script.stats.started})</span>
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Danger Zone */}
                        <div className="bg-white dark:bg-slate-800 p-8 rounded-[2rem] border border-rose-100 dark:border-rose-900/50 shadow-[0_8px_30px_rgba(244,63,94,0.04)] relative overflow-hidden group">
                            <div className="absolute -left-20 top-1/2 -translate-y-1/2 w-40 h-40 bg-rose-500/10 blur-[40px] rounded-full group-hover:bg-rose-500/20 transition-colors pointer-events-none"></div>
                            <div className="absolute left-0 top-0 bottom-0 w-2 bg-gradient-to-b from-rose-400 to-rose-600 rounded-l-[2rem]"></div>

                            <div className="pl-6 relative z-10">
                                <h3 className="font-extrabold text-rose-700 dark:text-rose-500 text-lg mb-2 flex items-center gap-2">
                                    <Power className="w-6 h-6" /> Interrupción Fuerte
                                </h3>
                                <p className="text-sm font-medium text-slate-600 dark:text-slate-400 leading-relaxed max-w-sm mb-6">
                                    Cerrar la sesión desconecta inmediatamente el dispositivo vinculado de WhatsApp. Ningún mensaje será respondido luego de esta acción.
                                </p>

                                <button onClick={handleLogout} className="bg-gradient-to-r from-rose-500 to-red-600 text-white px-8 py-4 rounded-xl text-xs font-extrabold uppercase tracking-widest shadow-lg shadow-rose-500/30 hover:shadow-rose-500/50 hover:scale-[1.02] active:scale-95 transition-all flex items-center gap-3">
                                    Forzar Desconexión (Logout)
                                </button>
                            </div>
                        </div>

                        {/* Herramientas */}
                        <div className="bg-white dark:bg-slate-800 p-8 rounded-[2rem] border border-slate-200 dark:border-slate-700 shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden">
                            <div className="absolute top-0 right-0 w-32 h-32 bg-blue-400/10 blur-[50px] rounded-full pointer-events-none"></div>
                            <div className="flex items-center gap-4 mb-6 relative z-10">
                                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center shadow-lg shadow-blue-500/20">
                                    <Settings className="w-6 h-6" />
                                </div>
                                <div>
                                    <h3 className="font-extrabold text-slate-800 dark:text-slate-100 text-lg">Herramientas</h3>
                                    <p className="text-xs font-bold text-slate-500 dark:text-slate-300 uppercase tracking-widest">Reportes IA</p>
                                </div>
                            </div>

                            <button onClick={handleTestReport} className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 px-6 py-4 rounded-xl text-sm font-extrabold hover:border-indigo-300 dark:hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all shadow-sm flex items-center justify-center gap-3 group relative z-10 hover:shadow-md">
                                <span className="text-indigo-400 group-hover:text-indigo-600 transition-colors"><Download className="w-5 h-5" /></span>
                                Generar & Descargar Reporte PDF
                            </button>
                        </div>
                    </div>

                    {/* FULL WIDTH: Memory Management Panel */}
                    <div className="xl:col-span-2">
                        <div className={`bg-white dark:bg-slate-800 p-8 rounded-[2rem] border border-slate-200 dark:border-slate-700 shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden ${memStats ? getMemoryLabel().glow : ''}`}>
                            <div className="absolute -top-20 -right-20 w-80 h-80 bg-indigo-400/10 blur-[80px] rounded-full pointer-events-none"></div>
                            <div className="absolute left-0 top-0 bottom-0 w-2 bg-gradient-to-b from-indigo-400 to-purple-600 rounded-l-[2rem]"></div>

                            <div className="pl-6 relative z-10">
                                {/* Header */}
                                <div className="flex items-center justify-between mb-6">
                                    <div className="flex items-center gap-4">
                                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white flex items-center justify-center shadow-lg shadow-indigo-500/20">
                                            <HardDrive className="w-6 h-6" />
                                        </div>
                                        <div>
                                            <h3 className="font-extrabold text-slate-800 dark:text-slate-100 text-lg">Gestión de Memoria</h3>
                                            <p className="text-xs font-bold text-slate-500 dark:text-slate-300 uppercase tracking-widest">Estados de Conversación</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={fetchMemoryStats}
                                        className="text-indigo-500 hover:text-indigo-700 transition-colors p-2 rounded-xl hover:bg-indigo-50"
                                        title="Actualizar"
                                    >
                                        <RefreshCw className={`w-5 h-5 ${loadingMem ? 'animate-spin' : ''}`} />
                                    </button>
                                </div>

                                {memStats ? (
                                    <div className="space-y-6">
                                        {/* Status Badge */}
                                        {(() => {
                                            const label = getMemoryLabel();
                                            return (
                                                <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl ${label.color} bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-sm`}>
                                                    <span className="font-extrabold text-sm tracking-wide">{label.text}</span>
                                                    <span className="text-xs text-slate-400 font-medium">{memStats.totalUsersDB} / {memStats.thresholds.danger}</span>
                                                </div>
                                            );
                                        })()}

                                        {/* Progress Bar */}
                                        <div>
                                            <div className="flex justify-between text-xs text-slate-500 mb-2 font-bold">
                                                <span>Ocupación</span>
                                                <span className="font-mono">{getMemoryPercent()}%</span>
                                            </div>
                                            <div className="w-full bg-slate-100 dark:bg-slate-700 rounded-full h-4 overflow-hidden backdrop-blur-sm">
                                                <div
                                                    className={`h-full rounded-full transition-all duration-1000 ease-out bg-gradient-to-r ${getMemoryGradient()}`}
                                                    style={{ width: `${Math.max(3, getMemoryPercent())}%` }}
                                                ></div>
                                            </div>
                                            <div className="flex justify-between text-[10px] text-slate-400 mt-1.5 font-bold">
                                                <span>0</span>
                                                <span className="text-amber-500">⚠ {memStats.thresholds.warn}</span>
                                                <span className="text-rose-500">🔴 {memStats.thresholds.danger}</span>
                                            </div>
                                        </div>

                                        {/* Stats Grid */}
                                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                            {[
                                                { value: memStats.totalUsersDB, label: 'Base de Datos', color: 'from-slate-500 to-slate-600' },
                                                { value: memStats.ramUsers, label: 'En RAM', color: 'from-blue-500 to-indigo-600' },
                                                { value: memStats.activeConversations, label: 'Activos Ahora', color: 'from-emerald-500 to-teal-600' },
                                                { value: `${memStats.heapUsedMB} MB`, label: 'Heap Usada', color: 'from-amber-500 to-orange-600' }
                                            ].map((stat, i) => (
                                                <div key={i} className="bg-slate-50 dark:bg-slate-900/50 rounded-2xl p-4 text-center border border-slate-200 dark:border-slate-700 shadow-sm">
                                                    <div className={`text-xl font-black text-transparent bg-clip-text bg-gradient-to-r ${stat.color}`}>{stat.value}</div>
                                                    <div className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest mt-1">{stat.label}</div>
                                                </div>
                                            ))}
                                        </div>

                                        {/* Info */}
                                        <p className="text-xs text-slate-400 leading-relaxed font-medium">
                                            💡 <strong>¿Cuándo limpiar?</strong> Cuando el indicador pase a 🟡 amarillo (+{memStats.thresholds.warn} usuarios).
                                            Esto borra los estados de conversación acumulados.
                                            <strong> Las ventas y pedidos NUNCA se borran.</strong>
                                        </p>

                                        {/* Reset Button */}
                                        <button
                                            onClick={handleResetMemory}
                                            disabled={resetting}
                                            className="w-full bg-gradient-to-r from-indigo-500 to-purple-600 text-white px-8 py-4 rounded-xl text-xs font-extrabold uppercase tracking-widest shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-[1.01] active:scale-95 transition-all flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {resetting ? (
                                                <>
                                                    <RefreshCw className="w-5 h-5 animate-spin" />
                                                    Limpiando Memoria...
                                                </>
                                            ) : (
                                                <>
                                                    <Trash2 className="w-5 h-5" />
                                                    Limpiar Memoria de Usuarios
                                                </>
                                            )}
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-center py-12 text-slate-400">
                                        <RefreshCw className="w-5 h-5 animate-spin mr-3" />
                                        <span className="font-bold text-sm">Cargando estadísticas de memoria...</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SettingsViewV2;
