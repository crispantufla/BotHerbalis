import React, { useState, useEffect, useCallback } from 'react';
import api from '../../config/axios';
import { useToast } from '../ui/Toast';
import {
    LifeBuoy, RefreshCw, Search, MessageCircle, Clock,
    Filter, AlertCircle, Send, CheckCircle2, HelpCircle,
    ChevronDown, ChevronUp
} from 'lucide-react';

const STEP_LABELS = {
    'waiting_admin_validation': 'Esperando validación admin',
    'waiting_final_confirmation': 'Confirmación final',
    'waiting_maps_confirmation': 'Confirmación de dirección',
    'waiting_data': 'Cargando datos de envío',
    'waiting_transfer_confirmation': 'Esperando transferencia',
    'waiting_mp_payment': 'Pago MercadoPago pendiente',
    'waiting_payment_method': 'Eligiendo método de pago',
    'waiting_plan_choice': 'Eligiendo plan (60 vs 120)',
    'waiting_ok': 'Confirmación intermedia',
    'waiting_preference': 'Eligiendo producto',
    'waiting_weight': 'Indicando objetivo de peso',
};

const STEP_COLORS = {
    'waiting_admin_validation': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    'waiting_final_confirmation': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    'waiting_maps_confirmation': 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
    'waiting_data': 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
    'waiting_transfer_confirmation': 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
    'waiting_mp_payment': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    'waiting_payment_method': 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
    'waiting_plan_choice': 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    'waiting_ok': 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
    'waiting_preference': 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
    'waiting_weight': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

const PRESET_FILTERS = [
    { label: 'Calientes (1-4h)', min: 60, max: 240 },
    { label: 'Tibios (4-24h)', min: 240, max: 1440 },
    { label: 'Fríos (1-7 días)', min: 1440, max: 60 * 24 * 7 },
    { label: 'Todos (1h+)', min: 60, max: 60 * 24 * 30 },
];

function formatIdleTime(mins) {
    if (mins < 60) return `${mins} min`;
    if (mins < 1440) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function StepBadge({ step }) {
    const label = STEP_LABELS[step] || step;
    const color = STEP_COLORS[step] || 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300';
    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
            {label}
        </span>
    );
}

const RescueQueueView = ({ onGoToChat }) => {
    const { toast } = useToast();
    const [leads, setLeads] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [filterIdx, setFilterIdx] = useState(0);
    const [stepFilter, setStepFilter] = useState('');
    const [search, setSearch] = useState('');
    const [showHowTo, setShowHowTo] = useState(false);
    const [generatedAt, setGeneratedAt] = useState(null);

    const fetchQueue = useCallback(async () => {
        setLoading(true);
        try {
            const filter = PRESET_FILTERS[filterIdx];
            const r = await api.get(`/api/analytics/rescue-queue?minMinutesIdle=${filter.min}&maxMinutesIdle=${filter.max}`);
            setLeads(r.data.leads || []);
            setTotal(r.data.total || 0);
            setGeneratedAt(r.data.generatedAt || null);
        } catch (e) {
            toast.error('Error cargando cola: ' + (e.response?.data?.error || e.message));
        } finally {
            setLoading(false);
        }
    }, [filterIdx, toast]);

    useEffect(() => { fetchQueue(); }, [fetchQueue]);

    const filteredLeads = leads.filter(l => {
        if (stepFilter && l.step !== stepFilter) return false;
        if (search) {
            const q = search.toLowerCase();
            return (l.phone || '').includes(q) || (l.name || '').toLowerCase().includes(q);
        }
        return true;
    });

    const stepCounts = leads.reduce((acc, l) => {
        acc[l.step] = (acc[l.step] || 0) + 1;
        return acc;
    }, {});

    const handleTakeOver = (lead) => {
        if (!onGoToChat) {
            toast.warning('No se puede abrir chat desde aquí');
            return;
        }
        const chatId = lead.phone.includes('@') ? lead.phone : `${lead.phone}@c.us`;
        onGoToChat(chatId);
    };

    return (
        <div className="p-6 md:p-8 w-full">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg shadow-orange-500/30">
                        <LifeBuoy className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">
                            Cola de rescate
                        </h1>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                            {total} leads detenidos en el embudo · ordenados por proximidad al cierre
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowHowTo(v => !v)}
                        className="px-3 py-2 rounded-lg text-sm bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 flex items-center gap-1.5"
                    >
                        <HelpCircle className="w-4 h-4" />
                        ¿Qué es esto?
                        {showHowTo ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                    <button
                        onClick={fetchQueue}
                        disabled={loading}
                        className="px-3 py-2 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5 disabled:opacity-50"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        Actualizar
                    </button>
                </div>
            </div>

            {/* How-to */}
            {showHowTo && (
                <div className="mb-6 p-4 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 text-sm text-slate-700 dark:text-slate-300">
                    <p className="mb-2">
                        Esta vista lista los <strong>leads atascados</strong> en el embudo de venta:
                        clientes que llegaron a algún paso del proceso pero no respondieron en los
                        últimos 60+ minutos. Están ordenados por <strong>cercanía al cierre</strong>:
                        primero los que ya están en confirmación final, luego los que eligieron método
                        de pago, etc.
                    </p>
                    <p className="mb-2">
                        El bot ya envía recordatorios automáticos a las 4h, 24h y 48-72h. Esta vista
                        te permite <strong>tomar control proactivamente</strong> de los más calientes
                        sin esperar a que el cron actúe.
                    </p>
                    <p>
                        Filtros sugeridos:
                        <strong> "Calientes"</strong> = mejores candidatos para llamada manual ya;
                        <strong> "Tibios"</strong> = el bot ya les escribió, vale la pena un toque humano;
                        <strong> "Fríos"</strong> = última oportunidad antes de marcarlos como perdidos.
                    </p>
                </div>
            )}

            {/* Preset filters */}
            <div className="mb-4 flex flex-wrap gap-2">
                {PRESET_FILTERS.map((f, i) => (
                    <button
                        key={i}
                        onClick={() => setFilterIdx(i)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                            filterIdx === i
                                ? 'bg-indigo-600 text-white shadow'
                                : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'
                        }`}
                    >
                        {f.label}
                    </button>
                ))}
            </div>

            {/* Search + step filter */}
            <div className="mb-4 flex flex-col md:flex-row gap-3">
                <div className="flex-1 relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Buscar por teléfono o nombre..."
                        className="w-full pl-10 pr-4 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                </div>
                <select
                    value={stepFilter}
                    onChange={(e) => setStepFilter(e.target.value)}
                    className="px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200"
                >
                    <option value="">Todos los pasos ({leads.length})</option>
                    {Object.entries(stepCounts)
                        .sort(([, a], [, b]) => b - a)
                        .map(([step, count]) => (
                            <option key={step} value={step}>
                                {STEP_LABELS[step] || step} ({count})
                            </option>
                        ))}
                </select>
            </div>

            {/* Stats summary */}
            {!loading && leads.length > 0 && (
                <div className="mb-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800 dark:text-amber-300">
                        Mostrando <strong>{filteredLeads.length}</strong> de <strong>{leads.length}</strong> leads.
                        {generatedAt && ` Última actualización: ${new Date(generatedAt).toLocaleTimeString('es-AR')}.`}
                    </p>
                </div>
            )}

            {/* Table */}
            <div className="bg-white dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                {loading ? (
                    <div className="p-8 text-center">
                        <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-500" />
                        <p className="mt-2 text-sm text-slate-500">Cargando leads...</p>
                    </div>
                ) : filteredLeads.length === 0 ? (
                    <div className="p-12 text-center">
                        <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-500 mb-3" />
                        <p className="text-slate-700 dark:text-slate-200 font-medium">¡Sin leads atascados!</p>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                            Ningún lead coincide con los filtros actuales.
                        </p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-slate-50 dark:bg-slate-800/80 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wider">
                                <tr>
                                    <th className="px-4 py-3 text-left font-medium">Cliente</th>
                                    <th className="px-4 py-3 text-left font-medium">Paso actual</th>
                                    <th className="px-4 py-3 text-left font-medium">
                                        <Clock className="w-3 h-3 inline mr-1" />
                                        Inactivo
                                    </th>
                                    <th className="px-4 py-3 text-left font-medium">Producto</th>
                                    <th className="px-4 py-3 text-left font-medium">Plan</th>
                                    <th className="px-4 py-3 text-left font-medium">Total</th>
                                    <th className="px-4 py-3 text-left font-medium">Reminders</th>
                                    <th className="px-4 py-3 text-right font-medium">Acción</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                                {filteredLeads.map((l, i) => (
                                    <tr
                                        key={`${l.phone}-${i}`}
                                        className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                                    >
                                        <td className="px-4 py-3">
                                            <div className="font-medium text-slate-800 dark:text-slate-100">
                                                {l.name || <span className="text-slate-400 italic">sin nombre</span>}
                                            </div>
                                            <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                                                {l.phone}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <StepBadge step={l.step} />
                                        </td>
                                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300 font-mono text-xs">
                                            {formatIdleTime(l.minutesIdle)}
                                        </td>
                                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                                            {l.selectedProduct
                                                ? l.selectedProduct.split(' de ')[0]
                                                : <span className="text-slate-400 text-xs">—</span>}
                                        </td>
                                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                                            {l.selectedPlan
                                                ? <span className="font-mono">{l.selectedPlan}d</span>
                                                : <span className="text-slate-400 text-xs">—</span>}
                                        </td>
                                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                                            {l.cartTotal
                                                ? <span className="font-medium">${l.cartTotal}</span>
                                                : <span className="text-slate-400 text-xs">—</span>}
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-1">
                                                {l.reengagementSent && (
                                                    <span title="Primer recordatorio enviado" className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 text-xs">
                                                        <Send className="w-3 h-3 inline mr-0.5" />1°
                                                    </span>
                                                )}
                                                {l.secondFollowUpSent && (
                                                    <span title="Segundo recordatorio enviado" className="px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 text-xs">
                                                        <Send className="w-3 h-3 inline mr-0.5" />2°
                                                    </span>
                                                )}
                                                {!l.reengagementSent && !l.secondFollowUpSent && (
                                                    <span className="text-xs text-slate-400">—</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <button
                                                onClick={() => handleTakeOver(l)}
                                                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium flex items-center gap-1.5 ml-auto transition"
                                            >
                                                <MessageCircle className="w-3.5 h-3.5" />
                                                Tomar control
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Footer help text */}
            <p className="mt-4 text-xs text-slate-500 dark:text-slate-400 text-center">
                "Tomar control" abre el chat del cliente y pausa al bot para que respondas vos manualmente.
            </p>
        </div>
    );
};

export default RescueQueueView;
