import React from 'react';

const AlertsPanelV3 = ({ alerts, onCommand, onQuickAction }) => {
    return (
        <div className="lg:col-span-2 bg-white/70 backdrop-blur-xl rounded-3xl p-6 lg:p-8 border border-slate-200/60 shadow-sm flex flex-col h-[500px]">
            <div className="flex justify-between items-end mb-6">
                <div>
                    <div className="flex items-center gap-3 mb-1">
                        <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
                            <svg className="w-5 h-5 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                        </div>
                        <h2 className="text-xl font-bold text-slate-800">Alertas Pendientes</h2>
                    </div>
                    <p className="text-sm text-slate-500 font-medium pl-13 hidden sm:block">Avisos urgentes de intervención manual o fallos.</p>
                </div>
                <span className="bg-orange-100 text-orange-700 text-xs font-black px-3 py-1 rounded-full uppercase tracking-wider">
                    {alerts.length} Notific.
                </span>
            </div>

            <div className="overflow-y-auto pr-2 space-y-3 flex-1 hide-scrollbar">
                {alerts.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center p-6 border-2 border-dashed border-slate-200 rounded-2xl bg-slate-50/50">
                        <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                            <svg className="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        </div>
                        <p className="text-slate-500 mb-1 font-bold">Todo despejado</p>
                        <p className="text-sm text-slate-400">El bot está operando por su cuenta sin interrupciones.</p>
                    </div>
                ) : (
                    alerts.map((alert, idx) => (
                        <div key={idx} className="group relative bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-sm hover:shadow-md hover:border-orange-200 transition-all duration-300">
                            <div className="flex flex-col sm:flex-row justify-between gap-4">
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-2">
                                        <div className="w-2 h-2 rounded-full bg-orange-500 animate-pulse"></div>
                                        <h4 className="font-bold text-slate-800 tracking-tight">{alert.reason}</h4>
                                        <span className="text-[10px] text-slate-400 font-medium bg-slate-100 px-2 py-0.5 rounded-full">{new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                    </div>
                                    <p className="text-sm text-slate-600 mb-4 bg-slate-50/50 p-3 rounded-xl border border-slate-100">
                                        {alert.details || "El bot no pudo continuar o ha solicitado asistencia manual."}
                                    </p>

                                    {/* Action Buttons */}
                                    <div className="flex flex-wrap items-center gap-2">
                                        <button onClick={() => onQuickAction(alert.userPhone, 'chat')} className="inline-flex items-center gap-2 bg-slate-900 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-slate-800 transition-colors shadow-sm">
                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                                            Ver Chat
                                        </button>
                                        <button onClick={() => onQuickAction(alert.userPhone, 'vincular')} className="inline-flex items-center gap-2 bg-indigo-50 text-indigo-600 px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-indigo-100 transition-colors">
                                            Bot: Vincular Envío
                                        </button>
                                        <button onClick={() => onQuickAction(alert.userPhone, 'recolectar')} className="inline-flex items-center gap-2 bg-blue-50 text-blue-600 px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-blue-100 transition-colors">
                                            Bot: Interceder Logística
                                        </button>
                                        <div className="flex-1"></div>
                                        <button onClick={() => onQuickAction(alert.userPhone, 'descartar')} className="text-slate-400 hover:text-rose-500 p-1.5 rounded-lg hover:bg-rose-50 transition-colors" title="Descartar">
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};

export default AlertsPanelV3;
