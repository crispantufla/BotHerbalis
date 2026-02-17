import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import { jsPDF } from "jspdf";
import { useSocket } from '../../../context/SocketContext';
import PriceEditor from '../../PriceEditor';

import { useToast } from '../../ui/Toast';

const SettingsView = ({ status }) => {
    const { socket } = useSocket();
    const { toast, confirm } = useToast();
    const [config, setConfig] = useState({ alertNumber: '' });
    const [saving, setSaving] = useState(false);
    const [activeScript, setActiveScript] = useState('v1');
    const [switchingScript, setSwitchingScript] = useState(false);

    // Initial Load
    useEffect(() => {
        const fetchData = async () => {
            try {
                const confRes = await api.get('/api/status');
                if (confRes.data.config) setConfig(confRes.data.config);
            } catch (e) { console.error("Error loading settings:", e); }
            try {
                const scriptRes = await api.get('/api/script/active');
                if (scriptRes.data.active) setActiveScript(scriptRes.data.active);
            } catch (e) { console.error("Error loading script info:", e); }
        };
        fetchData();
    }, []);

    // Listen for script changes from other sessions
    useEffect(() => {
        if (!socket) return;
        const handler = (data) => { if (data.active) setActiveScript(data.active); };
        socket.on('script_changed', handler);
        return () => socket.off('script_changed', handler);
    }, [socket]);

    // Handlers
    const handleConfigSave = async () => {
        setSaving(true);
        try {
            await api.post('/api/config', { alertNumber: config.alertNumber });
            toast.success('Configuración guardada');
        } catch (e) { toast.error('Error guardando configuración'); }
        setSaving(false);
    };

    const handleLogout = async () => {
        const ok = await confirm("¿Seguro que querés desconectar el bot? Dejará de responder.");
        if (!ok) return;
        try {
            await api.post('/api/logout');
            toast.success('Bot desconectado. Escaneá el QR nuevamente si querés reconectar.');
        } catch (e) { toast.error('Error al desconectar'); }
    };

    const handleTestReport = async () => {
        try {
            toast.info('Generando informe PDF...');

            // 1. Request the report text from the API
            const response = await api.post('/api/admin-command', {
                chatId: "API_TEST",
                command: '!resumen'
            });

            const reportText = response.data.message;

            if (!reportText || reportText.includes("No hay logs")) {
                toast.warning('No hay información suficiente para el reporte de hoy.');
                return;
            }

            // 2. Generate PDF
            const doc = new jsPDF();
            doc.setFontSize(18);
            doc.text("Informe Diario - Herbalis Bot", 10, 10);
            doc.setFontSize(10);
            const splitText = doc.splitTextToSize(reportText, 180);
            doc.text(splitText, 10, 20);
            doc.save(`resumen_${new Date().toISOString().split('T')[0]}.pdf`);

            toast.success('PDF Generado y descargado');
        } catch (e) {
            console.error(e);
            toast.error('Error generando el reporte PDF');
        }
    };

    const handleSwitchScript = async (script) => {
        if (script === activeScript || switchingScript) return;
        setSwitchingScript(true);
        try {
            await api.post('/api/script/switch', { script });
            setActiveScript(script);
            toast.success(`Guión cambiado a ${script === 'v1' ? 'Original' : 'V2 — Empático'}`);
        } catch (e) {
            toast.error('Error al cambiar el guión: ' + (e.response?.data?.error || e.message));
        }
        setSwitchingScript(false);
    };



    const handleDownloadScript = async (version, label) => {
        try {
            toast.info(`Generando PDF para ${label}...`);
            const res = await api.get(`/api/script/${version}`);
            const script = res.data;

            const doc = new jsPDF();
            let y = 20;
            const lineHeight = 7;
            const pageHeight = doc.internal.pageSize.height;

            // Helper to clean text for jsPDF (Standard fonts don't support UTF-8/Emojis)
            const cleanText = (str) => {
                if (!str) return "";
                return str
                    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove accents
                    .replace(/[^\x00-\x7F]/g, ""); // Remove non-ASCII (emojis, etc)
            };

            // Helper to add text with auto-page break
            const addText = (text, size = 10, isBold = false) => {
                const safeText = cleanText(text); // Clean encoding
                doc.setFontSize(size);
                doc.setFont("helvetica", isBold ? "bold" : "normal");
                const splitText = doc.splitTextToSize(safeText, 180);
                if (y + (splitText.length * lineHeight) > pageHeight - 20) {
                    doc.addPage();
                    y = 20;
                }
                doc.text(splitText, 15, y);
                y += (splitText.length * 5) + 5;
            };

            // Title
            addText(`Guion de Ventas - ${label}`, 18, true); // Removed accent manually for title
            y += 5;
            addText(script.meta?.description || "Sin descripcion", 10, false);
            y += 10;
            doc.line(15, y, 195, y);
            y += 10;

            // Define Flow Order
            const flowOrder = [
                { key: 'greeting', title: '1. Saludo Inicial' },
                { key: 'recommendation', title: '2. Pregunta de Peso' },
                { key: 'preference_capsulas', title: '3A. Opcion Capsulas' },
                { key: 'preference_semillas', title: '3B. Opcion Semillas' },
                { key: 'preference_gotas', title: '3C. Opcion Gotas' },
                { key: 'price_capsulas', title: '4A. Precio Capsulas' },
                { key: 'price_semillas', title: '4B. Precio Semillas' },
                { key: 'price_gotas', title: '4C. Precio Gotas' },
                { key: 'closing', title: '5. Cierre / Envio' },
                { key: 'data_request', title: '6. Pedido de Datos' },
                { key: 'confirmation', title: '7. Confirmacion Final' }
            ];

            // Render Flow
            addText("FLUJO DE CONVERSACION", 14, true);
            y += 5;

            flowOrder.forEach(step => {
                const item = script.flow[step.key];
                if (item) {
                    addText(step.title, 11, true);
                    if (item.keywords || item.match) {
                        doc.setFont("courier", "normal");
                        doc.setFontSize(9);
                        doc.setTextColor(100);
                        const kws = (item.keywords || item.match).join(', ');
                        doc.text(`Keywords: ${cleanText(kws)}`, 15, y);
                        doc.setTextColor(0);
                        y += 6;
                    }
                    addText(item.response, 10, false);
                    y += 5;
                }
            });

            // Render FAQ
            doc.addPage();
            y = 20;
            addText("PREGUNTAS FRECUENTES (FAQ)", 14, true);
            y += 5;

            if (script.faq && script.faq.length > 0) {
                script.faq.forEach((item, index) => {
                    addText(`Q${index + 1}: ${(item.keywords || []).join(', ')}`, 11, true);
                    addText(item.response, 10, false);
                    y += 5;
                });
            }

            doc.save(`Guion_${version}_${new Date().toISOString().split('T')[0]}.pdf`);
            toast.success('PDF descargado correctamente');
        } catch (e) {
            console.error(e);
            toast.error('Error generando PDF: ' + (e.response?.data?.error || e.message));
        }
    };

    const handleTestSheets = async () => {
        try {
            const res = await api.post('/api/sheets/test');
            if (res.data.success) {
                toast.success('Conexión con Google Sheets exitosa');
            }
        } catch (e) {
            toast.error('Error conectando con Google Sheets: ' + (e.response?.data?.error || e.message));
        }
    };

    return (
        <div className="p-8 max-w-5xl mx-auto space-y-8 animate-fade-in pb-20">

            {/* 1. Header & Status */}
            <div className="flex justify-between items-end border-b border-slate-200 pb-6">
                <div>
                    <h2 className="text-2xl font-bold text-slate-800">Configuración del Sistema</h2>
                    <p className="text-slate-500 mt-1">Administra el comportamiento del bot y verifica el estado.</p>
                </div>
                <div className={`px-4 py-2 rounded-lg border flex items-center gap-3 ${status === 'ready' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
                    <div className={`w-3 h-3 rounded-full ${status === 'ready' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`}></div>
                    <span className="font-bold text-sm tracking-wide">{status === 'ready' ? 'SISTEMA OPERATIVO' : 'DESCONECTADO / ERROR'}</span>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">

                {/* 0. Price Editor (New) */}
                <PriceEditor />

                {/* 2. Tools & Reports */}
                <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm">
                    <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        Herramientas
                    </h3>
                    <p className="text-sm text-slate-500 mb-4">Reportes y acciones del sistema. Los números admin se configuran desde el Dashboard.</p>

                    <div className="space-y-3">
                        <button
                            onClick={handleTestReport}
                            className="w-full bg-white border border-slate-300 text-slate-700 px-4 py-2.5 rounded text-sm font-medium hover:bg-slate-50 transition flex items-center gap-2"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>
                            Descargar Reporte PDF
                        </button>
                    </div>
                </div>

                {/* 3. Google Sheets Test */}
                <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm">
                    <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        Google Sheets
                    </h3>
                    <p className="text-sm text-slate-500 mb-4">Verificá que la sincronización con Google Sheets esté funcionando correctamente.</p>

                    <button
                        onClick={handleTestSheets}
                        className="w-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-4 py-3 rounded text-sm font-bold hover:bg-emerald-100 transition flex justify-center items-center gap-2"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        Probar Conexión Sheets
                    </button>
                </div>

                {/* 4. Script Switcher */}
                <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm">
                    <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        Guión de Ventas
                    </h3>
                    <p className="text-sm text-slate-500 mb-4">Elegí qué guión usa el bot para las conversaciones nuevas. Podés alternar para hacer pruebas A/B.</p>

                    <div className="flex gap-2">
                        <button
                            onClick={() => handleSwitchScript('v1')}
                            disabled={switchingScript}
                            className={`flex-1 px-4 py-3 rounded-lg text-sm font-bold transition-all border-2 ${activeScript === 'v1'
                                ? 'bg-indigo-50 border-indigo-500 text-indigo-700 shadow-sm'
                                : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50'
                                }`}
                        >
                            <div className="flex items-center justify-center gap-2">
                                {activeScript === 'v1' && <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></span>}
                                📋 Original (V1)
                            </div>
                            <div className="text-xs font-normal mt-1 opacity-70">Guión estándar</div>
                            <div
                                onClick={(e) => { e.stopPropagation(); handleDownloadScript('v1', 'Guión Original'); }}
                                className="mt-2 text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded hover:bg-indigo-200 transition"
                            >
                                ⬇️ Descargar PDF
                            </div>
                        </button>
                        <button
                            onClick={() => handleSwitchScript('v2')}
                            disabled={switchingScript}
                            className={`flex-1 px-4 py-3 rounded-lg text-sm font-bold transition-all border-2 flex flex-col items-center ${activeScript === 'v2'
                                ? 'bg-emerald-50 border-emerald-500 text-emerald-700 shadow-sm'
                                : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50'
                                }`}
                        >
                            <div className="flex items-center justify-center gap-2">
                                {activeScript === 'v2' && <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>}
                                💚 Empático (V2)
                            </div>
                            <div className="text-xs font-normal mt-1 opacity-70">Optimizado para accesibilidad</div>
                            <div
                                onClick={(e) => { e.stopPropagation(); handleDownloadScript('v2', 'Guión Empático (V2)'); }}
                                className="mt-2 text-xs bg-emerald-100 text-emerald-700 px-2 py-1 rounded hover:bg-emerald-200 transition"
                            >
                                ⬇️ Descargar PDF
                            </div>
                        </button>
                    </div>

                    {switchingScript && (
                        <p className="text-xs text-slate-400 mt-2 text-center animate-pulse">Cambiando guión...</p>
                    )}
                </div>

                {/* 5. Dangerous Zone */}
                <div className="bg-white p-6 rounded-lg border border-red-100 shadow-sm relative overflow-hidden md:col-span-2">
                    <div className="absolute top-0 left-0 w-1 h-full bg-red-500"></div>
                    <h3 className="font-bold text-red-700 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                        Control de Sesión
                    </h3>
                    <p className="text-sm text-slate-600 mb-6">Si el bot se traba o necesitas cambiar de número, podés cerrar la sesión aquí. Esto requerirá escanear el QR de nuevo.</p>

                    <button
                        onClick={handleLogout}
                        className="bg-red-50 text-red-700 border border-red-200 px-6 py-3 rounded text-sm font-bold hover:bg-red-100 transition flex items-center gap-2"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                        DESCONECTAR SESIÓN
                    </button>
                </div>
            </div>
        </div >
    );
};

export default SettingsView;
