import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useSocket } from '../context/SocketContext';
import { QRCodeSVG } from 'qrcode.react';

const Dashboard = () => {
    const { socket } = useSocket();
    const [status, setStatus] = useState('initializing');
    const [qrCode, setQrCode] = useState(null);
    const [clientInfo, setClientInfo] = useState(null);
    const [alerts, setAlerts] = useState([]);
    const [config, setConfig] = useState({ alertNumber: '' });

    const API_URL = 'http://localhost:3001';

    useEffect(() => {
        fetchStatus();
        fetchAlerts(); // Initial fetch

        if (socket) {
            socket.on('qr', (qr) => { setStatus('scan_qr'); setQrCode(qr); });
            socket.on('ready', ({ info }) => { setStatus('ready'); setQrCode(null); setClientInfo(info); });
            socket.on('status_change', ({ status }) => { setStatus(status); if (status === 'disconnected') { setClientInfo(null); setQrCode(null); } });

            // Real-time Alerts
            socket.on('new_alert', (newAlert) => {
                setAlerts(prev => [newAlert, ...prev]);
            });
        }
        return () => {
            if (socket) {
                socket.off('qr');
                socket.off('ready');
                socket.off('status_change');
                socket.off('new_alert');
            }
        };
    }, [socket]);

    const fetchStatus = async () => {
        try {
            const res = await axios.get(`${API_URL}/api/status`);
            setStatus(res.data.status);
            setQrCode(res.data.qr);
            setClientInfo(res.data.info);
            if (res.data.config) setConfig(res.data.config);
        } catch (e) { console.error(e); }
    };

    const fetchAlerts = async () => {
        try {
            const res = await axios.get(`${API_URL}/api/alerts`);
            setAlerts(res.data);
        } catch (e) { console.error(e); }
    };

    const handleAction = async (chatId, command) => {
        try {
            await axios.post(`${API_URL}/api/admin-command`, { chatId, command });
            // Optimistic update: remove alert if handled
            setAlerts(prev => prev.filter(a => a.userPhone !== chatId));
        } catch (e) { alert(e.message); }
    };

    return (
        <div className="h-full flex flex-col md:flex-row gap-6 p-2">

            {/* --- LEFT PANEL: ALERT CENTER (Large) --- */}
            <div className="flex-1 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col">
                <div className="p-4 border-b bg-red-50 flex items-center gap-2">
                    <span className="text-2xl">⚠️</span>
                    <h2 className="text-lg font-bold text-red-800">Centro de Alertas</h2>
                    <span className="ml-auto bg-red-200 text-red-800 text-xs px-2 py-1 rounded-full font-bold">
                        {alerts.length} Pendientes
                    </span>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
                    {alerts.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-gray-400 opacity-60">
                            <span className="text-6xl mb-4">🛡️</span>
                            <p>Todo tranquilo. No hay alertas activas.</p>
                        </div>
                    ) : (
                        alerts.map(alert => (
                            <div key={alert.id} className="bg-white border-l-4 border-red-500 rounded shadow-sm p-4 animate-fade-in relative">
                                <span className="absolute top-2 right-2 text-xs text-gray-400">{new Date(alert.timestamp).toLocaleTimeString()}</span>
                                <h3 className="font-bold text-red-700 text-lg mb-1">{alert.reason}</h3>
                                <p className="text-gray-600 font-medium mb-2">{alert.userName} ({alert.userPhone})</p>

                                <div className="bg-gray-50 p-3 rounded text-sm text-gray-700 whitespace-pre-wrap mb-4 border border-gray-100">
                                    {alert.details}
                                </div>

                                <div className="flex gap-3 mt-2">
                                    <button
                                        onClick={() => handleAction(alert.userPhone, 'confirmar')}
                                        className="flex-1 bg-green-600 text-white py-2 rounded hover:bg-green-700 transition font-medium text-sm"
                                    >
                                        ✅ Confirmar Pedido
                                    </button>
                                    <button
                                        onClick={() => handleAction(alert.userPhone, 'yo me encargo')}
                                        className="flex-1 bg-gray-700 text-white py-2 rounded hover:bg-gray-800 transition font-medium text-sm"
                                    >
                                        ✋ Lo manejo yo (Pausar Bot)
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>

            {/* --- RIGHT PANEL: SYSTEM STATUS (Small) --- */}
            <div className="w-full md:w-80 flex flex-col gap-6">

                {/* Connection Status Card */}
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                    <h3 className="text-gray-500 font-bold uppercase text-xs mb-4 tracking-wider">Estado del Sistema</h3>

                    <div className="flex items-center gap-4 mb-6">
                        <div className={`w-12 h-12 rounded-full flex items-center justify-center text-xl transition-all ${status === 'ready' ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'
                            }`}>
                            {status === 'ready' ? '📶' : '🔌'}
                        </div>
                        <div>
                            <p className="font-bold text-gray-800">
                                {status === 'ready' ? 'WhatsApp Conectado' :
                                    status === 'scan_qr' ? 'Escaneá el QR' : 'Desconectado'}
                            </p>
                            <p className="text-xs text-gray-500">
                                {clientInfo ? `+${clientInfo.wid.user}` : 'Esperando conexión...'}
                            </p>
                        </div>
                    </div>

                    {status === 'scan_qr' && qrCode && (
                        <div className="flex justify-center mb-6">
                            <QRCodeSVG value={qrCode} size={180} className="border p-2 rounded" />
                        </div>
                    )}

                    <div className="border-t pt-4 space-y-3">
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-gray-600">Google Sheets</span>
                            <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs font-bold">● Sincronizado</span>
                        </div>
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-gray-600">Base de Conocimiento</span>
                            <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs font-bold">● Cargada</span>
                        </div>
                    </div>
                </div>

                {/* Config Card */}
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex-1 flex flex-col">
                    <h3 className="text-gray-500 font-bold uppercase text-xs mb-4 tracking-wider flex items-center justify-between">
                        Admin Sync
                        {config.alertNumber && <span className="text-green-500 text-[10px] bg-green-50 px-2 py-0.5 rounded-full">Activo</span>}
                    </h3>

                    {!config.alertNumber ? (
                        <div className="flex-1 flex flex-col justify-center animate-fade-in">
                            <p className="text-xs text-gray-500 mb-2">Configurá tu celular para recibir alertas:</p>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    placeholder="Ej: 54911..."
                                    className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-green-500 outline-none bg-gray-50"
                                    id="newAlertNumber"
                                />
                                <button
                                    onClick={async () => {
                                        const val = document.getElementById('newAlertNumber').value;
                                        if (!val) return;
                                        try {
                                            await axios.post(`${API_URL}/api/config`, { alertNumber: val });
                                            setConfig(prev => ({ ...prev, alertNumber: val }));
                                        } catch (e) { alert('Error al guardar'); }
                                    }}
                                    className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 text-sm font-medium shadow-sm transition-transform active:scale-95"
                                >
                                    Guardar
                                </button>
                            </div>
                            <p className="text-[10px] text-gray-400 mt-2">💡 Incluí el código de país (ej: 549 para Arg)</p>
                        </div>
                    ) : (
                        <div className="flex-1 flex flex-col justify-center animate-fade-in">
                            <p className="text-xs text-gray-400 mb-1">Dispositivo vinculado:</p>
                            <div className="flex items-center justify-between bg-green-50 border border-green-100 rounded-lg p-3 mb-3">
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-full bg-green-200 text-green-700 flex items-center justify-center text-lg">📱</div>
                                    <span className="font-mono text-gray-700 font-medium text-lg">+{config.alertNumber}</span>
                                </div>
                                <span className="text-xl text-green-500">✓</span>
                            </div>

                            <button
                                onClick={async () => {
                                    if (!confirm('¿Dejar de recibir alertas en este número?')) return;
                                    try {
                                        await axios.post(`${API_URL}/api/config`, { alertNumber: null });
                                        setConfig(prev => ({ ...prev, alertNumber: '' }));
                                    } catch (e) { alert('Error al eliminar'); }
                                }}
                                className="text-red-500 text-xs hover:text-red-700 hover:underline text-center transition"
                            >
                                Cambiar o eliminar número
                            </button>
                        </div>
                    )}
                </div>
            </div>

        </div>
    );
};

export default Dashboard;
