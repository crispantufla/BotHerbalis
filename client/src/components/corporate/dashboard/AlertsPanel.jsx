import React, { useState } from 'react';
import { Icons } from './Icons';

const AlertsPanel = ({ alerts, onCommand, onQuickAction }) => {
    const [adminInputs, setAdminInputs] = useState({});
    const [sendingCommand, setSendingCommand] = useState({});

    // Local wrapper to handle loading state and input clearing
    const handleSend = async (alert, command) => {
        if (!command.trim()) return;
        setSendingCommand(prev => ({ ...prev, [alert.id]: true }));
        await onCommand(alert, command);
        setSendingCommand(prev => ({ ...prev, [alert.id]: false }));
        setAdminInputs(prev => ({ ...prev, [alert.id]: '' }));
    };

    return (
        <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wide flex items-center gap-2">
                    <span className="p-1.5 bg-rose-100 rounded text-rose-600"><Icons.Alert /></span>
                    Alertas de Intervención
                </h3>
                <span className="text-xs text-slate-400 font-mono">{alerts.length} pendientes</span>
            </div>

            {alerts.length === 0 ? (
                <div className="bg-white rounded-lg border border-dashed border-slate-200 p-12 text-center">
                    <div className="text-slate-300 text-4xl mb-3">✅</div>
                    <p className="text-slate-400 text-sm font-medium">No hay alertas pendientes</p>
                    <p className="text-slate-300 text-xs mt-1">Las alertas aparecerán acá cuando un pedido requiera tu aprobación</p>
                </div>
            ) : (
                alerts.map(alert => {
                    const od = alert.orderData || {};
                    const addr = od.address || {};
                    const hasOrder = od.product || od.price;
                    const inputValue = adminInputs[alert.id] || '';
                    const isSending = sendingCommand[alert.id] || false;

                    return (
                        <div key={alert.id} className="bg-white rounded-lg border-l-4 border-l-rose-500 border border-slate-200 shadow-sm overflow-hidden animate-fade-in">

                            {/* Alert Header */}
                            <div className="px-5 py-4 flex items-start justify-between bg-gradient-to-r from-rose-50/50 to-transparent">
                                <div className="flex items-start gap-3 flex-1">
                                    <div className="w-10 h-10 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center font-bold text-sm flex-shrink-0 mt-0.5">
                                        ⚠️
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-200 uppercase tracking-wider">
                                                Crítico
                                            </span>
                                            <span className="text-xs text-slate-400 font-mono">
                                                {new Date(alert.timestamp).toLocaleTimeString()}
                                            </span>
                                        </div>
                                        <h4 className="font-bold text-slate-800 text-sm">{alert.reason}</h4>
                                        <p className="text-xs text-slate-500 mt-0.5 font-mono">{alert.userPhone}</p>
                                    </div>
                                </div>

                                {/* Quick Actions */}
                                <div className="flex items-center gap-1.5 flex-shrink-0 ml-3">
                                    <button
                                        onClick={() => handleSend(alert, 'confirmar')} // Use handleSend for confirming too if desired, or quick action?
                                        // Original passed 'confirmar' to handleAdminCommand.
                                        // But handleAdminCommand takes (alert, command).
                                        // Here we call handleSend(alert, 'confirmar').
                                        className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded-md text-xs font-bold hover:bg-emerald-700 transition shadow-sm"
                                    >
                                        <Icons.Check /> APROBAR
                                    </button>
                                    <button
                                        onClick={() => onQuickAction(alert.userPhone, 'yo me encargo')}
                                        className="flex items-center gap-1 px-3 py-1.5 bg-slate-700 text-white rounded-md text-xs font-bold hover:bg-slate-800 transition shadow-sm"
                                    >
                                        INTERVENIR
                                    </button>
                                </div>
                            </div>

                            {/* Order Summary — Big and visible */}
                            {hasOrder && (
                                <div className="px-5 py-3 bg-slate-50 border-t border-slate-100">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        {/* Product & Price */}
                                        <div className="flex items-start gap-2.5">
                                            <span className="p-1.5 bg-blue-100 rounded text-blue-600 flex-shrink-0 mt-0.5"><Icons.Package /></span>
                                            <div>
                                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Pedido</p>
                                                <p className="text-sm font-bold text-slate-800">{od.product || '—'}</p>
                                                <p className="text-xs text-slate-500">
                                                    Plan {od.plan || '?'} días — <span className="font-bold text-emerald-700">${od.price || '?'}</span>
                                                </p>
                                            </div>
                                        </div>

                                        {/* Address */}
                                        <div className="flex items-start gap-2.5">
                                            <span className="p-1.5 bg-violet-100 rounded text-violet-600 flex-shrink-0 mt-0.5"><Icons.MapPin /></span>
                                            <div>
                                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Dirección</p>
                                                <p className="text-sm font-medium text-slate-800">{addr.nombre || '—'}</p>
                                                <p className="text-xs text-slate-500">
                                                    {addr.calle || '?'}, {addr.ciudad || '?'} {addr.cp ? `(CP ${addr.cp})` : ''}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                    {alert.details && (
                                        <p className="text-xs text-slate-400 mt-2 italic border-t border-slate-100 pt-2">{alert.details}</p>
                                    )}
                                </div>
                            )}

                            {/* Admin Command Input */}
                            <div className="px-5 py-3 border-t border-slate-100 bg-white">
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">💬 Instrucción para la IA</p>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={inputValue}
                                        onChange={(e) => setAdminInputs(prev => ({ ...prev, [alert.id]: e.target.value }))}
                                        onKeyDown={(e) => e.key === 'Enter' && handleSend(alert, inputValue)}
                                        placeholder="Ej: decile que el envío sale mañana, ofrecele descuento..."
                                        className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition placeholder:text-slate-300"
                                    />
                                    <button
                                        onClick={() => handleSend(alert, inputValue)}
                                        disabled={isSending || !inputValue.trim()}
                                        className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition disabled:opacity-40 flex items-center gap-1.5 text-xs font-bold shadow-sm"
                                    >
                                        {isSending ? (
                                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                        ) : (
                                            <Icons.Send />
                                        )}
                                        ENVIAR
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })
            )}
        </div>
    );
};

export default AlertsPanel;
