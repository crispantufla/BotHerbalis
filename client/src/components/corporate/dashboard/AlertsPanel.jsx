import React, { useState } from 'react';
import { Icons } from './Icons';

const AlertsPanel = ({ alerts, onCommand, onQuickAction }) => {
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

    const toggleExpand = (id) => {
        setExpandedCards(prev => ({ ...prev, [id]: !prev[id] }));
    };

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
        <div className="lg:col-span-2 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 flex items-center justify-center shadow-lg shadow-rose-500/25">
                            <Icons.Alert />
                        </div>
                        {alerts.length > 0 && (
                            <span className="absolute -top-1 -right-1 w-5 h-5 bg-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center ring-2 ring-white animate-pulse">
                                {alerts.length}
                            </span>
                        )}
                    </div>
                    <div>
                        <h3 className="font-bold text-slate-800 text-sm tracking-tight">Intervenciones</h3>
                        <p className="text-[11px] text-slate-400">{alerts.length > 0 ? `${alerts.length} requieren atención` : 'Todo en orden'}</p>
                    </div>
                </div>
            </div>

            {/* Empty State */}
            {alerts.length === 0 ? (
                <div className="relative overflow-hidden rounded-2xl border border-slate-100 bg-gradient-to-br from-slate-50 to-white p-10 text-center">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-emerald-50 to-transparent rounded-bl-full opacity-60" />
                    <div className="relative">
                        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-emerald-100 to-teal-50 flex items-center justify-center text-3xl shadow-sm">
                            ✅
                        </div>
                        <p className="text-slate-600 text-sm font-semibold">Sin alertas pendientes</p>
                        <p className="text-slate-400 text-xs mt-1.5 max-w-[220px] mx-auto leading-relaxed">
                            Las intervenciones aparecerán acá cuando un pedido requiera tu aprobación
                        </p>
                    </div>
                </div>
            ) : (
                <div className="space-y-3">
                    {alerts.map((alert, index) => {
                        const od = alert.orderData || {};
                        const addr = od.address || {};
                        const hasOrder = od.product || od.price;
                        const inputValue = adminInputs[alert.id] || '';
                        const isSending = sendingCommand[alert.id] || false;
                        const isExpanded = expandedCards[alert.id] !== false; // Default expanded

                        return (
                            <div
                                key={alert.id}
                                className="group relative rounded-2xl border border-slate-200/80 bg-white shadow-sm hover:shadow-md transition-all duration-300 overflow-hidden"
                                style={{ animationDelay: `${index * 100}ms` }}
                            >
                                {/* Accent gradient bar */}
                                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-rose-500 via-pink-500 to-orange-400" />

                                {/* Header */}
                                <div
                                    className="px-5 pt-5 pb-3 cursor-pointer"
                                    onClick={() => toggleExpand(alert.id)}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex items-start gap-3 flex-1 min-w-0">
                                            {/* Priority indicator */}
                                            <div className="flex-shrink-0 mt-0.5">
                                                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 flex items-center justify-center text-white text-lg shadow-md shadow-rose-500/20">
                                                    ⚡
                                                </div>
                                            </div>

                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className="inline-flex items-center px-2 py-0.5 rounded-lg text-[10px] font-bold bg-gradient-to-r from-rose-500 to-pink-600 text-white uppercase tracking-wider shadow-sm">
                                                        Urgente
                                                    </span>
                                                    <span className="text-[11px] text-slate-400 font-medium">
                                                        {getTimeDiff(alert.timestamp)}
                                                    </span>
                                                </div>
                                                <h4 className="font-bold text-slate-800 text-sm leading-snug line-clamp-2">{alert.reason}</h4>
                                                <p className="text-xs text-slate-400 mt-0.5 font-mono tracking-tight">{alert.userPhone}</p>
                                            </div>
                                        </div>

                                        {/* Quick action buttons */}
                                        <div className="flex flex-wrap items-center gap-1.5 mt-2 sm:mt-0">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); onQuickAction(alert.userPhone, 'chat'); }}
                                                className="px-2.5 py-1.5 bg-white text-slate-600 border border-slate-200 rounded-lg text-xs font-medium hover:bg-slate-50 hover:text-slate-800 transition-colors shadow-sm"
                                                title="Ir a conversación"
                                            >
                                                <Icons.Message />
                                            </button>

                                            {/* Legacy Approve/Intercede Buttons */}
                                            {hasOrder && (alert.reason.toLowerCase().includes('inesperada') || alert.reason.toLowerCase().includes('aprobaci')) && (
                                                <button onClick={(e) => { e.stopPropagation(); onQuickAction(alert.userPhone, 'confirmar'); }} className="px-3 py-1.5 bg-gradient-to-r from-emerald-500 to-teal-500 text-white rounded-lg text-xs font-bold hover:from-emerald-600 hover:to-teal-600 transition-all shadow-sm shadow-emerald-500/20 active:scale-95 flex items-center justify-center">
                                                    APROBAR
                                                </button>
                                            )}
                                            <button onClick={(e) => { e.stopPropagation(); toggleExpand(alert.id); }} className="px-3 py-1.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-lg text-xs font-bold hover:from-amber-600 hover:to-orange-600 transition-all shadow-sm shadow-amber-500/20 active:scale-95 flex items-center justify-center">
                                                INTERCEDER
                                            </button>

                                            <button
                                                onClick={(e) => { e.stopPropagation(); onQuickAction(alert.userPhone, 'descartar'); }}
                                                className="px-2.5 py-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-colors"
                                                title="Descartar alerta"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* Expandable content */}
                                {isExpanded && (
                                    <>
                                        {/* Order Details */}
                                        {hasOrder && (
                                            <div className="mx-5 mb-3 p-4 rounded-xl bg-gradient-to-br from-slate-50 to-slate-100/50 border border-slate-100">
                                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                                    {/* Product */}
                                                    <div className="flex items-start gap-3">
                                                        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-500 flex items-center justify-center text-white shadow-sm flex-shrink-0">
                                                            <Icons.Package />
                                                        </div>
                                                        <div>
                                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Producto</p>
                                                            <p className="text-sm font-bold text-slate-800">{od.product || '—'}</p>
                                                            <p className="text-xs text-slate-500 mt-0.5">
                                                                Plan {od.plan || '?'} días —{' '}
                                                                <span className="font-bold text-emerald-600">${od.price || '?'}</span>
                                                            </p>
                                                        </div>
                                                    </div>

                                                    {/* Address */}
                                                    <div className="flex items-start gap-3">
                                                        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center text-white shadow-sm flex-shrink-0">
                                                            <Icons.MapPin />
                                                        </div>
                                                        <div>
                                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Envío</p>
                                                            <p className="text-sm font-semibold text-slate-800">{addr.nombre || '—'}</p>
                                                            <p className="text-xs text-slate-500 mt-0.5">
                                                                {addr.calle || '?'}, {addr.ciudad || '?'}{' '}
                                                                {addr.cp ? <span className="text-slate-400">(CP {addr.cp})</span> : ''}
                                                            </p>
                                                        </div>
                                                    </div>
                                                </div>

                                                {alert.details && (
                                                    <div className="mt-3 pt-3 border-t border-slate-200/60">
                                                        <p className="text-xs text-slate-500 italic leading-relaxed">💬 {alert.details}</p>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Removed quick suggestion chips */}

                                        {/* Admin Input */}
                                        <div className="px-5 pb-4">
                                            <div className="flex gap-2">
                                                <div className="relative flex-1">
                                                    <input
                                                        type="text"
                                                        value={inputValue}
                                                        onChange={(e) => setAdminInputs(prev => ({ ...prev, [alert.id]: e.target.value }))}
                                                        onKeyDown={(e) => e.key === 'Enter' && handleSend(alert, inputValue)}
                                                        placeholder="Instrucción para la IA..."
                                                        className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400 outline-none transition-all placeholder:text-slate-300"
                                                    />
                                                </div>
                                                <button
                                                    onClick={() => handleSend(alert, inputValue)}
                                                    disabled={isSending || !inputValue.trim()}
                                                    className="bg-gradient-to-r from-blue-500 to-indigo-500 text-white px-5 py-2.5 rounded-xl hover:from-blue-600 hover:to-indigo-600 transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2 text-xs font-bold shadow-md shadow-blue-500/20 hover:shadow-lg hover:shadow-blue-500/30 active:scale-95"
                                                >
                                                    {isSending ? (
                                                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                                    ) : (
                                                        <Icons.Send />
                                                    )}
                                                    Enviar
                                                </button>
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default AlertsPanel;
