import React, { useState, useEffect, useCallback } from 'react';
import {
    LifeBuoy, RefreshCw, Search, MessageCircle, Clock, AlertCircle, Send,
    CheckCircle2, HelpCircle, ChevronDown, ChevronUp
} from 'lucide-react';
import api from '../../config/axios';
import {
    Card, Button, IconButton, Badge, Input, Select, EmptyState, useToast, cn
} from '../ui';

const STEP_LABELS = {
    'waiting_admin_validation':   'Esperando validación admin',
    'waiting_final_confirmation': 'Confirmación final',
    'waiting_maps_confirmation':  'Confirmación de dirección',
    'waiting_data':               'Cargando datos de envío',
    'waiting_transfer_confirmation': 'Esperando transferencia',
    'waiting_mp_payment':         'Pago MercadoPago pendiente',
    'waiting_payment_method':     'Eligiendo método de pago',
    'waiting_plan_choice':        'Eligiendo plan (60 vs 120)',
    'waiting_ok':                 'Confirmación intermedia',
    'waiting_preference':         'Eligiendo producto',
    'waiting_weight':             'Indicando objetivo de peso',
};

// Tono semántico por paso — más cerca del cierre = success, más lejos = warning.
const STEP_TONE = {
    'waiting_admin_validation':   'success',
    'waiting_final_confirmation': 'success',
    'waiting_maps_confirmation':  'success',
    'waiting_data':                'info',
    'waiting_transfer_confirmation': 'info',
    'waiting_mp_payment':          'info',
    'waiting_payment_method':      'accent',
    'waiting_plan_choice':         'purple',
    'waiting_ok':                  'purple',
    'waiting_preference':          'danger',
    'waiting_weight':              'warning',
};

const PRESET_FILTERS = [
    { label: 'Calientes (1-4h)',  min: 60,   max: 240 },
    { label: 'Tibios (4-24h)',    min: 240,  max: 1440 },
    { label: 'Fríos (1-7 días)',  min: 1440, max: 60 * 24 * 7 },
    { label: 'Todos (1h+)',       min: 60,   max: 60 * 24 * 30 },
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
    const tone = STEP_TONE[step] || 'neutral';
    return <Badge tone={tone} size="sm">{label}</Badge>;
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
        if (!onGoToChat) { toast.warning('No se puede abrir chat desde aquí'); return; }
        const chatId = lead.phone.includes('@') ? lead.phone : `${lead.phone}@c.us`;
        onGoToChat(chatId);
    };

    return (
        <div className="w-full space-y-4">
            <header className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-11 h-11 rounded-card bg-warning-50 dark:bg-warning-900/30 text-warning-600 dark:text-warning-500 flex items-center justify-center flex-shrink-0">
                        <LifeBuoy className="w-5 h-5" aria-hidden="true" />
                    </div>
                    <div>
                        <h1 className="text-h2 text-slate-900 dark:text-slate-100">Cola de rescate</h1>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            {total} leads detenidos en el embudo · ordenados por proximidad al cierre
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={HelpCircle}
                        rightIcon={showHowTo ? ChevronUp : ChevronDown}
                        onClick={() => setShowHowTo(v => !v)}
                    >
                        ¿Qué es esto?
                    </Button>
                    <Button
                        size="sm"
                        leftIcon={RefreshCw}
                        onClick={fetchQueue}
                        loading={loading}
                    >
                        Actualizar
                    </Button>
                </div>
            </header>

            {showHowTo && (
                <Card padding="md" className="border-accent-200 dark:border-accent-900/40 bg-accent-50/40 dark:bg-accent-900/10">
                    <div className="text-sm text-slate-700 dark:text-slate-300 space-y-2">
                        <p>
                            Esta vista lista los <strong>leads atascados</strong>: clientes que llegaron a algún paso pero no respondieron en los últimos 60+ minutos.
                            Están ordenados por <strong>cercanía al cierre</strong>: primero los que están en confirmación final, luego los que eligieron método de pago, etc.
                        </p>
                        <p>
                            El bot ya envía recordatorios automáticos a las 4h, 24h y 48-72h. Esta vista te permite <strong>tomar control proactivamente</strong> sin esperar al cron.
                        </p>
                        <p>
                            <strong>Calientes</strong> = mejores candidatos para tomarlos manualmente ya. <strong>Tibios</strong> = el bot ya escribió, vale un toque humano. <strong>Fríos</strong> = última oportunidad antes de marcarlos como perdidos.
                        </p>
                    </div>
                </Card>
            )}

            {/* Preset filters */}
            <div className="flex flex-wrap gap-1.5">
                {PRESET_FILTERS.map((f, i) => (
                    <button
                        key={i}
                        type="button"
                        onClick={() => setFilterIdx(i)}
                        className={cn(
                            'inline-flex items-center px-3 h-8 rounded-control text-xs font-semibold transition-colors',
                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                            filterIdx === i
                                ? 'bg-accent-600 text-white'
                                : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'
                        )}
                    >
                        {f.label}
                    </button>
                ))}
            </div>

            {/* Search + step filter */}
            <div className="flex flex-col md:flex-row gap-2">
                <div className="flex-1">
                    <Input
                        leftIcon={Search}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Buscar por teléfono o nombre…"
                        aria-label="Buscar lead"
                    />
                </div>
                <div className="md:w-72">
                    <Select
                        value={stepFilter}
                        onChange={(e) => setStepFilter(e.target.value)}
                        aria-label="Filtrar por paso"
                    >
                        <option value="">Todos los pasos ({leads.length})</option>
                        {Object.entries(stepCounts)
                            .sort(([, a], [, b]) => b - a)
                            .map(([step, count]) => (
                                <option key={step} value={step}>
                                    {STEP_LABELS[step] || step} ({count})
                                </option>
                            ))}
                    </Select>
                </div>
            </div>

            {/* Status summary */}
            {!loading && leads.length > 0 && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-control bg-warning-50 dark:bg-warning-900/20 border border-warning-100 dark:border-warning-900/40">
                    <AlertCircle className="w-4 h-4 text-warning-600 dark:text-warning-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
                    <p className="text-xs text-warning-700 dark:text-warning-500">
                        Mostrando <strong>{filteredLeads.length}</strong> de <strong>{leads.length}</strong> leads.
                        {generatedAt && ` Última actualización: ${new Date(generatedAt).toLocaleTimeString('es-AR')}.`}
                    </p>
                </div>
            )}

            {/* Tabla */}
            <Card padding="none" className="overflow-hidden">
                {loading ? (
                    <div className="p-10 text-center flex flex-col items-center gap-2">
                        <RefreshCw className="w-6 h-6 animate-spin text-accent-600 dark:text-accent-400" aria-hidden="true" />
                        <p className="text-sm text-slate-500 dark:text-slate-400">Cargando leads…</p>
                    </div>
                ) : filteredLeads.length === 0 ? (
                    <EmptyState
                        icon={CheckCircle2}
                        title="¡Sin leads atascados!"
                        description="Ningún lead coincide con los filtros actuales."
                    />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-slate-50 dark:bg-slate-800/40 text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
                                <tr>
                                    <th className="px-4 py-2.5 text-left">Cliente</th>
                                    <th className="px-4 py-2.5 text-left">Paso actual</th>
                                    <th className="px-4 py-2.5 text-left">
                                        <Clock className="w-3 h-3 inline mr-1" aria-hidden="true" />
                                        Inactivo
                                    </th>
                                    <th className="px-4 py-2.5 text-left">Producto</th>
                                    <th className="px-4 py-2.5 text-left">Plan</th>
                                    <th className="px-4 py-2.5 text-left">Total</th>
                                    <th className="px-4 py-2.5 text-left">Reminders</th>
                                    <th className="px-4 py-2.5 text-right">Acción</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                {filteredLeads.map((l, i) => (
                                    <tr key={`${l.phone}-${i}`} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors">
                                        <td className="px-4 py-2.5">
                                            <p className="font-medium text-sm text-slate-900 dark:text-slate-100">
                                                {l.name || <span className="text-slate-400 dark:text-slate-500 italic font-normal">sin nombre</span>}
                                            </p>
                                            <p className="text-xs font-mono text-slate-500 dark:text-slate-400">{l.phone}</p>
                                        </td>
                                        <td className="px-4 py-2.5">
                                            <StepBadge step={l.step} />
                                        </td>
                                        <td className="px-4 py-2.5 text-xs font-mono text-slate-700 dark:text-slate-300 tabular-nums">
                                            {formatIdleTime(l.minutesIdle)}
                                        </td>
                                        <td className="px-4 py-2.5 text-xs text-slate-700 dark:text-slate-300">
                                            {l.selectedProduct
                                                ? l.selectedProduct.split(' de ')[0]
                                                : <span className="text-slate-400 dark:text-slate-500">—</span>}
                                        </td>
                                        <td className="px-4 py-2.5 text-xs text-slate-700 dark:text-slate-300">
                                            {l.selectedPlan
                                                ? <span className="font-mono tabular-nums">{l.selectedPlan}d</span>
                                                : <span className="text-slate-400 dark:text-slate-500">—</span>}
                                        </td>
                                        <td className="px-4 py-2.5 text-xs text-slate-700 dark:text-slate-300">
                                            {l.cartTotal
                                                ? <span className="font-semibold tabular-nums">${l.cartTotal}</span>
                                                : <span className="text-slate-400 dark:text-slate-500">—</span>}
                                        </td>
                                        <td className="px-4 py-2.5">
                                            <div className="flex items-center gap-1">
                                                {l.reengagementSent && (
                                                    <Badge tone="info" size="sm" title="Primer recordatorio enviado">
                                                        <Send className="w-2.5 h-2.5" />
                                                        1°
                                                    </Badge>
                                                )}
                                                {l.secondFollowUpSent && (
                                                    <Badge tone="purple" size="sm" title="Segundo recordatorio enviado">
                                                        <Send className="w-2.5 h-2.5" />
                                                        2°
                                                    </Badge>
                                                )}
                                                {!l.reengagementSent && !l.secondFollowUpSent && (
                                                    <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-2.5 text-right">
                                            <Button
                                                size="sm"
                                                onClick={() => handleTakeOver(l)}
                                                leftIcon={MessageCircle}
                                                className="!bg-success-600 hover:!bg-success-700"
                                            >
                                                Tomar control
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            <p className="text-xs text-slate-500 dark:text-slate-400 text-center">
                "Tomar control" abre el chat del cliente y pausa el bot para que respondas vos manualmente.
            </p>
        </div>
    );
};

export default RescueQueueView;
