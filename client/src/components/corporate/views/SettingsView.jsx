import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { jsPDF } from "jspdf";
import { useSocket } from '../../../context/SocketContext';

const API_URL = 'http://localhost:3000';

const SettingsView = ({ status }) => {
    const { socket } = useSocket();
    const [config, setConfig] = useState({ alertNumber: '' });
    const [script, setScript] = useState(null);
    const [scriptLoading, setScriptLoading] = useState(false);
    const [scriptJson, setScriptJson] = useState(''); // For editing
    const [saving, setSaving] = useState(false);

    // Initial Load
    useEffect(() => {
        const fetchData = async () => {
            try {
                const [confRes, scriptRes] = await Promise.all([
                    axios.get(`${API_URL}/api/status`),
                    axios.get(`${API_URL}/api/script`)
                ]);
                if (confRes.data.config) setConfig(confRes.data.config);
                setScript(scriptRes.data);
                setScriptJson(JSON.stringify(scriptRes.data, null, 4));
            } catch (e) { console.error("Error loading settings:", e); }
        };
        fetchData();
    }, []);

    // Handlers
    const handleConfigSave = async () => {
        setSaving(true);
        try {
            await axios.post(`${API_URL}/api/config`, { alertNumber: config.alertNumber });
            alert('Configuración guardada ✅');
        } catch (e) { alert('Error guardando configuración ❌'); }
        setSaving(false);
    };

    const handleScriptSave = async () => {
        setScriptLoading(true);
        try {
            const parsed = JSON.parse(scriptJson);
            await axios.post(`${API_URL}/api/script`, parsed);
            alert('Script de ventas actualizado ✅');
        } catch (e) {
            alert('Error: JSON inválido ❌. Revisá la sintaxis.');
        }
        setScriptLoading(false);
    };

    const handleLogout = async () => {
        if (!window.confirm("¿Seguro que querés desconectar el bot? Dejará de responder.")) return;
        try {
            await axios.post(`${API_URL}/api/logout`);
            alert('Bot desconectado 👋. Escaneá el QR nuevamente si querés reconectar.');
        } catch (e) { alert('Error al desconectar'); }
    };

    const handleTestReport = async () => {
        try {
            alert('Generando informe PDF... aguarde unos segundos.');

            // 1. Request the report text from the API
            const response = await axios.post(`${API_URL}/api/admin-command`, {
                chatId: "API_TEST", // Dummy ID since we want the return value
                command: '!resumen'
            });

            const reportText = response.data.message;

            if (!reportText || reportText.includes("No hay logs")) {
                alert("No hay información suficiente para generar el reporte hoy.");
                return;
            }

            // 2. Generate PDF
            const doc = new jsPDF();

            // Title
            doc.setFontSize(18);
            doc.text("Informe Diario - Herbalis Bot", 10, 10);

            // Content (Simple text wrapping)
            doc.setFontSize(10);
            const splitText = doc.splitTextToSize(reportText, 180);
            doc.text(splitText, 10, 20);

            // 3. Download
            doc.save(`resumen_${new Date().toISOString().split('T')[0]}.pdf`);

            alert('PDF Generado y descargado ✅');

        } catch (e) {
            console.error(e);
            alert('Error generando el reporte PDF');
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

                {/* 2. System Alerts Config */}
                <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm">
                    <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
                        Alertas Admin
                    </h3>
                    <p className="text-sm text-slate-500 mb-4">Número maestro que recibirá notificaciones de pedidos, pausas y errores.</p>

                    <div className="space-y-4">
                        <div>
                            <label className="block text-xs font-bold text-slate-700 uppercase mb-1">Número de WhatsApp (con código país)</label>
                            <input
                                type="text"
                                value={config.alertNumber || ''}
                                onChange={e => setConfig({ ...config, alertNumber: e.target.value })}
                                placeholder="Ej: 5493411234567"
                                className="w-full bg-slate-50 border border-slate-200 rounded p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={handleConfigSave}
                                disabled={saving}
                                className="bg-slate-900 text-white px-4 py-2 rounded text-sm font-bold hover:bg-black transition disabled:opacity-50"
                            >
                                {saving ? "Guardando..." : "Guardar Cambios"}
                            </button>
                            <button
                                onClick={handleTestReport}
                                className="bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded text-sm font-medium hover:bg-slate-50 transition"
                            >
                                Descargar Reporte PDF
                            </button>
                        </div>
                    </div>
                </div>


                {/* 3. Dangerous Zone */}
                <div className="bg-white p-6 rounded-lg border border-red-100 shadow-sm relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-1 h-full bg-red-500"></div>
                    <h3 className="font-bold text-red-700 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                        Control de Sesión
                    </h3>
                    <p className="text-sm text-slate-600 mb-6">Si el bot se traba o necesitas cambiar de número, podés cerrar la sesión aquí. Esto requerirá escanear el QR de nuevo.</p>

                    <button
                        onClick={handleLogout}
                        className="w-full bg-red-50 text-red-700 border border-red-200 px-4 py-3 rounded text-sm font-bold hover:bg-red-100 transition flex justify-center items-center gap-2"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                        DESCONECTAR SESIÓN
                    </button>
                </div>
            </div>

            {/* 4. Knowledge Base Editor */}
            <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col h-[500px]">
                <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                    <div>
                        <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wide">Base de Conocimiento (JSON)</h3>
                        <p className="text-xs text-slate-500">Edita el script de ventas y respuestas rápidas.</p>
                    </div>
                    <button
                        onClick={handleScriptSave}
                        disabled={scriptLoading}
                        className="bg-blue-600 text-white px-4 py-1.5 rounded text-xs font-bold hover:bg-blue-700 transition"
                    >
                        {scriptLoading ? "Guardando..." : "GUARDAR SCRIPT"}
                    </button>
                </div>
                <div className="flex-1 p-0 relative">
                    <textarea
                        value={scriptJson}
                        onChange={e => setScriptJson(e.target.value)}
                        className="w-full h-full p-4 font-mono text-xs text-slate-700 resize-none outline-none focus:bg-slate-50 transition"
                        spellCheck="false"
                    />
                </div>
            </div>
        </div >
    );
};

export default SettingsView;


