import React, { useState } from 'react';

import { Phone, Trash2 as Trash, Plus } from 'lucide-react';

const SystemStatusPanelV2 = ({ status, activeConversations = 0, adminNumbers = [], onAddPhone, onRemovePhone, onRegenerateQR }) => {
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
        <div className="bg-white/60 dark:bg-slate-800/60 backdrop-blur-xl rounded-3xl border border-white/80 dark:border-slate-700/80 shadow-[0_8px_30px_rgb(0,0,0,0.04)] flex flex-col relative overflow-hidden group">
            {/* Background glow */}
            <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-400/10 dark:bg-indigo-900/20 blur-[60px] rounded-full pointer-events-none group-hover:bg-indigo-400/20 dark:group-hover:bg-indigo-900/30 transition-colors duration-500"></div>

            <div className="px-6 py-5 border-b border-white/60 dark:border-slate-700/60 bg-white/40 dark:bg-slate-800/40">
                <h3 className="font-extrabold text-slate-800 dark:text-slate-100 text-sm uppercase tracking-widest">Sistema</h3>
            </div>

            <div className="p-6 flex-1 flex flex-col gap-8 relative z-10">
                {/* Connection Status */}
                <div className="space-y-4">
                    <div className="flex justify-between items-center pb-4 border-b border-slate-200/50 dark:border-slate-700/50">
                        <div className="flex items-center gap-4">
                            <div className={`w-3 h-3 rounded-full ${status === 'ready' ? 'bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.5)]' : 'bg-rose-500 animate-pulse shadow-[0_0_12px_rgba(244,63,94,0.5)]'}`}></div>
                            <span className="text-sm font-bold text-slate-700 dark:text-slate-200">API WhatsApp</span>
                        </div>
                        <span className={`text-[10px] font-extrabold font-mono px-3 py-1 rounded-full border ${status === 'ready' ? 'bg-emerald-100/50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/50' : 'bg-rose-100/50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-800/50'}`}>
                            {status === 'ready' ? 'CONECTADO' : status === 'scan_qr' ? 'ESPERANDO QR' : 'ERROR'}
                        </span>
                    </div>

                    <div className="pb-4 border-b border-slate-200/50 dark:border-slate-700/50">
                        <button
                            onClick={handleRegenerateQR}
                            disabled={regenerating || status === 'scan_qr'}
                            className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 text-indigo-700 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-800/50 rounded-xl px-4 py-3 text-sm font-bold hover:from-blue-100 dark:hover:from-blue-900/40 hover:to-indigo-100 dark:hover:to-indigo-900/40 transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {regenerating ? (
                                <><div className="w-4 h-4 border-2 border-indigo-700 dark:border-indigo-400 border-t-transparent dark:border-t-transparent rounded-full animate-spin"></div> Desconectando...</>
                            ) : status === 'scan_qr' ? (
                                '⏳ Esperando escaneo...'
                            ) : (
                                '📱 Regenerar QR'
                            )}
                        </button>
                    </div>

                </div>

                {/* Admin Phone Numbers */}
                <div className="flex-1 flex flex-col pt-2">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shadow-inner">
                                <Phone className="w-5 h-5" />
                            </div>
                            <h4 className="text-sm font-extrabold text-slate-700 dark:text-slate-200">Administradores</h4>
                        </div>
                        <span className="text-[10px] text-slate-400 dark:text-slate-500 font-bold bg-slate-100 dark:bg-slate-700/50 px-2 py-0.5 rounded-md">{adminNumbers.length} config.</span>
                    </div>

                    <div className="space-y-2 mb-6 flex-1 overflow-auto max-h-40 pr-2 custom-scrollbar">
                        {adminNumbers.length === 0 ? (
                            <div className="py-8 text-center bg-slate-50 dark:bg-slate-800/50 border border-dashed border-slate-200 dark:border-slate-700 rounded-2xl">
                                <p className="text-slate-400 dark:text-slate-500 text-xs font-medium px-4">No hay números configurados para recibir alertas por WhatsApp.</p>
                            </div>
                        ) : (
                            adminNumbers.map((num, idx) => (
                                <div key={idx} className="flex items-center justify-between bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 group hover:border-indigo-300 dark:hover:border-indigo-500/50 hover:shadow-md transition-all">
                                    <div className="flex items-center gap-3">
                                        <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]"></div>
                                        <span className="text-sm font-bold font-mono text-slate-700 dark:text-slate-200 group-hover:text-indigo-700 dark:group-hover:text-indigo-400 transition-colors">+{num}</span>
                                    </div>
                                    <button
                                        onClick={() => onRemovePhone(num)}
                                        className="w-8 h-8 rounded-lg bg-rose-50 dark:bg-rose-900/30 text-rose-400 dark:text-rose-500 hover:text-white hover:bg-rose-500 dark:hover:bg-rose-600 flex items-center justify-center transition-all opacity-0 group-hover:opacity-100 transform scale-90 group-hover:scale-100"
                                        title="Eliminar número"
                                    >
                                        <Trash className="w-4 h-4" />
                                    </button>
                                </div>
                            ))
                        )}
                    </div>

                    <div className="flex gap-2 relative">
                        <input
                            type="text"
                            value={newPhone}
                            onChange={(e) => setNewPhone(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                            placeholder="Ej: 5493411234567"
                            className="flex-1 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm font-medium focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all shadow-inner placeholder:text-slate-400 dark:placeholder:text-slate-500 dark:text-slate-100"
                        />
                        <button
                            onClick={handleAdd}
                            disabled={addingPhone || !newPhone.trim()}
                            className="bg-slate-800 dark:bg-indigo-600 text-white w-12 h-12 flex items-center justify-center rounded-xl hover:bg-black dark:hover:bg-indigo-500 transition-all disabled:opacity-50 disabled:scale-100 active:scale-95 shadow-md shadow-slate-800/20 dark:shadow-indigo-900/20"
                        >
                            <Plus className="w-5 h-5" />
                        </button>
                    </div>
                    <p className="text-[10px] font-medium text-slate-400 dark:text-slate-500 mt-2 text-center">Formato internacional sin + ni espacios</p>
                </div>
            </div>
        </div>
    );
};

export default SystemStatusPanelV2;
