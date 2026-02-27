import React, { useState } from 'react';

import { AlertCircle as Alert, MessageCircle as Message, Check, Send, Package, MapPin } from 'lucide-react';

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

    const quickSuggestions = [];

    return (
        <div className="lg:col-span-2 space-y-6">
            {/* Header V2 */}
            <div className="flex items-center justify-between bg-white/4 dark:bg-slate-800/40 dark:bg-slate-800/40 backdrop-blur-md p-5 rounded-3xl border border-white/6 dark:border-slate-700/60 dark:border-slate-700/60 shadow-sm">
                <div className="flex items-center gap-4">
                    <div className="relative">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-rose-400 via-pink-500 to-rose-600 flex items-center justify-center shadow-lg shadow-rose-500/30 text-white">
                            <Alert className="w-5 h-5" />
                        </div>
                        {alerts.length > 0 && (
                            <span className="absolute -top-2 -right-2 w-6 h-6 bg-rose-600 text-white text-xs font-bold rounded-full flex items-center justify-center ring-4 ring-white dark:ring-slate-800 shadow-lg animate-bounce">
                                {alerts.length}
                            </span>
                        )}
                    </div>
                    <div>
                        <h3 className="font-extrabold text-slate-800 dark:text-white text-lg tracking-tight">Intervenciones</h3>
                        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{alerts.length > 0 ? `Atención requerida` : 'Sistema automatizado funcionando'}</p>
                    </div>
                </div>
            </div>

            {/* Empty State V2 */}
            {alerts.length === 0 ? (
                <div className="relative overflow-hidden rounded-3xl border border-white/6 dark:border-slate-700/60 dark:border-slate-700/60 bg-white/4 dark:bg-slate-800/40 dark:bg-slate-800/40 backdrop-blur-md p-12 text-center shadow-sm">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-400/10 blur-[80px] rounded-full pointer-events-none" />
                    <div className="absolute bottom-0 left-0 w-64 h-64 bg-teal-400/10 blur-[80px] rounded-full pointer-events-none" />

                    <div className="relative z-10">
                        <div className="w-20 h-20 mx-auto mb-6 rounded-3xl bg-gradient-to-br from-emerald-100 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center text-4xl shadow-md border border-white dark:border-slate-700/50">
                            ✨
                        </div>
                        <p className="text-slate-800 dark:text-white text-xl font-extrabold mb-2">Todo bajo control</p>
                        <p className="text-slate-500 dark:text-slate-400 text-sm max-w-sm mx-auto font-medium">
                            El bot está gestionando todas las conversaciones en automático. Las alertas aparecerán aquí cuando un cliente requiera tu atención directa.
                        </p>
                    </div>
                </div>
            ) : (
                <div className="space-y-4">
                    {alerts.map((alert, index) => {
                        const od = alert.orderData || {};
                        const addr = od.address || {};
                        const hasOrder = !!(od.product || od.price);
                        const cleanPhone = alert.userPhone ? alert.userPhone.split('@')[0] : 'Desconocido';
                        const inputValue = adminInputs[alert.id] || '';
                        const isSending = sendingCommand[alert.id] || false;
                        const isExpanded = expandedCards[alert.id] !== false;

                        return (
                            <div key={alert.id} className="group overflow-hidden rounded-3xl border border-white/8 dark:border-slate-700/80 dark:border-slate-700/80 bg-white/6 dark:bg-slate-800/60 dark:bg-slate-800/60 backdrop-blur-xl shadow-lg hover:shadow-xl transition-all duration-300">
                                {/* Header del Alerta */}
                                <div className="p-6 cursor-pointer hover:bg-white/4 dark:bg-slate-800/40 dark:hover:bg-slate-800/40 transition-colors" onClick={() => toggleExpand(alert.id)}>
                                    <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-4">
                                        <div className="flex items-start gap-4">
                                            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-rose-100 to-pink-50 dark:from-rose-900/30 dark:to-pink-900/30 flex items-center justify-center text-rose-500 dark:text-rose-400 text-xl shadow-inner border border-rose-100 dark:border-rose-900/50 shrink-0">
                                                🚨
                                            </div>
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                                                    <span className="px-3 py-1 rounded-full text-[10px] font-extrabold bg-rose-500 text-white uppercase tracking-widest shadow-sm shadow-rose-500/20">
                                                        Urgente
                                                    </span>
                                                    <span className="text-xs font-semibold text-slate-400 dark:text-slate-300 bg-slate-100 dark:bg-slate-700/50 px-2 py-1 rounded-full whitespace-nowrap">
                                                        {getTimeDiff(alert.timestamp)}
                                                    </span>
                                                </div>
                                                <h4 className="font-bold text-slate-800 dark:text-slate-100 text-base leading-snug truncate">{alert.reason}</h4>
                                                <p className="text-sm font-medium text-slate-500 dark:text-slate-400 mt-1 truncate">{alert.userPhone ? alert.userPhone.split('@')[0] : 'Desconocido'}</p>
                                            </div>
                                        </div>

                                        <div className="flex flex-wrap items-center gap-2 mt-2 sm:mt-0 w-full lg:w-auto">
                                            <button onClick={(e) => { e.stopPropagation(); onQuickAction(alert.userPhone, 'chat'); }} className="p-2.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-xl hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors flex-1 sm:flex-none flex justify-center items-center" title="Ver Chat">
                                                <Message className="w-4 h-4" />
                                            </button>

                                            {/* Legacy Approve/Intercede Buttons */}
                                            {hasOrder && (alert.reason.toLowerCase().includes('inesperada') || alert.reason.toLowerCase().includes('aprobaci')) && (
                                                <button onClick={(e) => { e.stopPropagation(); onQuickAction(alert.userPhone, 'confirmar'); }} className="px-4 py-2 bg-emerald-500 text-white rounded-xl text-xs font-bold hover:bg-emerald-600 transition-colors shadow-md shadow-emerald-500/20 flex-1 sm:flex-none flex items-center justify-center">
                                                    APROBAR
                                                </button>
                                            )}
                                            <button onClick={(e) => { e.stopPropagation(); toggleExpand(alert.id); }} className="px-4 py-2 bg-amber-500 text-white rounded-xl text-xs font-bold hover:bg-amber-600 transition-colors shadow-md shadow-amber-500/20 flex-1 sm:flex-none flex items-center justify-center">
                                                INTERCEDER
                                            </button>

                                            <button onClick={(e) => { e.stopPropagation(); onQuickAction(alert.userPhone, 'descartar'); }} className="p-2.5 text-slate-400 dark:text-slate-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 hover:text-rose-500 dark:hover:text-rose-400 rounded-xl transition-colors">
                                                ✕
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* Contenido Expandido */}
                                {isExpanded && (
                                    <div className="border-t border-slate-200/50 dark:border-slate-700/50 bg-white/3 dark:bg-slate-800/30 dark:bg-slate-800/30 p-6">
                                        {hasOrder && (
                                            <div className="mb-6 bg-white/8 dark:bg-slate-800/80 dark:bg-slate-900/50 rounded-2xl p-5 border border-slate-100 dark:border-slate-800 shadow-sm">
                                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                                                    <div className="flex gap-4 items-center">
                                                        <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center"><Package className="w-5 h-5" /></div>
                                                        <div>
                                                            <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Pedido</p>
                                                            <p className="font-bold text-slate-800 dark:text-slate-200">{od.product}</p>
                                                            <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">Plan {od.plan} • ${od.price}</p>
                                                        </div>
                                                    </div>
                                                    <div className="flex gap-4 items-center">
                                                        <div className="w-10 h-10 rounded-xl bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 flex items-center justify-center"><MapPin className="w-5 h-5" /></div>
                                                        <div>
                                                            <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Envío</p>
                                                            <p className="font-bold text-slate-800 dark:text-slate-200">{addr.nombre}</p>
                                                            <p className="text-sm text-slate-500 dark:text-slate-400">{addr.calle}, {addr.ciudad}</p>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* Removed quick suggestions div */}

                                        {/* Summary text if available (from fallback text passed via details) */}
                                        {alert.details && (
                                            <div className="mb-4 bg-amber-50 dark:bg-amber-900/20 rounded-2xl p-4 border border-amber-100 dark:border-amber-900/50 shadow-sm">
                                                <p className="text-[10px] font-bold text-amber-600 dark:text-amber-500 uppercase tracking-widest mb-1">Detalles de la alerta</p>
                                                <p className="text-sm font-medium text-amber-900 dark:text-amber-200/80 leading-relaxed italic truncate max-w-full">
                                                    "{alert.details}"
                                                </p>
                                            </div>
                                        )}

                                        <form onSubmit={(e) => { e.preventDefault(); handleSend(alert, inputValue); }} className="relative flex gap-3">
                                            <input
                                                type="text"
                                                value={inputValue}
                                                onChange={(e) => setAdminInputs(prev => ({ ...prev, [alert.id]: e.target.value }))}
                                                placeholder="Instrucción en lenguaje natural para la IA..."
                                                className="flex-1 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700/50 rounded-xl px-5 py-3 text-sm focus:ring-2 focus:ring-indigo-500/50 outline-none font-medium placeholder:text-slate-400 dark:placeholder:text-slate-500 dark:text-slate-100 shadow-inner"
                                            />
                                            <button
                                                type="submit"
                                                disabled={isSending || !inputValue.trim()}
                                                className="bg-indigo-600 dark:bg-indigo-500 text-white px-6 py-3 rounded-xl hover:bg-indigo-700 dark:hover:bg-indigo-600 disabled:opacity-50 flex items-center gap-2 text-sm font-bold shadow-lg shadow-indigo-600/20 transition-all"
                                            >
                                                {isSending ? <div className="w-4 h-4 border-2 border-white/3 dark:border-slate-700/30 border-t-white rounded-full animate-spin" /> : <Send className="w-4 h-4" />}
                                                Enviar a IA
                                            </button>
                                        </form>
                                    </div>
                                )
                                }
                            </div>
                        );
                    })}
                </div>
            )
            }
        </div >
    );
};

export default AlertsPanelV2;
