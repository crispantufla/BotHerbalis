import React, { useState } from 'react';
import { Icons } from './Icons';

const SystemStatusPanel = ({ status, qrData, activeConversations = 0, adminNumbers = [], onAddPhone, onRemovePhone, onRegenerateQR }) => {
    const [newPhone, setNewPhone] = useState('');
    const [addingPhone, setAddingPhone] = useState(false);
    const [regenerating, setRegenerating] = useState(false);

    const handleRegenerateQR = async () => {
        setRegenerating(true);
        try {
            await onRegenerateQR();
        } finally {
            setTimeout(() => setRegenerating(false), 5000);
        }
    };

    const handleAdd = async () => {
        if (!newPhone.trim()) return;
        setAddingPhone(true);
        await onAddPhone(newPhone);
        setAddingPhone(false);
        setNewPhone('');
    };

    return (
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

                    {/* Regenerate QR Button */}
                    <div className="pb-3 border-b border-slate-100">
                        <button
                            onClick={handleRegenerateQR}
                            disabled={regenerating || status === 'scan_qr'}
                            className="w-full flex items-center justify-center gap-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg px-3 py-2 text-sm font-medium hover:bg-blue-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {regenerating ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-blue-700 border-t-transparent rounded-full animate-spin"></div>
                                    Desconectando...
                                </>
                            ) : status === 'scan_qr' ? (
                                '⏳ Esperando escaneo...'
                            ) : (
                                <>
                                    📱 Regenerar QR
                                </>
                            )}
                        </button>
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
                        <span className="text-xs font-mono text-slate-600">{activeConversations} activas</span>
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

                    <div className="space-y-2 mb-4 flex-1 overflow-auto custom-scrollbar max-h-40">
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
                                        onClick={() => onRemovePhone(num)}
                                        className="text-slate-300 hover:text-rose-500 transition opacity-0 group-hover:opacity-100"
                                        title="Eliminar número"
                                    >
                                        <Icons.Trash />
                                    </button>
                                </div>
                            ))
                        )}
                    </div>

                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={newPhone}
                            onChange={(e) => setNewPhone(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                            placeholder="5493411234567"
                            className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500 outline-none transition"
                        />
                        <button
                            onClick={handleAdd}
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
    );
};

export default SystemStatusPanel;
