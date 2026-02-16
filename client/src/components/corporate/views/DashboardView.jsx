import React from 'react';

// Icons
const Icons = {
    Wifi: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" /></svg>,
    Alert: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>,
};

const CorporateDashboardView = ({ alerts, config, handleQuickAction, status }) => {
    return (
        <div className="space-y-6 animate-fade-in">
            {/* A. KPI DECK */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                {/* KPI 1 */}
                <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-1 h-full bg-blue-600"></div>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Ventas Totales (Hoy)</p>
                    <h3 className="text-2xl font-bold text-slate-800">$12,450.00</h3>
                    <p className="text-xs text-emerald-600 mt-2 font-medium flex items-center">
                        <span className="bg-emerald-100 px-1 rounded mr-1">↑ 12%</span> vs ayer
                    </p>
                </div>
                {/* KPI 2 */}
                <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-1 h-full bg-indigo-600"></div>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Sesiones Activas</p>
                    <h3 className="text-2xl font-bold text-slate-800">45</h3>
                    <p className="text-xs text-slate-500 mt-2">Capacidad de uso al 45%</p>
                </div>
                {/* KPI 3 */}
                <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-1 h-full bg-rose-600"></div>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Alertas Pendientes</p>
                    <h3 className="text-2xl font-bold text-slate-800">{alerts.length}</h3>
                    <p className="text-xs text-rose-600 mt-2 font-medium">Requiere atención</p>
                </div>
                {/* KPI 4 */}
                <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-1 h-full bg-slate-600"></div>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Sinc. Admin</p>
                    <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                        <span className="font-mono text-sm font-medium">{config.alertNumber ? `+${config.alertNumber}` : 'No Configurado'}</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-2">Dispositivo Destino</p>
                </div>
            </div>

            {/* B. MAIN GRID SPLIT */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[600px]">

                {/* B1. ALERTS TABLE (Takes 2 cols) */}
                <div className="lg:col-span-2 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col">
                    <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                        <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wide flex items-center gap-2">
                            <Icons.Alert /> Logs de Seguridad e Intervención
                        </h3>
                        <div className="flex gap-2">
                            <span className="text-xs text-slate-500 px-2 py-1 bg-white border border-slate-200 rounded shadow-sm">Filtro: Todo</span>
                            <span className="text-xs text-slate-500 px-2 py-1 bg-white border border-slate-200 rounded shadow-sm">Ordenar: Reciente</span>
                        </div>
                    </div>

                    <div className="flex-1 overflow-auto custom-scrollbar">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 text-slate-500 font-medium text-xs uppercase sticky top-0 shadow-sm z-10">
                                <tr>
                                    <th className="px-6 py-3 border-b border-slate-200">Severidad</th>
                                    <th className="px-6 py-3 border-b border-slate-200">Hora</th>
                                    <th className="px-6 py-3 border-b border-slate-200">Usuario / Fuente</th>
                                    <th className="px-6 py-3 border-b border-slate-200">Mensaje / Detonante</th>
                                    <th className="px-6 py-3 border-b border-slate-200 text-right">Acciones</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {alerts.length === 0 ? (
                                    <tr>
                                        <td colSpan="5" className="px-6 py-12 text-center text-slate-400 italic">
                                            No hay alertas de seguridad activas. El sistema opera normalmente.
                                        </td>
                                    </tr>
                                ) : (
                                    alerts.map(alert => (
                                        <tr key={alert.id} className="hover:bg-slate-50 transition-colors group">
                                            <td className="px-6 py-4 border-b border-slate-50">
                                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800 border border-rose-200">
                                                    CRITICO
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-slate-500 font-mono text-xs border-b border-slate-50">
                                                {new Date(alert.timestamp).toLocaleTimeString()}
                                            </td>
                                            <td className="px-6 py-4 font-medium text-slate-700 border-b border-slate-50">
                                                {alert.userPhone}
                                            </td>
                                            <td className="px-6 py-4 text-slate-600 max-w-xs truncate border-b border-slate-50" title={alert.details}>
                                                {alert.reason}
                                            </td>
                                            <td className="px-6 py-4 text-right border-b border-slate-50 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    onClick={() => handleQuickAction(alert.userPhone, 'confirmar')}
                                                    className="text-emerald-700 hover:text-emerald-900 text-xs font-bold mr-3 uppercase tracking-wide"
                                                >
                                                    Aprobar
                                                </button>
                                                <button
                                                    onClick={() => handleQuickAction(alert.userPhone, 'yo me encargo')}
                                                    className="text-slate-500 hover:text-slate-800 text-xs font-bold uppercase tracking-wide"
                                                >
                                                    Intervenir
                                                </button>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* B2. SYSTEM HEALTH & FEED (Right Col) */}
                <div className="flex flex-col gap-6">
                    {/* System Status Panel */}
                    <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-6">
                        <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wide mb-4">Estado del Sistema</h3>

                        <div className="space-y-4">
                            <div className="flex justify-between items-center pb-3 border-b border-slate-100">
                                <div className="flex items-center gap-3">
                                    <div className={`w-2 h-2 rounded-full ${status === 'ready' ? 'bg-emerald-500 shadow-lg shadow-emerald-200' : 'bg-rose-500 animate-pulse'}`}></div>
                                    <span className="text-sm font-medium text-slate-700">API WhatsApp</span>
                                </div>
                                <span className={`text-xs font-mono px-2 py-0.5 rounded border ${status === 'ready' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                                    {status === 'ready' ? 'CONECTADO' : 'ERR_CONEX'}
                                </span>
                            </div>

                            <div className="flex justify-between items-center pb-3 border-b border-slate-100">
                                <div className="flex items-center gap-3">
                                    <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                                    <span className="text-sm font-medium text-slate-700">Sinc. Google Sheets</span>
                                </div>
                                <span className="text-xs font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">SINCRONIZADO</span>
                            </div>

                            <div className="flex justify-between items-center">
                                <div className="flex items-center gap-3">
                                    <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                                    <span className="text-sm font-medium text-slate-700">Latencia Base de Datos</span>
                                </div>
                                <span className="text-xs font-mono text-slate-500">24ms</span>
                            </div>
                        </div>
                    </div>

                    {/* Activity Log (Mini) */}
                    <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex-1 flex flex-col">
                        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
                            <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wide">Feed en Vivo</h3>
                        </div>
                        <div className="p-4 space-y-3 overflow-auto flex-1 h-0 custom-scrollbar">
                            {[1, 2, 3, 4, 5].map(i => (
                                <div key={i} className="flex gap-3 text-xs border-b border-slate-50 last:border-0 pb-2 last:pb-0">
                                    <span className="text-slate-400 font-mono">14:0{2 * i}</span>
                                    <div>
                                        <span className="font-bold text-slate-700">Sistema</span>
                                        <span className="text-slate-500 ml-1">procesó mensaje entrante ID #892{i}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CorporateDashboardView;
