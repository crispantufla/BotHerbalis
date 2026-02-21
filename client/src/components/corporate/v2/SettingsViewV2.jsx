import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import { jsPDF } from "jspdf";
import { useSocket } from '../../../context/SocketContext';
import PriceEditor from '../../PriceEditor'; // Assuming reusing the original PriceEditor, it's ok since it's an internal component, but ideally it should also be V2. Let's wrap it in a glass container.
import { useToast } from '../../ui/Toast';

const IconsV2 = {
    Settings: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
    Download: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>,
    Sheets: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
    Script: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
    Power: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
};

const SettingsViewV2 = ({ status }) => {
    const { socket } = useSocket();
    const { toast, confirm } = useToast();
    const [config, setConfig] = useState({ alertNumber: '' });
    const [activeScript, setActiveScript] = useState('v1');
    const [scriptStats, setScriptStats] = useState({});
    const [switchingScript, setSwitchingScript] = useState(false);

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
    }, []);

    useEffect(() => {
        if (!socket) return;
        const handler = (data) => { if (data.active) setActiveScript(data.active); };
        socket.on('script_changed', handler);
        return () => socket.off('script_changed', handler);
    }, [socket]);

    const handleLogout = async () => {
        const ok = await confirm("ATENCIÓN: Esto desconectará el bot de WhatsApp.\n\nEl sistema dejará de responder mensajes automáticamente y deberás escanear el QR nuevamente desde la vista de Dashboard para reconectar.\n\n¿Estás seguro?");
        if (!ok) return;
        try {
            await api.post('/api/logout');
            toast.success('Sesión cerrada. Debes escanear el QR para reconectar.');
        } catch (e) { toast.error('Error al intentar cerrar sesión'); }
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

    const handleTestSheets = async () => {
        try {
            const res = await api.post('/api/sheets/test');
            if (res.data.success) toast.success('Sincronización con Google Sheets OK');
        } catch (e) { toast.error('Fallo en la conexión PING con Sheets'); }
    };

    return (
        <div className="h-full flex flex-col animate-fade-in relative z-10 w-full overflow-hidden">

            {/* Ambient Background */}
            <div className="absolute top-0 right-0 w-full h-full bg-gradient-to-br from-indigo-50/50 via-transparent to-purple-50/50 pointer-events-none z-0"></div>

            {/* Header V2 */}
            <div className="bg-white/40 backdrop-blur-xl rounded-[2rem] border border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] p-8 mb-8 relative z-10">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                    <div>
                        <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-700 to-purple-600 tracking-tight">
                            Configuración Base
                        </h1>
                        <p className="text-slate-500 mt-2 font-medium">Parámetros del sistema, precios y modelos AI operando.</p>
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
                        <div className="bg-white/60 backdrop-blur-xl p-8 rounded-[2rem] border border-white/80 shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden">
                            <div className="absolute -top-32 -left-32 w-64 h-64 bg-indigo-400/10 blur-[60px] rounded-full pointer-events-none"></div>
                            <div className="relative z-10">
                                <PriceEditor />
                            </div>
                        </div>

                        <div className="bg-white/60 backdrop-blur-xl p-8 rounded-[2rem] border border-white/80 shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden">
                            <div className="absolute top-0 right-0 w-32 h-32 bg-blue-400/10 blur-[50px] rounded-full pointer-events-none"></div>
                            <div className="flex items-center gap-4 mb-6 relative z-10">
                                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center shadow-lg shadow-blue-500/20">
                                    <IconsV2.Settings />
                                </div>
                                <div>
                                    <h3 className="font-extrabold text-slate-800 text-lg">Herramientas</h3>
                                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Reportes IA</p>
                                </div>
                            </div>

                            <button onClick={handleTestReport} className="w-full bg-white border border-slate-200 text-slate-700 px-6 py-4 rounded-xl text-sm font-extrabold hover:border-indigo-300 hover:text-indigo-600 transition-all shadow-sm flex items-center justify-center gap-3 group relative z-10 hover:shadow-md">
                                <span className="text-indigo-400 group-hover:text-indigo-600 transition-colors"><IconsV2.Download /></span>
                                Generar & Descargar Reporte PDF
                            </button>
                        </div>
                    </div>

                    {/* Right Column: Scripts & Danger */}
                    <div className="space-y-8">
                        {/* Script Switcher V2 */}
                        <div className="bg-white/60 backdrop-blur-xl p-8 rounded-[2rem] border border-white/80 shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden">
                            <div className="absolute -bottom-20 -right-20 w-80 h-80 bg-purple-400/10 blur-[80px] rounded-full pointer-events-none"></div>
                            <div className="flex items-center gap-4 mb-8 relative z-10">
                                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-500 to-fuchsia-600 text-white flex items-center justify-center shadow-lg shadow-purple-500/20">
                                    <IconsV2.Script />
                                </div>
                                <div>
                                    <h3 className="font-extrabold text-slate-800 text-lg">Modelos de Venta (A/B)</h3>
                                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Rotación & Asignación</p>
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
                                            ? `bg-white border-${script.color}-500 shadow-lg shadow-${script.color}-500/20 transform scale-105 z-10`
                                            : `bg-white/50 border-white hover:border-${script.color}-200 hover:bg-white`
                                            } ${script.id === 'rotacion' ? 'sm:col-span-2 sm:flex-row sm:items-center sm:justify-between' : ''}`}
                                    >
                                        <div className="flex items-start gap-4 flex-1">
                                            <div className={`w-3 h-3 rounded-full mt-1.5 flex-shrink-0 ${activeScript === script.id ? `bg-${script.color}-500 shadow-[0_0_8px_currentColor] animate-pulse` : 'bg-slate-300'}`}></div>
                                            <div>
                                                <h4 className={`font-extrabold text-sm ${activeScript === script.id ? `text-${script.color}-700` : 'text-slate-700'}`}>{script.name}</h4>
                                                <p className="text-[11px] font-medium text-slate-500 mt-1 leading-relaxed pr-2">{script.desc}</p>
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
                                            <div className="mt-4 w-full bg-slate-50 border border-slate-100 p-2.5 rounded-xl flex items-center justify-between">
                                                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Conversión</span>
                                                <span className={`text-xs font-mono font-extrabold ${activeScript === script.id ? `text-${script.color}-600` : 'text-slate-700'}`}>
                                                    {script.stats.started > 0 ? Math.round((script.stats.completed / script.stats.started) * 100) : 0}%
                                                    <span className="text-[10px] text-slate-400 font-medium ml-1">({script.stats.completed}/{script.stats.started})</span>
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Integrations */}
                        <div className="bg-white/60 backdrop-blur-xl p-8 rounded-[2rem] border border-white/80 shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden flex items-center justify-between group">
                            <div className="absolute top-0 left-0 w-full h-full bg-emerald-400/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>

                            <div className="flex items-center gap-5 relative z-10">
                                <div className="w-12 h-12 rounded-2xl bg-emerald-100 text-emerald-600 flex items-center justify-center shadow-inner">
                                    <IconsV2.Sheets />
                                </div>
                                <div>
                                    <h3 className="font-extrabold text-slate-800 text-sm">Google Sheets Sync</h3>
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Base de Datos Externa</p>
                                </div>
                            </div>

                            <button onClick={handleTestSheets} className="px-5 py-2.5 bg-white border border-emerald-200 text-emerald-600 rounded-xl text-xs font-extrabold uppercase tracking-widest hover:bg-emerald-500 hover:text-white transition-all shadow-sm relative z-10">
                                Test Ping
                            </button>
                        </div>

                        {/* Danger Zone */}
                        <div className="bg-white/60 backdrop-blur-xl p-8 rounded-[2rem] border border-rose-100 shadow-[0_8px_30px_rgba(244,63,94,0.04)] relative overflow-hidden group">
                            <div className="absolute -left-20 top-1/2 -translate-y-1/2 w-40 h-40 bg-rose-500/10 blur-[40px] rounded-full group-hover:bg-rose-500/20 transition-colors pointer-events-none"></div>
                            <div className="absolute left-0 top-0 bottom-0 w-2 bg-gradient-to-b from-rose-400 to-rose-600 rounded-l-[2rem]"></div>

                            <div className="pl-6 relative z-10">
                                <h3 className="font-extrabold text-rose-700 text-lg mb-2 flex items-center gap-2">
                                    <IconsV2.Power /> Interrupción Fuerte
                                </h3>
                                <p className="text-sm font-medium text-slate-600 leading-relaxed max-w-sm mb-6">
                                    Cerrar la sesión desconecta inmediatamente el dispositivo vinculado de WhatsApp. Ningún mensaje será respondido luego de esta acción.
                                </p>

                                <button onClick={handleLogout} className="bg-gradient-to-r from-rose-500 to-red-600 text-white px-8 py-4 rounded-xl text-xs font-extrabold uppercase tracking-widest shadow-lg shadow-rose-500/30 hover:shadow-rose-500/50 hover:scale-[1.02] active:scale-95 transition-all flex items-center gap-3">
                                    Forzar Desconexión (Logout)
                                </button>
                            </div>
                        </div>

                    </div>
                </div>
            </div>
        </div>
    );
};

export default SettingsViewV2;
