import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import { jsPDF } from "jspdf";
import { useToast } from '../../ui/Toast';

const IconsV3 = {
    Settings: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
    Download: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>,
    Sheets: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
    Power: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>,
    AI: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
};

const SettingsViewV3 = ({ status }) => {
    const { toast, confirm } = useToast();

    const handleLogout = async () => {
        const ok = await confirm("ATENCIÓN: Esto apagará el bot, cerrarás la sesión de WhatsApp alojada de este entorno. ¿Continuar?");
        if (!ok) return;
        try {
            await api.post('/api/logout');
            toast.success('Sesión finalizada. Escanea el QR para volver a entrar.');
        } catch (e) { toast.error('Error al intentar cerrar sesión'); }
    };

    const handleTestReport = async () => {
        try {
            toast.info('Construyendo informe global con OpenAI...');
            const response = await api.post('/api/admin-command', { chatId: "API_TEST", command: '!resumen' });
            const reportText = response.data.message;

            if (!reportText || reportText.includes("No hay logs")) {
                toast.warning('Imposible generar reporte: actividad insuficiente hoy.');
                return;
            }

            const doc = new jsPDF();
            doc.setFontSize(24);
            doc.text("Reporte Diario Operativo", 20, 20);
            doc.setFontSize(10);
            doc.text(`Generado Automáticamente: ${new Date().toLocaleString()}`, 20, 28);
            doc.line(20, 32, 190, 32);

            doc.setFontSize(11);
            const splitText = doc.splitTextToSize(reportText, 170);
            doc.text(splitText, 20, 45);
            doc.save(`herbalis_reporte_${new Date().toISOString().split('T')[0]}.pdf`);

            toast.success('Insights descargados en PDF');
        } catch (e) { toast.error('Error procesando el compilado IA'); }
    };

    const handleTestSheets = async () => {
        try {
            const res = await api.post('/api/sheets/test');
            if (res.data.success) toast.success('Conexión bidireccional Spreadsheets estable.');
        } catch (e) { toast.error('Pérdida de paquetes PING con Google Cloud.'); }
    };

    return (
        <div className="w-full max-w-5xl mx-auto flex flex-col relative z-10 animate-fade-in space-y-8">

            <div className="flex flex-col gap-1 items-start justify-center pt-2">
                <h1 className="text-3xl lg:text-4xl font-black text-slate-800 tracking-tight">
                    Configuración de <span className="text-blue-600">Sistema</span>
                </h1>
                <p className="text-slate-500 font-medium text-sm lg:text-base">Ajustes avanzados, auditorías e integraciones.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                {/* Integration Sheets */}
                <div className="bg-white/70 backdrop-blur-xl p-8 rounded-[2rem] border border-slate-200/60 shadow-sm relative overflow-hidden group">
                    <div className="absolute top-0 left-0 w-32 h-32 bg-emerald-500/10 blur-[50px] rounded-full pointer-events-none group-hover:bg-emerald-500/20 transition-colors"></div>
                    <div className="flex items-center gap-4 mb-6 relative z-10">
                        <div className="w-14 h-14 rounded-2xl bg-emerald-50 border border-emerald-100 text-emerald-600 flex items-center justify-center">
                            <IconsV3.Sheets />
                        </div>
                        <div>
                            <h3 className="font-extrabold text-slate-800 text-lg">Google Sheets</h3>
                            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-0.5">Integración Activa</p>
                        </div>
                    </div>
                    <p className="text-sm text-slate-600 mb-6 font-medium relative z-10">
                        Las ventas confirmadas se envían automáticamente al libro maestro para control logístico descentralizado.
                    </p>
                    <button onClick={handleTestSheets} className="w-full bg-white border border-slate-200 text-slate-700 px-6 py-4 rounded-xl text-sm font-bold hover:border-emerald-300 hover:text-emerald-700 transition-all shadow-sm">
                        Probar Sincronización
                    </button>
                </div>

                {/* AI Auditing */}
                <div className="bg-white/70 backdrop-blur-xl p-8 rounded-[2rem] border border-slate-200/60 shadow-sm relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 blur-[50px] rounded-full pointer-events-none group-hover:bg-blue-500/20 transition-colors"></div>
                    <div className="flex items-center gap-4 mb-6 relative z-10">
                        <div className="w-14 h-14 rounded-2xl bg-blue-50 border border-blue-100 text-blue-600 flex items-center justify-center">
                            <IconsV3.AI />
                        </div>
                        <div>
                            <h3 className="font-extrabold text-slate-800 text-lg">Reportes de IA</h3>
                            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-0.5">Diagnóstico y Auditoría</p>
                        </div>
                    </div>
                    <p className="text-sm text-slate-600 mb-6 font-medium relative z-10">
                        Compila las conversaciones diarias y solicita a OpenAI que genere conclusiones sobre desempeño y quejas.
                    </p>
                    <button onClick={handleTestReport} className="w-full bg-white border border-slate-200 text-slate-700 px-6 py-4 rounded-xl text-sm font-bold hover:border-blue-300 hover:text-blue-700 transition-all shadow-sm flex items-center justify-center gap-3">
                        <span className="text-blue-500"><IconsV3.Download /></span> Generar PDF
                    </button>
                </div>

                {/* Danger Zone */}
                <div className="md:col-span-2 bg-rose-50/50 backdrop-blur-xl p-8 rounded-[2rem] border border-rose-200 shadow-sm relative overflow-hidden group flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div className="relative z-10 max-w-lg">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="p-2 bg-rose-100 text-rose-600 rounded-lg">
                                <IconsV3.Power />
                            </div>
                            <h3 className="font-extrabold text-rose-800 text-xl">
                                Interrupción Fuerte (Logout WA)
                            </h3>
                        </div>
                        <p className="text-sm font-medium text-rose-700/80 leading-relaxed">
                            Mata la sesión en Puppeteer, revoca el login de WhatsApp y suspende todos los hilos del bot. Requerirá re-vincular manualmente en Inicio.
                        </p>
                    </div>

                    <button onClick={handleLogout} className="bg-rose-600 text-white px-8 py-4 rounded-2xl text-sm font-extrabold uppercase tracking-widest shadow-lg shadow-rose-500/25 hover:shadow-rose-500/40 hover:-translate-y-0.5 active:scale-95 transition-all shrink-0">
                        Forzar Desconexión
                    </button>
                </div>

            </div>
        </div>
    );
};

export default SettingsViewV3;
