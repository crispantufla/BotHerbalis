import React, { useState } from 'react';

const SystemStatusPanelV3 = ({ status, activeConversations, adminNumbers, onAddPhone, onRemovePhone, onRegenerateQR }) => {
    const [newPhone, setNewPhone] = useState('');

    const handleAdd = (e) => {
        e.preventDefault();
        onAddPhone(newPhone);
        setNewPhone('');
    };

    return (
        <div className="bg-white/70 backdrop-blur-xl rounded-3xl p-6 lg:p-8 border border-slate-200/60 shadow-sm flex flex-col h-[500px]">
            <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center">
                    <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
                </div>
                <div>
                    <h2 className="text-xl font-bold text-slate-800">Sistema Core</h2>
                    <p className="text-xs text-slate-500 font-medium">Estado y Diagnóstico</p>
                </div>
            </div>

            <div className="space-y-6 flex-1 overflow-y-auto hide-scrollbar pr-2">

                {/* Connection Box */}
                <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
                    <div className="flex justify-between items-center mb-3">
                        <span className="text-sm font-semibold text-slate-500 uppercase tracking-widest">Conexión Global</span>
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold ${status === 'ready' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                            {status === 'ready' ? 'ESTABLE' : (status === 'scan_qr' ? 'ESPERANDO LOGIN' : status)}
                        </span>
                    </div>
                    {status === 'ready' && (
                        <button
                            onClick={onRegenerateQR}
                            className="w-full mt-2 bg-white border border-slate-200 hover:border-red-200 hover:bg-red-50 text-slate-600 hover:text-red-600 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-300"
                        >
                            <span className="flex items-center justify-center gap-2">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                                Desconectar WA y Renovar QR
                            </span>
                        </button>
                    )}
                </div>

                {/* Admins List */}
                <div>
                    <h3 className="text-sm font-bold text-slate-800 mb-3 flex items-center justify-between">
                        Números Autorizados (Admins)
                        <span className="bg-slate-200 text-slate-600 text-[10px] px-2 py-0.5 rounded-full">{adminNumbers?.length || 0}</span>
                    </h3>

                    <div className="space-y-2 mb-4">
                        {adminNumbers.length === 0 ? (
                            <div className="text-sm text-slate-400 italic bg-white border border-slate-100 p-3 rounded-xl text-center">Nadie recibe alertas.</div>
                        ) : (
                            adminNumbers.map((num, idx) => (
                                <div key={idx} className="flex justify-between items-center bg-white border border-slate-200 p-3 rounded-xl hover:shadow-sm transition-all group">
                                    <span className="text-sm font-mono text-slate-700 tracking-wide font-medium">{num}</span>
                                    <button onClick={() => onRemovePhone(num)} className="text-slate-300 hover:text-rose-500 transition-colors p-1" title="Revocar">
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                    </button>
                                </div>
                            ))
                        )}
                    </div>

                    <form onSubmit={handleAdd} className="relative">
                        <input
                            type="text"
                            value={newPhone}
                            onChange={(e) => setNewPhone(e.target.value)}
                            placeholder="Añadir celular (ej: 54911...)"
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-4 pr-12 py-3 text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all outline-none font-medium text-slate-700 placeholder:text-slate-400"
                        />
                        <button
                            type="submit"
                            disabled={!newPhone}
                            className="absolute right-2 top-2 bottom-2 bg-slate-900 disabled:bg-slate-300 text-white p-1.5 rounded-lg transition-colors hover:bg-slate-800"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>
                        </button>
                    </form>
                </div>

            </div>
        </div>
    );
};

export default SystemStatusPanelV3;
