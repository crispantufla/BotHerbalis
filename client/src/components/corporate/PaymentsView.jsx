import React, { useState, useEffect, useCallback } from 'react';
import {
    CreditCard, RefreshCw, Copy, Check, ExternalLink, MessageCircle, AlertCircle, User, Smartphone
} from 'lucide-react';
import api from '../../config/axios';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';
import { useSeller } from '../../context/SellerContext';
import { capitalize } from '../../utils/format';
import {
    Card, Button, IconButton, Badge, Input, EmptyState, useToast, cn
} from '../ui';

const STATUS_TONE = {
    pending:  { tone: 'warning', label: 'Pendiente' },
    approved: { tone: 'success', label: 'Aprobado' },
    rejected: { tone: 'danger',  label: 'Rechazado' },
    expired:  { tone: 'neutral', label: 'Expirado' },
};

const SOURCE_TONE = {
    dashboard: { tone: 'accent',  label: 'Dashboard' },
    whatsapp:  { tone: 'success', label: 'WhatsApp' },
};

const FILTERS = [
    { key: 'all',      label: 'Todos' },
    { key: 'pending',  label: 'Pendientes' },
    { key: 'approved', label: 'Aprobados' },
    { key: 'rejected', label: 'Rechazados' },
    { key: 'expired',  label: 'Expirados' },
];

// Período sobre la fecha de creación del enlace (`createdAt`, la misma que
// muestra "hace 13d"). Se filtra en el cliente: nada se borra ni se archiva.
const PERIODS = [
    { key: '7',   label: '7 días',  days: 7,    title: 'Últimos 7 días',  empty: 'en los últimos 7 días' },
    { key: '30',  label: '30 días', days: 30,   title: 'Últimos 30 días', empty: 'en los últimos 30 días' },
    { key: 'all', label: 'Todo',    days: null, title: 'Todos los enlaces', empty: '' },
];
const PERIOD_STORAGE_KEY = 'payments.period';
const readStoredPeriod = () => {
    try {
        const v = localStorage.getItem(PERIOD_STORAGE_KEY);
        return PERIODS.some(p => p.key === v) ? v : '7';
    } catch { return '7'; }
};
const filterByDays = (list, days) => {
    if (!days) return list;
    const cutoff = Date.now() - days * 86400000;
    return list.filter(p => new Date(p.createdAt).getTime() >= cutoff);
};

const timeAgo = (dateStr) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return `hace ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h}h`;
    return `hace ${Math.floor(h / 24)}d`;
};

const formatArs = (amount) =>
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(amount);

const formatPhone = (phone) =>
    phone ? phone.replace('@c.us', '').replace('@s.whatsapp.net', '') : null;

function PaymentRow({ payment, onRefresh, onGoToChat, refreshing, sellerName, showSeller }) {
    const [copied, setCopied] = useState(false);
    const st = STATUS_TONE[payment.status] || STATUS_TONE.pending;
    const src = SOURCE_TONE[payment.source] || SOURCE_TONE.dashboard;
    const clientPhone = formatPhone(payment.userPhone);
    // Con un solo vendedor, su nombre y su número se repiten en cada pago.
    const sellerPhone = showSeller ? formatPhone(payment.sellerPhone) : null;

    const handleCopy = () => {
        navigator.clipboard.writeText(payment.link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <Card padding="md" interactive className="flex flex-col sm:flex-row sm:items-center gap-3">
            {/* Amount + tiempo */}
            <div className="flex items-center gap-3 min-w-[140px]">
                <div className="w-10 h-10 rounded-control bg-info-50 dark:bg-info-900/30 text-info-600 dark:text-info-500 flex items-center justify-center flex-shrink-0">
                    <CreditCard className="w-5 h-5" aria-hidden="true" />
                </div>
                <div>
                    <p className="font-semibold text-slate-900 dark:text-slate-100 text-sm leading-none tabular-nums">
                        {formatArs(payment.amount)}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{timeAgo(payment.createdAt)}</p>
                </div>
            </div>

            {/* Badges informativos */}
            <div className="flex flex-wrap gap-1.5 flex-1">
                <Badge tone={st.tone} dot size="md">{st.label}</Badge>
                <Badge tone={src.tone} size="md">{src.label}</Badge>
                {sellerName && (
                    <Badge tone="info" size="md">
                        <User className="w-3 h-3" />
                        {sellerName}
                    </Badge>
                )}
                {sellerPhone && (
                    <Badge tone="neutral" size="md">
                        <Smartphone className="w-3 h-3" />
                        {sellerPhone}
                    </Badge>
                )}
                {clientPhone && (
                    <Badge tone="purple" size="md">
                        <User className="w-3 h-3" />
                        {clientPhone}
                    </Badge>
                )}
                {payment.paidAt && (
                    <Badge tone="success" size="md">
                        <Check className="w-3 h-3" />
                        {new Date(payment.paidAt).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </Badge>
                )}
            </div>

            {/* Acciones */}
            <div className="flex items-center gap-1 flex-shrink-0">
                <IconButton
                    label="Copiar enlace"
                    icon={copied ? Check : Copy}
                    variant="ghost"
                    size="sm"
                    onClick={handleCopy}
                    className={copied ? '!bg-success-50 dark:!bg-success-900/30 !text-success-600 dark:!text-success-500' : ''}
                />
                <a
                    href={payment.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Abrir en MercadoPago"
                    title="Abrir en MercadoPago"
                    className="inline-flex items-center justify-center w-8 h-8 rounded-control text-slate-500 dark:text-slate-400 hover:bg-accent-50 dark:hover:bg-accent-900/30 hover:text-accent-600 dark:hover:text-accent-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                    <ExternalLink className="w-4 h-4" />
                </a>
                {clientPhone && (
                    <IconButton
                        label="Ir al chat del cliente"
                        icon={MessageCircle}
                        variant="ghost"
                        size="sm"
                        onClick={() => onGoToChat(payment.userPhone)}
                    />
                )}
                <IconButton
                    label="Actualizar estado desde MercadoPago"
                    icon={RefreshCw}
                    variant="ghost"
                    size="sm"
                    onClick={() => onRefresh(payment.id)}
                    disabled={refreshing === payment.id}
                    className={refreshing === payment.id ? '[&_svg]:animate-spin' : ''}
                />
            </div>
        </Card>
    );
}

const PaymentsView = ({ onGoToChat }) => {
    const { toast } = useToast();
    const { socket } = useSocket();
    const { isAdmin } = useAuth();
    const { sellers } = useSeller();
    // `payments`: los últimos enlaces sin filtrar por estado (el backend devuelve
    // hasta 200). De acá salen las tarjetas, los contadores y la lista.
    const [payments, setPayments] = useState([]);
    // `statusExtra`: lo que devuelve el backend para el estado elegido. Completa
    // la lista cuando hay más de 200 enlaces y los de ese estado quedaron fuera.
    const [statusExtra, setStatusExtra] = useState({ status: null, list: [] });
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(null);
    const [refreshingAll, setRefreshingAll] = useState(false);
    const [filter, setFilter] = useState('all');
    const [period, setPeriodState] = useState(readStoredPeriod);
    // Filtro por vendedor (solo admin global). 'all' = agregado.
    const [sellerFilter, setSellerFilter] = useState('all');

    // Con un solo vendedor no hay nada que elegir ni que distinguir: las
    // pestañas y el chip de vendedor aparecen con 2 o más.
    const multiSeller = (sellers || []).length > 1;

    // Map instanceId → seller name (admin badge)
    const sellerIdToName = Object.fromEntries((sellers || []).map(s => [s.sellerId, capitalize(s.name)]));

    const [mpAmount, setMpAmount] = useState('');
    const [mpUserPhone, setMpUserPhone] = useState('');
    const [mpLoading, setMpLoading] = useState(false);

    const setPeriod = (key) => {
        setPeriodState(key);
        try { localStorage.setItem(PERIOD_STORAGE_KEY, key); } catch { /* sin almacenamiento: no se recuerda */ }
    };

    // Admin con filtro 'all' ve todos los pagos (header vacío); con un seller
    // específico, manda ese instanceId. Sellers no-admin van scoped server-side
    // por su JWT.
    const sellerHeaders = useCallback(
        (sf) => (isAdmin ? { 'x-seller-id': sf === 'all' ? '' : sf } : {}),
        [isAdmin]
    );

    const fetchPayments = useCallback(async (sf = sellerFilter) => {
        try {
            const res = await api.get('/api/payments', { headers: sellerHeaders(sf) });
            setPayments(res.data.payments || []);
        } catch {
            toast.error('Error cargando pagos');
        } finally {
            setLoading(false);
        }
    }, [sellerFilter, sellerHeaders, toast]);

    // La lista ya se filtra en el cliente; esto solo trae lo que el tope de 200
    // pudo haber dejado afuera. Si falla, queda lo que ya se ve.
    const fetchStatusExtra = useCallback(async (f, sf = sellerFilter) => {
        if (f === 'all') { setStatusExtra({ status: null, list: [] }); return; }
        try {
            const res = await api.get(`/api/payments?status=${f}`, { headers: sellerHeaders(sf) });
            setStatusExtra({ status: f, list: res.data.payments || [] });
        } catch { /* la lista del cliente sigue valiendo */ }
    }, [sellerFilter, sellerHeaders]);

    useEffect(() => { fetchPayments(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- solo al montar: los filtros llaman a fetchPayments
    // Recargar al cambiar filtro de vendedor.
    useEffect(() => {
        if (!isAdmin) return;
        setLoading(true);
        fetchPayments(sellerFilter);
        fetchStatusExtra(filter, sellerFilter);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sellerFilter]);

    const patchPayment = useCallback((p) => {
        setPayments(prev => prev.map(x => x.id === p.id ? p : x));
        setStatusExtra(prev => ({ ...prev, list: prev.list.map(x => x.id === p.id ? p : x) }));
    }, []);

    // Real-time updates
    useEffect(() => {
        if (!socket) return;
        const onCreated = (p) => setPayments(prev => [p, ...prev]);
        socket.on('payment_created', onCreated);
        socket.on('payment_updated', patchPayment);
        return () => { socket.off('payment_created', onCreated); socket.off('payment_updated', patchPayment); };
    }, [socket, patchPayment]);

    const handleFilter = (f) => {
        setFilter(f);
        fetchStatusExtra(f, sellerFilter);
    };

    const handleRefresh = async (id) => {
        setRefreshing(id);
        try {
            const res = await api.post(`/api/payments/${id}/refresh`);
            if (res.data.payment) patchPayment(res.data.payment);
            if (res.data.changed) toast.success('Estado actualizado');
            else toast.info(res.data.message || 'Sin cambios');
        } catch { toast.error('Error consultando estado en MP'); }
        finally { setRefreshing(null); }
    };

    const periodMeta = PERIODS.find(p => p.key === period) || PERIODS[0];
    // Todo lo que se ve (tarjetas, contadores, lista) sale del período elegido.
    const inPeriod = filterByDays(payments, periodMeta.days);

    // Lista del estado elegido, de cualquier fecha: lo cargado + lo que trajo el
    // backend para ese estado, sin repetir y con lo más nuevo arriba.
    const byStatus = (() => {
        if (filter === 'all') return payments;
        const seen = new Set(payments.map(p => p.id));
        const extra = statusExtra.status === filter ? statusExtra.list.filter(p => !seen.has(p.id)) : [];
        return [...payments, ...extra]
            .filter(p => p.status === filter)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    })();
    const visible = filterByDays(byStatus, periodMeta.days);

    // Refresca en paralelo SOLO los pendientes del período visible y muestra UN
    // solo toast resumen. Antes pegaba un POST por cada pendiente de la historia
    // (164 en prod, la mayoría de hace meses) y, más atrás, un toast por error.
    const handleRefreshAll = async () => {
        if (refreshingAll) return;
        const pending = inPeriod.filter(p => p.status === 'pending');
        if (pending.length === 0) {
            toast.info(periodMeta.days ? `No hay pagos pendientes ${periodMeta.empty}` : 'No hay pagos pendientes');
            return;
        }

        setRefreshingAll(true);
        let updated = 0, unchanged = 0, errors = 0;
        const results = await Promise.allSettled(
            pending.map(p => api.post(`/api/payments/${p.id}/refresh`).then(res => ({ id: p.id, ...res.data })))
        );

        const updates = new Map();
        results.forEach((r, idx) => {
            if (r.status === 'fulfilled') {
                if (r.value.changed) updated++; else unchanged++;
                if (r.value.payment) updates.set(pending[idx].id, r.value.payment);
            } else {
                errors++;
            }
        });

        if (updates.size > 0) {
            setPayments(prev => prev.map(x => updates.get(x.id) || x));
            setStatusExtra(prev => ({ ...prev, list: prev.list.map(x => updates.get(x.id) || x) }));
        }
        setRefreshingAll(false);

        const parts = [];
        if (updated > 0) parts.push(`${updated} actualizados`);
        if (unchanged > 0) parts.push(`${unchanged} sin cambios`);
        if (errors > 0) parts.push(`${errors} con error`);
        const msg = `${pending.length} pagos: ${parts.join(' · ')}`;

        if (errors > 0 && updated === 0) toast.error(msg);
        else if (updated > 0) toast.success(msg);
        else toast.info(msg);
    };

    const handleGenerateLink = async () => {
        const amount = parseFloat(mpAmount.replace(',', '.'));
        if (!amount || amount <= 0) { toast.warning('Ingresá un monto válido'); return; }
        setMpLoading(true);
        try {
            const body = { amount };
            const cleaned = mpUserPhone.replace(/\D/g, '');
            if (cleaned.length >= 8) body.userPhone = `${cleaned}@c.us`;
            const res = await api.post('/api/mp-link', body);
            navigator.clipboard.writeText(res.data.link).catch(() => {});
            toast.success('Enlace generado y copiado');
            setMpAmount('');
            setMpUserPhone('');
        } catch (e) {
            toast.error(e.response?.data?.error || 'Error generando enlace');
        } finally {
            setMpLoading(false);
        }
    };

    const pendingCount = inPeriod.filter(p => p.status === 'pending').length;
    const approvedCount = inPeriod.filter(p => p.status === 'approved').length;
    const totalApproved = inPeriod.filter(p => p.status === 'approved').reduce((s, p) => s + p.amount, 0);

    // Estado vacío: si el período no deja nada pero hay pagos más viejos, lo
    // dice y ofrece ampliar.
    const filterLabel = filter !== 'all' ? ` "${FILTERS.find(f => f.key === filter)?.label}"` : '';
    const olderCount = byStatus.length - visible.length;
    const in30Count = period === '7' ? filterByDays(byStatus, 30).length : 0;

    return (
        <div className="space-y-4 animate-fade-in motion-reduce:animate-none">
            <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                    <h1 className="text-display text-slate-900 dark:text-slate-100">Administrador de pagos</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        MercadoPago · {periodMeta.title}
                    </p>
                </div>
                <Button variant="secondary" leftIcon={RefreshCw} onClick={handleRefreshAll} loading={refreshingAll}>
                    Refrescar pendientes
                </Button>
            </header>

            {/* Filtro por vendedor (admin global, solo con 2 o más vendedores) */}
            {isAdmin && multiSeller && (
                <div className="flex p-1 rounded-control bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 overflow-x-auto">
                    <button
                        type="button"
                        onClick={() => setSellerFilter('all')}
                        className={cn(
                            'flex-shrink-0 px-3 py-1.5 rounded-[0.5rem] text-sm font-medium transition-colors',
                            sellerFilter === 'all'
                                ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300'
                                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                        )}
                    >
                        Todos
                    </button>
                    {sellers.map(s => (
                        <button
                            key={s.sellerId}
                            type="button"
                            onClick={() => setSellerFilter(s.sellerId)}
                            className={cn(
                                'flex-shrink-0 px-3 py-1.5 rounded-[0.5rem] text-sm font-medium transition-colors whitespace-nowrap',
                                sellerFilter === s.sellerId
                                    ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300'
                                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                            )}
                        >
                            {capitalize(s.name)}
                        </button>
                    ))}
                </div>
            )}

            {/* Stats row — tipografía agrandada (3xl-4xl) y padding lg para que las
                tarjetas se sientan presentes en pantalla. Antes con text-xl + p-md
                quedaban como "captions". */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <Card padding="lg" className="text-center">
                    <p className="text-3xl sm:text-4xl font-semibold tabular-nums text-warning-600 dark:text-warning-500 leading-none">{pendingCount}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 font-medium">Pendientes</p>
                </Card>
                <Card padding="lg" className="text-center">
                    <p className="text-3xl sm:text-4xl font-semibold tabular-nums text-success-600 dark:text-success-500 leading-none">{approvedCount}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 font-medium">Aprobados</p>
                </Card>
                <Card padding="lg" className="text-center col-span-2 md:col-span-1">
                    <p className="text-2xl sm:text-3xl font-semibold tabular-nums text-info-600 dark:text-info-500 leading-none">{formatArs(totalApproved)}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 font-medium">Cobrado</p>
                </Card>
            </div>

            {/* Generate link */}
            <Card padding="md">
                <div className="flex items-center gap-2 mb-3">
                    <div className="w-8 h-8 rounded-control bg-info-50 dark:bg-info-900/30 text-info-600 dark:text-info-500 flex items-center justify-center flex-shrink-0">
                        <CreditCard className="w-4 h-4" aria-hidden="true" />
                    </div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        Generar nuevo enlace de pago
                    </h3>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                    <div className="sm:w-40">
                        <Input
                            type="number"
                            min="1"
                            placeholder="Monto"
                            value={mpAmount}
                            onChange={e => setMpAmount(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleGenerateLink()}
                            aria-label="Monto en pesos"
                            leftIcon={() => <span className="text-slate-500 dark:text-slate-400 font-medium">$</span>}
                        />
                    </div>
                    <div className="flex-1">
                        <Input
                            type="text"
                            placeholder="Teléfono cliente (opcional)"
                            value={mpUserPhone}
                            onChange={e => setMpUserPhone(e.target.value)}
                            aria-label="Teléfono del cliente"
                        />
                    </div>
                    <Button
                        onClick={handleGenerateLink}
                        loading={mpLoading}
                        disabled={!mpAmount}
                        leftIcon={CreditCard}
                        className="flex-shrink-0"
                    >
                        Generar y copiar
                    </Button>
                </div>
            </Card>

            {/* Filtros: estado + período */}
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Filtrar por estado">
                {FILTERS.map(f => (
                    <button
                        key={f.key}
                        type="button"
                        onClick={() => handleFilter(f.key)}
                        aria-pressed={filter === f.key}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-3 h-10 md:h-8 rounded-control text-xs font-semibold transition-colors',
                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                            filter === f.key
                                ? 'bg-accent-600 text-white'
                                : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'
                        )}
                    >
                        {f.label}
                        {f.key === 'pending' && pendingCount > 0 && (
                            <span className={cn(
                                'inline-flex items-center justify-center rounded-full text-[11px] font-semibold tabular-nums px-1.5 min-w-[1.25rem] h-4',
                                filter === f.key ? 'bg-white/25 text-white' : 'bg-warning-100 text-warning-900'
                            )}>
                                {pendingCount}
                            </span>
                        )}
                    </button>
                ))}
            </div>
            <div
                role="group"
                aria-label="Período"
                className="inline-flex p-1 rounded-control bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            >
                {PERIODS.map(p => (
                    <button
                        key={p.key}
                        type="button"
                        onClick={() => setPeriod(p.key)}
                        aria-pressed={period === p.key}
                        className={cn(
                            'px-3 h-10 md:h-7 rounded-[0.5rem] text-xs font-semibold whitespace-nowrap transition-colors',
                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                            period === p.key
                                ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300'
                                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                        )}
                    >
                        {p.label}
                    </button>
                ))}
            </div>
            </div>

            {/* Lista */}
            {loading ? (
                <Card padding="lg" className="flex items-center justify-center gap-3">
                    <RefreshCw className="w-5 h-5 animate-spin text-accent-600 dark:text-accent-400" aria-hidden="true" />
                    <span className="text-sm text-slate-500 dark:text-slate-400">Cargando pagos…</span>
                </Card>
            ) : visible.length === 0 ? (
                <Card padding="lg">
                    {olderCount > 0 ? (
                        <EmptyState
                            icon={AlertCircle}
                            title={`No hay pagos${filterLabel} ${periodMeta.empty}`}
                            description={olderCount === 1 ? 'Hay 1 pago más viejo.' : `Hay ${olderCount} pagos más viejos.`}
                            action={
                                <div className="flex flex-wrap justify-center gap-2">
                                    {in30Count > 0 && (
                                        <Button variant="secondary" onClick={() => setPeriod('30')}>Ver 30 días</Button>
                                    )}
                                    <Button variant={in30Count > 0 ? 'ghost' : 'secondary'} onClick={() => setPeriod('all')}>Ver todo</Button>
                                </div>
                            }
                        />
                    ) : (
                        <EmptyState
                            icon={AlertCircle}
                            title={`No hay pagos${filterLabel}`}
                            description="Los enlaces generados aparecerán acá automáticamente."
                        />
                    )}
                </Card>
            ) : (
                <div className="space-y-2">
                    {visible.map(p => (
                        <PaymentRow
                            key={p.id}
                            payment={p}
                            onRefresh={handleRefresh}
                            onGoToChat={onGoToChat}
                            refreshing={refreshing}
                            showSeller={multiSeller}
                            sellerName={isAdmin && multiSeller ? (sellerIdToName[p.instanceId] || null) : null}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

export default PaymentsView;
