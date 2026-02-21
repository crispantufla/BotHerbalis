import React, { useState } from 'react';

const IconsV2 = {
    Alert: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>,
    Message: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>,
    Check: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>,
    Send: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>,
    Package: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>,
    MapPin: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
};

const AlertsPanelV2 = ({ alerts, onCommand, onQuickAction }) => {
    const [adminInputs, setAdminInputs] = useState({});
    const [sendingCommand, setSendingCommand] = useState({});
    const [expandedCards, setExpandedCards] = useState({});

    const handleSend = async (alert, command) => {
        if (!command.trim()) return;
        setSendingCommand(prev => ({ ...prev, [alert.id]: true }));
        await onCommand(alert, command);
        setSendingCommand(prev => ({ ...prev, [alert.id]: false }));
        setAdminInputs(prev => ({ ...prev, [alert.id]: '' }));
    };

    const toggleExpand = (id) => setExpandedCards(prev => ({ ...prev, [id]: !prev[id] }));

    const getTimeDiff = (timestamp) => {
        const diff = Date.now() - new Date(timestamp).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'Ahora';
        if (mins < 60) return `${mins}m`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h`;
        return `${Math.floor(hrs / 24)}d`;
    };

    const quickSuggestions = [
        { label: '✅ Confirmar', cmd: 'confirmar' },
        { label: '📦 Modificar', cmd: 'confirma el cambio de producto' },
        { label: '💬 Derivar', cmd: 'decile que me comunico por privado' },
    ];

    return (
        <div className="lg:col-span-2 space-y-6">
            {/* Header V2 */}
            <div className="flex items-center justify-between bg-white/40 backdrop-blur-md p-5 rounded-3xl border border-white/60 shadow-sm">
                <div className="flex items-center gap-4">
                    <div className="relative">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-rose-400 via-pink-500 to-rose-600 flex items-center justify-center shadow-lg shadow-rose-500/30 text-white">
                            <IconsV2.Alert />
                        </div>
                        {alerts.length > 0 && (
                            <span className="absolute -top-2 -right-2 w-6 h-6 bg-rose-600 text-white text-xs font-bold rounded-full flex items-center justify-center ring-4 ring-white shadow-lg animate-bounce">
                                {alerts.length}
                            </span>
                        )}
                    </div>
                    <div>
                        <h3 className="font-extrabold text-slate-800 text-lg tracking-tight">Intervenciones</h3>
                        <p className="text-sm font-medium text-slate-500">{alerts.length > 0 ? `Atención requerida` : 'Sistema automatizado funcionando'}</p>
                    </div>
                </div>
            </div>

            {/* Empty State V2 */}
            {alerts.length === 0 ? (
                <div className="relative overflow-hidden rounded-3xl border border-white/60 bg-white/40 backdrop-blur-md p-12 text-center shadow-sm">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-400/10 blur-[80px] rounded-full pointer-events-none" />
                    <div className="absolute bottom-0 left-0 w-64 h-64 bg-teal-400/10 blur-[80px] rounded-full pointer-events-none" />

                    <div className="relative z-10">
                        <div className="w-20 h-20 mx-auto mb-6 rounded-3xl bg-gradient-to-br from-emerald-100 to-teal-50 flex items-center justify-center text-4xl shadow-md border border-white">
                            ✨
                        </div>
                        <p className="text-slate-800 text-xl font-extrabold mb-2">Todo bajo control</p>
                        <p className="text-slate-500 text-sm max-w-sm mx-auto font-medium">
                            El bot está gestionando todas las conversaciones en automático. Las alertas aparecerán aquí cuando un cliente requiera tu atención directa.
                        </p>
                    </div>
                </div>
            ) : (
                <div className="space-y-4">
                    {alerts.map((alert, index) => {
                        const od = alert.orderData || {};
                        const addr = od.address || {};
                        const hasOrder = od.product || od.price;
                        const inputValue = adminInputs[alert.id] || '';
                        const isSending = sendingCommand[alert.id] || false;
                        const isExpanded = expandedCards[alert.id] !== false;

                        return (
                            <div key={alert.id} className="group overflow-hidden rounded-3xl border border-white/80 bg-white/60 backdrop-blur-xl shadow-lg hover:shadow-xl transition-all duration-300">
                                {/* Header del Alerta */}
                                <div className="p-6 cursor-pointer hover:bg-white/40 transition-colors" onClick={() => toggleExpand(alert.id)}>
                                    <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-4">
                                        <div className="flex items-start gap-4">
                                            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-rose-100 to-pink-50 flex items-center justify-center text-rose-500 text-xl shadow-inner border border-rose-100 shrink-0">
                                                🚨
                                            </div>
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                                                    <span className="px-3 py-1 rounded-full text-[10px] font-extrabold bg-rose-500 text-white uppercase tracking-widest shadow-sm shadow-rose-500/20">
                                                        Urgente
                                                    </span>
                                                    <span className="text-xs font-semibold text-slate-400 bg-slate-100 px-2 py-1 rounded-full whitespace-nowrap">
                                                        {getTimeDiff(alert.timestamp)}
                                                    </span>
                                                </div>
                                                <h4 className="font-bold text-slate-800 text-base leading-snug truncate">{alert.reason}</h4>
                                                <p className="text-sm font-medium text-slate-500 mt-1 truncate">{alert.userPhone}</p>
                                            </div>
                                        </div>

                                        <div className="flex flex-wrap items-center gap-2 mt-2 sm:mt-0 w-full lg:w-auto">
                                            <button onClick={(e) => { e.stopPropagation(); onQuickAction(alert.userPhone, 'chat'); }} className="p-2.5 bg-indigo-50 text-indigo-600 rounded-xl hover:bg-indigo-100 transition-colors flex-1 sm:flex-none flex justify-center items-center" title="Ver Chat">
                                                <IconsV2.Message />
                                            </button>
                                            <button onClick={(e) => { e.stopPropagation(); onQuickAction(alert.userPhone, 'confirmar'); }} className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl text-xs font-bold hover:bg-emerald-600 transition-colors shadow-md shadow-emerald-500/20">
                                                <IconsV2.Check /> Aprobar
                                            </button>
                                            <button onClick={(e) => { e.stopPropagation(); onQuickAction(alert.userPhone, 'descartar'); }} className="p-2.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 rounded-xl transition-colors">
                                                ✕
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* Contenido Expandido */}
                                {isExpanded && (
                                    <div className="border-t border-slate-200/50 bg-white/30 p-6">
                                        {hasOrder && (
                                            <div className="mb-6 bg-white/80 rounded-2xl p-5 border border-slate-100 shadow-sm">
                                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                                                    <div className="flex gap-4 items-center">
                                                        <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center"><IconsV2.Package /></div>
                                                        <div>
                                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Pedido</p>
                                                            <p className="font-bold text-slate-800">{od.product}</p>
                                                            <p className="text-sm font-medium text-emerald-600">Plan {od.plan} • ${od.price}</p>
                                                        </div>
                                                    </div>
                                                    <div className="flex gap-4 items-center">
                                                        <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center"><IconsV2.MapPin /></div>
                                                        <div>
                                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Envío</p>
                                                            <p className="font-bold text-slate-800">{addr.nombre}</p>
                                                            <p className="text-sm text-slate-500">{addr.calle}, {addr.ciudad}</p>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        <div className="flex flex-wrap gap-2 mb-4">
                                            {quickSuggestions.map((s, i) => (
                                                <button key={i} onClick={() => handleSend(alert, s.cmd)} disabled={isSending} className="px-4 py-2 rounded-xl bg-white border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 text-xs font-bold text-slate-600 hover:text-indigo-700 transition-all shadow-sm">
                                                    {s.label}
                                                </button>
                                            ))}
                                        </div>

                                        <div className="flex gap-3">
                                            <input
                                                type="text"
                                                value={inputValue}
                                                onChange={(e) => setAdminInputs(prev => ({ ...prev, [alert.id]: e.target.value }))}
                                                onKeyDown={(e) => e.key === 'Enter' && handleSend(alert, inputValue)}
                                                placeholder="Instrucción en lenguaje natural para la IA..."
                                                className="flex-1 bg-white border border-slate-200 rounded-xl px-5 py-3 text-sm focus:ring-2 focus:ring-indigo-500/50 outline-none font-medium placeholder:text-slate-400 shadow-inner"
                                            />
                                            <button
                                                onClick={() => handleSend(alert, inputValue)}
                                                disabled={isSending || !inputValue.trim()}
                                                className="bg-indigo-600 text-white px-6 py-3 rounded-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2 text-sm font-bold shadow-lg shadow-indigo-600/20 transition-all"
                                            >
                                                {isSending ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <IconsV2.Send />}
                                                Enviar a IA
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default AlertsPanelV2;
