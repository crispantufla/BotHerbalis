import React, { useState, useEffect, useCallback } from 'react';
import { Gift, RefreshCw, Play, Pause, Square, Send, Users, MessageCircle, Eye, ChevronDown, ChevronUp, Plus, Pencil } from 'lucide-react';
import api from '../../config/axios';
import { Card, Button, Badge, Input, KpiCard, EmptyState, useToast, cn } from '../ui';

// Campañas promo: reactivación de leads que hablaron con el bot y no compraron.
// El envío lo hace el servidor de a uno, con pausas al azar (ver
// src/services/promo/). Acá se arma la campaña, se la pone en marcha y se mira
// cómo va.

const STATUS = {
    draft:     { label: 'Borrador',   tone: 'neutral' },
    running:   { label: 'Corriendo',  tone: 'success' },
    paused:    { label: 'Pausada',    tone: 'warning' },
    finished:  { label: 'Terminada',  tone: 'info' },
    cancelled: { label: 'Cancelada',  tone: 'danger' },
};
const RECIPIENT_STATUS = {
    pending: { label: 'Pendiente', tone: 'neutral' },
    sent: { label: 'Enviado', tone: 'info' },
    skipped: { label: 'Salteado', tone: 'warning' },
    failed: { label: 'Falló', tone: 'danger' },
    opted_out: { label: 'No quiere', tone: 'danger' },
};
const OUTCOME = {
    interested: { label: 'Interesado', tone: 'success' },
    declined: { label: 'No le interesó', tone: 'warning' },
    question: { label: 'Preguntó', tone: 'purple' },
    opted_out: { label: 'Pidió no recibir', tone: 'danger' },
};
const SKIP_REASONS = {
    pausado: 'estaba pausado', ya_compro: 'ya compró', charla_reciente: 'escribió hace poco',
    pidio_no_recibir: 'pidió no recibir', ya_recibio_promo: 'ya tenía la promo', estado_terminal: 'estado terminal',
    pedido_en_curso: 'pedido en curso', envio_fallido: 'el envío falló',
};
const TEMPLATE_BLOCKS = [
    ['greeting', 'Saludo'], ['reason', 'Motivo'], ['empathy', 'Empatía'], ['offer', 'Oferta'],
    ['reassure', 'Tranquilidad'], ['cta', 'Llamado a la acción'], ['signoff', 'Despedida'],
];

const DEFAULT_FORM = {
    name: '',
    windowStartHour: 10, windowEndHour: 20, dailyCap: 30,
    minGapMinutes: 6, maxGapMinutes: 25, longBreakEvery: 8,
    skipWeekends: false, skipIfInboundHours: 48,
    // Últimos 6 meses menos los últimos 30 días: quien escribió hace poco puede
    // tener un pedido en curso o una charla viva.
    minDaysSinceLastSeen: 30, maxDaysSinceLastSeen: 180, limit: 10000, cooldownDays: 90,
};

const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

// Miniatura del flyer. La imagen la sirve la API con JWT, así que no alcanza un
// <img src>: se baja con axios y se muestra como object URL.
function PromoImageThumb() {
    const [url, setUrl] = useState(null);
    useEffect(() => {
        let objectUrl = null;
        let cancelled = false;
        api.get('/api/promo/image', { responseType: 'blob' })
            .then((r) => { if (cancelled) return; objectUrl = URL.createObjectURL(r.data); setUrl(objectUrl); })
            .catch(() => {});
        return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, []);
    if (!url) return <div className="w-16 h-20 rounded-control bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex-shrink-0" />;
    return <img src={url} alt="Flyer de la promo" className="w-16 h-20 object-cover rounded-control border border-slate-200 dark:border-slate-700 flex-shrink-0" />;
}

function NumField({ label, value, onChange, min, max, hint, disabled = false }) {
    return (
        <Input
            type="number" label={label} value={value} min={min} max={max} helperText={hint} disabled={disabled}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
    );
}

const PromoView = ({ onGoToChat }) => {
    const { toast } = useToast();
    const [campaigns, setCampaigns] = useState([]);
    const [price60, setPrice60] = useState(null);
    const [loading, setLoading] = useState(false);
    const [selectedId, setSelectedId] = useState(null);
    const [detail, setDetail] = useState(null);
    const [recipientFilter, setRecipientFilter] = useState('');
    const [showCreate, setShowCreate] = useState(false);
    const [form, setForm] = useState(DEFAULT_FORM);
    const [templates, setTemplates] = useState(null); // null = textos por defecto (respaldo del modo IA)
    const [showTemplates, setShowTemplates] = useState(false);
    // Modo IA: Claude reescribe el mensaje base con ligeras diferencias en cada envío.
    const [variationMode, setVariationMode] = useState('ai');
    const [baseMessage, setBaseMessage] = useState('');
    // El flyer va unos segundos después del texto.
    const [imageEnabled, setImageEnabled] = useState(true);
    // Campaña que se está editando (null = el formulario crea una nueva). Se
    // puede editar una campaña corriendo: el próximo envío usa los valores nuevos.
    const [editingId, setEditingId] = useState(null);
    const [audience, setAudience] = useState(null);
    const [samples, setSamples] = useState(null);
    const [busy, setBusy] = useState(false);

    const fetchCampaigns = useCallback(async () => {
        setLoading(true);
        try {
            const r = await api.get('/api/promo/campaigns');
            setCampaigns(r.data.campaigns || []);
            setPrice60(r.data.price60 || null);
            // Prefill del mensaje base con el del servidor (solo la primera vez).
            setBaseMessage(prev => prev || r.data.baseMessageDefault || '');
        } catch (e) {
            toast.error('Error cargando campañas: ' + (e.response?.data?.error || e.message));
        } finally {
            setLoading(false);
        }
    }, [toast]);

    const fetchDetail = useCallback(async (id, status) => {
        if (!id) { setDetail(null); return; }
        try {
            const r = await api.get(`/api/promo/campaigns/${id}${status ? `?status=${status}` : ''}`);
            setDetail(r.data);
        } catch (e) {
            toast.error('Error cargando la campaña: ' + (e.response?.data?.error || e.message));
        }
    }, [toast]);

    useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);
    useEffect(() => { fetchDetail(selectedId, recipientFilter); }, [fetchDetail, selectedId, recipientFilter]);

    // Mientras hay una campaña corriendo, refrescar cada minuto.
    useEffect(() => {
        if (!campaigns.some(c => c.status === 'running')) return undefined;
        const t = setInterval(() => { fetchCampaigns(); if (selectedId) fetchDetail(selectedId, recipientFilter); }, 60000);
        return () => clearInterval(t);
    }, [campaigns, fetchCampaigns, fetchDetail, selectedId, recipientFilter]);

    const setF = (k) => (v) => setForm(prev => ({ ...prev, [k]: v }));

    const buildConfig = () => ({
        windowStartHour: form.windowStartHour, windowEndHour: form.windowEndHour, dailyCap: form.dailyCap,
        minGapMinutes: form.minGapMinutes, maxGapMinutes: form.maxGapMinutes, longBreakEvery: form.longBreakEvery,
        skipWeekends: form.skipWeekends, skipIfInboundHours: form.skipIfInboundHours,
        variationMode,
        baseMessage: baseMessage.trim() || undefined,
        templates: templates || null,
        imageEnabled,
        audience: { minDaysSinceLastSeen: form.minDaysSinceLastSeen, maxDaysSinceLastSeen: form.maxDaysSinceLastSeen, limit: form.limit, cooldownDays: form.cooldownDays },
    });

    const checkAudience = async () => {
        setBusy(true);
        try {
            const a = buildConfig().audience;
            const r = await api.get('/api/promo/audience', { params: a });
            setAudience(r.data);
        } catch (e) {
            toast.error(e.response?.data?.error || e.message);
        } finally { setBusy(false); }
    };

    const previewTexts = async () => {
        setBusy(true);
        try {
            const r = await api.post('/api/promo/preview', { variationMode, baseMessage: baseMessage.trim() || undefined, templates: templates || null, count: 3 });
            setSamples(r.data);
            if (variationMode === 'ai' && r.data.aiAvailable === false) toast.warning('No hay IA disponible (falta ANTHROPIC_API_KEY): se usarían las plantillas.');
        } catch (e) {
            toast.error(e.response?.data?.error || e.message);
        } finally { setBusy(false); }
    };

    const createCampaign = async () => {
        if (!form.name.trim()) { toast.warning('Ponele un nombre a la campaña'); return; }
        setBusy(true);
        try {
            const r = await api.post('/api/promo/campaigns', { name: form.name.trim(), config: buildConfig() });
            toast.success(`Campaña creada con ${r.data.campaign.stats.total} destinatarios`);
            setShowCreate(false);
            setAudience(null);
            await fetchCampaigns();
            setSelectedId(r.data.campaign.id);
        } catch (e) {
            toast.error(e.response?.data?.error || e.message);
        } finally { setBusy(false); }
    };

    const openEdit = (c) => {
        const cfg = c.config || {};
        setEditingId(c.id);
        setForm({
            name: c.name,
            windowStartHour: cfg.windowStartHour ?? DEFAULT_FORM.windowStartHour,
            windowEndHour: cfg.windowEndHour ?? DEFAULT_FORM.windowEndHour,
            dailyCap: cfg.dailyCap ?? DEFAULT_FORM.dailyCap,
            minGapMinutes: cfg.minGapMinutes ?? DEFAULT_FORM.minGapMinutes,
            maxGapMinutes: cfg.maxGapMinutes ?? DEFAULT_FORM.maxGapMinutes,
            longBreakEvery: cfg.longBreakEvery ?? DEFAULT_FORM.longBreakEvery,
            skipWeekends: !!cfg.skipWeekends,
            skipIfInboundHours: cfg.skipIfInboundHours ?? DEFAULT_FORM.skipIfInboundHours,
            minDaysSinceLastSeen: cfg.audience?.minDaysSinceLastSeen ?? DEFAULT_FORM.minDaysSinceLastSeen,
            maxDaysSinceLastSeen: cfg.audience?.maxDaysSinceLastSeen ?? DEFAULT_FORM.maxDaysSinceLastSeen,
            limit: cfg.audience?.limit ?? DEFAULT_FORM.limit,
            cooldownDays: cfg.audience?.cooldownDays ?? DEFAULT_FORM.cooldownDays,
        });
        setVariationMode(cfg.variationMode === 'templates' ? 'templates' : 'ai');
        setBaseMessage(cfg.baseMessage || '');
        setImageEnabled(cfg.imageEnabled !== false);
        setTemplates(cfg.templates || null);
        setAudience(null);
        setSamples(null);
        setShowCreate(true);
    };

    const startNew = () => {
        setEditingId(null);
        setForm(DEFAULT_FORM);
        setTemplates(null);
        setVariationMode('ai');
        setImageEnabled(true);
        setAudience(null);
        setSamples(null);
        setShowCreate(s => !s);
    };

    const saveEdit = async () => {
        if (!editingId) return;
        setBusy(true);
        try {
            const { audience: _a, ...config } = buildConfig();
            const r = await api.patch(`/api/promo/campaigns/${editingId}`, { name: form.name.trim() || undefined, config });
            toast.success(`Campaña "${r.data.campaign.name}" actualizada`);
            setShowCreate(false);
            setEditingId(null);
            await fetchCampaigns();
            if (selectedId === editingId) await fetchDetail(editingId, recipientFilter);
        } catch (e) {
            toast.error(e.response?.data?.error || e.message);
        } finally { setBusy(false); }
    };

    const act = async (id, action) => {
        setBusy(true);
        try {
            const r = await api.post(`/api/promo/campaigns/${id}/${action}`);
            if (action === 'send-now') {
                toast[r.data.sent ? 'success' : 'warning'](r.data.sent ? 'Enviado' : `No se mandó: ${r.data.reason}`);
            } else {
                toast.success(`Campaña ${STATUS[r.data.campaign.status]?.label.toLowerCase()}`);
            }
            await fetchCampaigns();
            if (selectedId === id) await fetchDetail(id, recipientFilter);
        } catch (e) {
            toast.error(e.response?.data?.error || e.message);
        } finally { setBusy(false); }
    };

    const editTemplate = (key, text) => {
        const lines = text.split('\n---\n');
        setTemplates(prev => ({ ...(prev || {}), [key]: lines }));
    };

    const stats = detail?.campaign?.stats;

    return (
        <div className="p-4 md:p-6 w-full max-w-7xl mx-auto space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-control bg-pink-50 dark:bg-pink-900/30 text-pink-600 dark:text-pink-400 flex items-center justify-center">
                        <Gift className="w-5 h-5" />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Promos</h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                            Le escribe a quien consultó y no compró, de a uno y con pausas al azar.
                            {price60 ? <> Precio promo plan 60: <strong>${price60}</strong>.</> : <> <strong>Falta cargar el precio promo</strong> en el Editor de Precios.</>}
                        </p>
                    </div>
                </div>
                <div className="flex gap-2">
                    <Button variant="secondary" size="sm" leftIcon={RefreshCw} onClick={fetchCampaigns} loading={loading}>Actualizar</Button>
                    <Button size="sm" leftIcon={Plus} onClick={startNew}>Nueva campaña</Button>
                </div>
            </div>

            {showCreate && (
                <Card padding="md">
                    <Card.Header
                        title={editingId ? 'Editar campaña' : 'Nueva campaña'}
                        subtitle={editingId
                            ? 'Los cambios valen desde el próximo envío. La lista de destinatarios no se toca: quedó congelada al crearla.'
                            : 'La lista de destinatarios se congela al crearla y se mezcla al azar.'}
                    />
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
                        <Input label="Nombre" value={form.name} onChange={(e) => setF('name')(e.target.value)} placeholder="Promo 60 días — octubre" />
                        <NumField label="Desde las (hs)" value={form.windowStartHour} onChange={setF('windowStartHour')} min={0} max={23} />
                        <NumField label="Hasta las (hs)" value={form.windowEndHour} onChange={setF('windowEndHour')} min={1} max={24} />
                        <NumField label="Máximo por día" value={form.dailyCap} onChange={setF('dailyCap')} min={1} max={500} hint="Empezá bajo (10-15) en números con poca reputación." />
                        <NumField label="Pausa mínima (min)" value={form.minGapMinutes} onChange={setF('minGapMinutes')} min={1} max={1440} />
                        <NumField label="Pausa máxima (min)" value={form.maxGapMinutes} onChange={setF('maxGapMinutes')} min={1} max={1440} />
                        <NumField label="Corte largo cada N envíos" value={form.longBreakEvery} onChange={setF('longBreakEvery')} min={0} max={1000} hint="0 = nunca. Un corte dura entre 35 y 90 min." />
                        <NumField label="Saltear si escribió hace menos de (hs)" value={form.skipIfInboundHours} onChange={setF('skipIfInboundHours')} min={0} max={720} />
                        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 mt-6">
                            <input type="checkbox" checked={form.skipWeekends} onChange={(e) => setF('skipWeekends')(e.target.checked)} />
                            No mandar los fines de semana
                        </label>
                        <NumField label="Último contacto hace al menos (días)" value={form.minDaysSinceLastSeen} onChange={setF('minDaysSinceLastSeen')} min={0} max={365} disabled={!!editingId} />
                        <NumField label="Último contacto hace como máximo (días)" value={form.maxDaysSinceLastSeen} onChange={setF('maxDaysSinceLastSeen')} min={1} max={3650} disabled={!!editingId} />
                        <NumField label="Tope de destinatarios" value={form.limit} onChange={setF('limit')} min={1} max={20000} disabled={!!editingId} />
                        <NumField label="Sin repetir promo por (días)" value={form.cooldownDays} onChange={setF('cooldownDays')} min={0} max={3650} disabled={!!editingId} />
                    </div>

                    <div className="mt-5">
                        <div className="flex flex-wrap items-center gap-3 mb-2">
                            <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">Mensaje base</label>
                            <div className="flex gap-1.5">
                                {[['ai', 'La IA lo reescribe en cada envío'], ['templates', 'Variantes por bloques']].map(([v, l]) => (
                                    <button key={v} type="button" onClick={() => setVariationMode(v)}
                                        className={cn('text-xs px-2.5 py-1 rounded-full border', variationMode === v ? 'bg-accent-500 text-white border-accent-500' : 'border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300')}>
                                        {l}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <textarea
                            rows={9}
                            className="w-full text-sm rounded-control border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 p-2"
                            value={baseMessage}
                            onChange={(e) => setBaseMessage(e.target.value)}
                            disabled={variationMode !== 'ai'}
                        />
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                            {variationMode === 'ai'
                                ? <>Cada persona recibe una reescritura distinta de este texto, hecha por la IA: cambia palabras, orden y emojis, pero mantiene el precio, las condiciones y la palabra PROMO. <code>{'{{PROMO_60}}'}</code> es el precio promo y <code>{'{{NAME_COMMA}}'}</code> el nombre si lo tenemos. Si la IA falla en un envío, sale una variante por bloques.</>
                                : <>Se arma el texto combinando las variantes por bloques de abajo (sin IA).</>}
                        </p>
                    </div>

                    <div className="mt-4 flex items-start gap-3">
                        <PromoImageThumb />
                        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 mt-1">
                            <input type="checkbox" checked={imageEnabled} onChange={(e) => setImageEnabled(e.target.checked)} />
                            Adjuntar el flyer de la promo (sale unos segundos después del texto)
                        </label>
                    </div>

                    <button type="button" onClick={() => setShowTemplates(s => !s)} className="mt-4 text-sm font-medium text-accent-600 dark:text-accent-400 flex items-center gap-1">
                        {showTemplates ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />} Variantes por bloques{variationMode === 'ai' ? ' (respaldo si la IA falla)' : ''} — una por línea, separadas con <code>---</code>
                    </button>
                    {showTemplates && (
                        <div className="mt-3 space-y-3">
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                Dejá un bloque vacío para usar las variantes por defecto. Podés usar <code>{'{{NAME_COMMA}}'}</code> (", Nombre"), <code>{'{{PROMO_60}}'}</code> (precio promo) y <code>{'{a|b|c}'}</code> para alternar palabras.
                                No prometas nada que la operación no cumpla: a domicilio va prepago, el pago al recibir es retirando en el Correo.
                            </p>
                            {TEMPLATE_BLOCKS.map(([key, label]) => (
                                <div key={key}>
                                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">{label}</label>
                                    <textarea
                                        rows={3}
                                        className="w-full text-sm rounded-control border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 p-2"
                                        placeholder="(variantes por defecto)"
                                        value={(templates?.[key] || []).join('\n---\n')}
                                        onChange={(e) => editTemplate(key, e.target.value)}
                                    />
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="flex flex-wrap gap-2 mt-4">
                        {!editingId && <Button variant="secondary" leftIcon={Users} onClick={checkAudience} loading={busy}>Medir audiencia</Button>}
                        <Button variant="secondary" leftIcon={Eye} onClick={previewTexts} loading={busy}>Ver textos de muestra</Button>
                        {editingId
                            ? <>
                                <Button leftIcon={Pencil} onClick={saveEdit} loading={busy}>Guardar cambios</Button>
                                <Button variant="ghost" onClick={() => { setEditingId(null); setShowCreate(false); }} disabled={busy}>Cancelar</Button>
                            </>
                            : <Button leftIcon={Gift} onClick={createCampaign} loading={busy} disabled={!price60}>Crear campaña</Button>}
                    </div>

                    {audience && (
                        <div className="mt-4 text-sm text-slate-700 dark:text-slate-300">
                            <p><strong>{audience.summary.total}</strong> personas recibirían la promo.</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                                Por paso en que quedaron: {Object.entries(audience.summary.byStep).map(([s, n]) => `${s} (${n})`).join(' · ') || '—'}
                            </p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                Quedan afuera: {Object.entries(audience.summary.excluded).map(([s, n]) => `${s.replace(/_/g, ' ')} (${n})`).join(' · ') || '—'}
                            </p>
                        </div>
                    )}
                    {samples && (
                        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                            <p className="md:col-span-2 text-xs text-slate-500 dark:text-slate-400">
                                {samples.mode === 'ai'
                                    ? 'Reescrituras de la IA del mensaje base. Cada envío genera una nueva.'
                                    : `${samples.combinations.toLocaleString('es-AR')} combinaciones posibles. Cada persona recibe una distinta.`}
                            </p>
                            {samples.samples.map((t, i) => (
                                <div key={i} className="p-3 rounded-control bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
                                    <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">{samples.via?.[i] === 'ai' ? 'IA' : 'plantilla'}</div>
                                    <pre className="whitespace-pre-wrap text-xs font-sans text-slate-800 dark:text-slate-200">{t}</pre>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            )}

            {campaigns.length === 0 && !showCreate ? (
                <EmptyState icon={Gift} title="Todavía no hay campañas" description="Creá una para empezar a escribirle a quien consultó y no compró." />
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <div className="space-y-3">
                        {campaigns.map(c => (
                            <Card key={c.id} padding="md" interactive className={cn(selectedId === c.id && 'ring-2 ring-accent-500')} onClick={() => setSelectedId(c.id)}>
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <h3 className="font-semibold text-sm text-slate-900 dark:text-slate-100 truncate">{c.name}</h3>
                                        <p className="text-xs text-slate-500 dark:text-slate-400">
                                            {c.stats.sent}/{c.stats.total} enviados · {c.stats.replied} respondieron · {c.stats.converted} compraron
                                        </p>
                                        {c.status === 'running' && <p className="text-[11px] text-slate-400 mt-1">Hoy {c.sentToday}/{c.config.dailyCap} · próximo {fmtTime(c.nextSendAt)}</p>}
                                    </div>
                                    <Badge tone={STATUS[c.status]?.tone || 'neutral'} size="sm">{STATUS[c.status]?.label || c.status}</Badge>
                                </div>
                                <div className="flex flex-wrap gap-1.5 mt-3" onClick={(e) => e.stopPropagation()}>
                                    {(c.status === 'draft' || c.status === 'paused') && <Button size="sm" leftIcon={Play} onClick={() => act(c.id, c.status === 'draft' ? 'start' : 'resume')} loading={busy}>{c.status === 'draft' ? 'Iniciar' : 'Reanudar'}</Button>}
                                    {c.status === 'running' && <Button size="sm" variant="secondary" leftIcon={Pause} onClick={() => act(c.id, 'pause')} loading={busy}>Pausar</Button>}
                                    {!['finished', 'cancelled'].includes(c.status) && <Button size="sm" variant="ghost" leftIcon={Pencil} onClick={() => openEdit(c)} disabled={busy}>Editar</Button>}
                                    {c.status === 'running' && <Button size="sm" variant="ghost" leftIcon={Send} onClick={() => act(c.id, 'send-now')} loading={busy}>Mandar ahora</Button>}
                                    {!['finished', 'cancelled'].includes(c.status) && <Button size="sm" variant="danger" leftIcon={Square} onClick={() => { if (window.confirm('¿Cancelar la campaña? Los que no recibieron la promo quedan sin recibirla.')) act(c.id, 'cancel'); }} loading={busy}>Cancelar</Button>}
                                </div>
                            </Card>
                        ))}
                    </div>

                    <div className="lg:col-span-2 space-y-4">
                        {!detail ? (
                            <EmptyState icon={MessageCircle} title="Elegí una campaña" description="A la izquierda. Acá vas a ver cómo va y quién respondió." />
                        ) : (
                            <>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                    <KpiCard label="Enviados" value={`${stats.sent}/${stats.total}`} subtext={`${stats.pending} pendientes · ${stats.skipped} salteados`} tone="info" />
                                    <KpiCard label="Respondieron" value={stats.replied} subtext={stats.sent ? `${Math.round(stats.replied / stats.sent * 100)}% de los enviados` : '—'} tone="purple" />
                                    <KpiCard label="Interesados" value={stats.interested} subtext={`${stats.declined} no les interesó · ${stats.optedOut} pidieron no recibir`} tone="success" />
                                    <KpiCard label="Compraron" value={stats.converted} subtext={stats.sent ? `${(stats.converted / stats.sent * 100).toFixed(1)}% de los enviados` : '—'} tone="accent" />
                                </div>

                                <Card padding="md">
                                    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                                        <h3 className="font-semibold text-sm text-slate-900 dark:text-slate-100">Destinatarios</h3>
                                        <div className="flex gap-1.5 flex-wrap">
                                            {[['', 'Todos'], ['sent', 'Enviados'], ['pending', 'Pendientes'], ['skipped', 'Salteados'], ['failed', 'Fallidos'], ['opted_out', 'No quieren']].map(([v, l]) => (
                                                <button key={v} type="button" onClick={() => setRecipientFilter(v)}
                                                    className={cn('text-xs px-2.5 py-1 rounded-full border', recipientFilter === v ? 'bg-accent-500 text-white border-accent-500' : 'border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300')}>
                                                    {l}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    {detail.recipients.length === 0 ? (
                                        <p className="text-sm text-slate-500 dark:text-slate-400">Nada por acá.</p>
                                    ) : (
                                        <div className="overflow-x-auto">
                                            <table className="w-full text-sm">
                                                <thead className="text-xs text-slate-500 dark:text-slate-400 text-left">
                                                    <tr><th className="py-1 pr-3">Teléfono</th><th className="py-1 pr-3">Estado</th><th className="py-1 pr-3">Enviado</th><th className="py-1 pr-3">Respuesta</th><th className="py-1"></th></tr>
                                                </thead>
                                                <tbody>
                                                    {detail.recipients.map(r => (
                                                        <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                                                            <td className="py-1.5 pr-3 font-mono text-xs">{r.phone}</td>
                                                            <td className="py-1.5 pr-3">
                                                                <Badge tone={RECIPIENT_STATUS[r.status]?.tone || 'neutral'} size="sm">{RECIPIENT_STATUS[r.status]?.label || r.status}</Badge>
                                                                {r.skipReason && <span className="ml-1 text-[11px] text-slate-400">{SKIP_REASONS[r.skipReason] || r.skipReason}</span>}
                                                            </td>
                                                            <td className="py-1.5 pr-3 text-xs text-slate-500">{fmtTime(r.sentAt)}</td>
                                                            <td className="py-1.5 pr-3">{r.outcome ? <Badge tone={OUTCOME[r.outcome]?.tone || 'neutral'} size="sm">{OUTCOME[r.outcome]?.label || r.outcome}</Badge> : <span className="text-xs text-slate-400">{r.repliedAt ? 'respondió' : '—'}</span>}</td>
                                                            <td className="py-1.5 text-right">
                                                                {r.status !== 'pending' && onGoToChat && (
                                                                    <Button size="sm" variant="ghost" leftIcon={MessageCircle} onClick={() => onGoToChat(`${r.phone}@c.us`)}>Chat</Button>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </Card>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default PromoView;
