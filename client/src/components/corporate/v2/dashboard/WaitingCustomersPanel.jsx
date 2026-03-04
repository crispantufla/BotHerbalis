import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Clock, PhoneCall, UserCheck, RefreshCw } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '';

/**
 * WaitingCustomersPanel
 * Shows all paused users (post-sale, admin validation, manual pauses) with their reason
 * and the time they've been waiting. Allows unpause from here.
 */
const WaitingCustomersPanel = () => {
    const [customers, setCustomers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [resuming, setResuming] = useState(null);

    const fetchWaiting = useCallback(async () => {
        try {
            setLoading(true);
            const res = await axios.get(`${API_URL}/api/chat/waiting-customers`, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            setCustomers(res.data.customers || []);
        } catch (e) {
            console.error('[WaitingCustomersPanel] Failed to fetch:', e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchWaiting();
        const interval = setInterval(fetchWaiting, 30_000); // auto-refresh every 30s
        return () => clearInterval(interval);
    }, [fetchWaiting]);

    const handleResume = async (phone) => {
        try {
            setResuming(phone);
            const chatId = `${phone}@c.us`;
            await axios.post(`${API_URL}/api/chat/toggle-bot`, { chatId, paused: false }, {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            setCustomers(prev => prev.filter(c => c.phone !== phone));
        } catch (e) {
            console.error('[WaitingCustomersPanel] Failed to resume:', e.message);
        } finally {
            setResuming(null);
        }
    };

    const formatTimeAgo = (dateStr) => {
        if (!dateStr) return 'Hace un rato';
        const diff = Date.now() - new Date(dateStr).getTime();
        const mins = Math.floor(diff / 60000);
        const hrs = Math.floor(mins / 60);
        const days = Math.floor(hrs / 24);
        if (days > 0) return `Hace ${days}d ${hrs % 24}h`;
        if (hrs > 0) return `Hace ${hrs}h ${mins % 60}m`;
        return `Hace ${mins}m`;
    };

    return (
        <div className="bg-white/6 dark:bg-slate-800/60 backdrop-blur-xl rounded-[1.25rem] border border-white/8 dark:border-slate-700/80 shadow-lg overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200/10 dark:border-slate-700/60">
                <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-lg">
                        <PhoneCall className="w-4 h-4 text-white" />
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-slate-800 dark:text-white leading-tight">
                            Clientes Esperando
                        </h3>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">Bot en silencio, requieren atención humana</p>
                    </div>
                </div>
                <button
                    onClick={fetchWaiting}
                    disabled={loading}
                    className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700/60 transition-colors"
                    title="Actualizar"
                >
                    <RefreshCw className={`w-4 h-4 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {/* Content */}
            <div className="divide-y divide-slate-200/10 dark:divide-slate-700/40 max-h-72 overflow-y-auto">
                {loading && customers.length === 0 ? (
                    Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="flex items-center gap-3 px-5 py-3 animate-pulse">
                            <div className="w-10 h-10 rounded-full bg-slate-200/40 dark:bg-slate-700/50" />
                            <div className="flex-1 space-y-1.5">
                                <div className="h-3.5 bg-slate-200/40 dark:bg-slate-700/50 rounded w-32" />
                                <div className="h-2.5 bg-slate-200/40 dark:bg-slate-700/50 rounded w-48" />
                            </div>
                        </div>
                    ))
                ) : customers.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10 text-center">
                        <UserCheck className="w-9 h-9 text-emerald-400 mb-2" />
                        <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">¡Todo al día!</p>
                        <p className="text-xs text-slate-400 mt-0.5">No hay clientes esperando atención</p>
                    </div>
                ) : (
                    customers.map((c) => (
                        <div key={c.phone} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50/5 transition-colors group">
                            {/* Avatar */}
                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white text-sm font-bold shrink-0 shadow">
                                {c.phone?.slice(-2)}
                            </div>

                            {/* Info */}
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">
                                    +{c.phone}
                                </p>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                                    {c.pauseReason || 'Pausado'}
                                </p>
                            </div>

                            {/* Time */}
                            <div className="flex flex-col items-end gap-1.5 shrink-0">
                                <div className="flex items-center gap-1 text-[11px] text-amber-500 dark:text-amber-400 font-medium">
                                    <Clock className="w-3 h-3" />
                                    {formatTimeAgo(c.pausedAt)}
                                </div>
                                <button
                                    onClick={() => handleResume(c.phone)}
                                    disabled={resuming === c.phone}
                                    className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 transition-colors disabled:opacity-50"
                                >
                                    {resuming === c.phone ? 'Reanudando…' : 'Reanudar Bot'}
                                </button>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Footer count */}
            {customers.length > 0 && (
                <div className="px-5 py-2.5 bg-amber-500/5 border-t border-amber-500/10">
                    <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                        {customers.length} cliente{customers.length > 1 ? 's' : ''} esperando respuesta manual
                    </p>
                </div>
            )}
        </div>
    );
};

export default WaitingCustomersPanel;
