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

function PaymentRow({ payment, onRefresh, onGoToChat, refreshing, sellerName }) {
    const [copied, setCopied] = useState(false);
    const st = STATUS_TONE[payment.status] || STATUS_TONE.pending;
    const src = SOURCE_TONE[payment.source] || SOURCE_TONE.dashboard;
    const clientPhone = formatPhone(payment.userPhone);
    const sellerPhone = formatPhone(payment.sellerPhone);

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
    const [payments, setPayments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(null);
    const [filter, setFilter] = useState('all');

    // Map instanceId → seller name (admin badge)
    const sellerIdToName = Object.fromEntries((sellers || []).map(s => [s.sellerId, capitalize(s.name)]));

    const [mpAmount, setMpAmount] = useState('');
    const [mpUserPhone, setMpUserPhone] = useState('');
    const [mpLoading, setMpLoading] = useState(false);

    const fetchPayments = useCallback(async (f = filter) => {
        try {
            const params = f !== 'all' ? `?status=${f}` : '';
            const headers = isAdmin ? { 'x-seller-id': '' } : {};
            const res = await api.get(`/api/payments${params}`, { headers });
            setPayments(res.data.payments || []);
        } catch {
            toast.error('Error cargando pagos');
        } finally {
            setLoading(false);
        }
    }, [filter, isAdmin]);

    useEffect(() => { fetchPayments(); }, []);

    // Real-time updates
    useEffect(() => {
        if (!socket) return;
        const onCreated = (p) => setPayments(prev => [p, ...prev]);
        const onUpdated = (p) => setPayments(prev => prev.map(x => x.id === p.id ? p : x));
        socket.on('payment_created', onCreated);
        socket.on('payment_updated', onUpdated);
        return () => { socket.off('payment_created', onCreated); socket.off('payment_updated', onUpdated); };
    }, [socket]);

    const handleFilter = (f) => {
        setFilter(f);
        setLoading(true);
        fetchPayments(f);
    };

    const handleRefresh = async (id) => {
        setRefreshing(id);
        try {
            const res = await api.post(`/api/payments/${id}/refresh`);
            setPayments(prev => prev.map(x => x.id === id ? res.data.payment : x));
            if (res.data.changed) toast.success('Estado actualizado');
            else toast.info(res.data.message || 'Sin cambios');
        } catch { toast.error('Error consultando estado en MP'); }
        finally { setRefreshing(null); }
    };

    // Refresca todos los pendientes en paralelo y muestra UN solo toast resumen.
    // Antes llamaba a handleRefresh por cada uno y el toast de error individual
    // se acumulaba (11 errores = 11 toasts).
    const handleRefreshAll = async () => {
        const pending = payments.filter(p => p.status === 'pending');
        if (pending.length === 0) { toast.info('No hay pagos pendientes'); return; }

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
        }

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

    const pendingCount = payments.filter(p => p.status === 'pending').length;
    const approvedCount = payments.filter(p => p.status === 'approved').length;
    const totalApproved = payments.filter(p => p.status === 'approved').reduce((s, p) => s + p.amount, 0);

    return (
        <div className="space-y-4 animate-fade-in">
            <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                    <h1 className="text-display text-slate-900 dark:text-slate-100">Administrador de pagos</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        MercadoPago · enlaces de pago con estado en tiempo real.
                    </p>
                </div>
                <Button variant="secondary" leftIcon={RefreshCw} onClick={handleRefreshAll}>
                    Refrescar pendientes
                </Button>
            </header>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3">
                <Card padding="md" className="text-center">
                    <p className="text-xl font-semibold tabular-nums text-warning-600 dark:text-warning-500">{pendingCount}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Pendientes</p>
                </Card>
                <Card padding="md" className="text-center">
                    <p className="text-xl font-semibold tabular-nums text-success-600 dark:text-success-500">{approvedCount}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Aprobados</p>
                </Card>
                <Card padding="md" className="text-center">
                    <p className="text-xl font-semibold tabular-nums text-info-600 dark:text-info-500">{formatArs(totalApproved)}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Cobrado</p>
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
                            leftIcon={() => <span className="text-slate-400 font-medium">$</span>}
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

            {/* Filter tabs */}
            <div className="flex gap-1.5 flex-wrap">
                {FILTERS.map(f => (
                    <button
                        key={f.key}
                        type="button"
                        onClick={() => handleFilter(f.key)}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-3 h-8 rounded-control text-xs font-semibold transition-colors',
                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                            filter === f.key
                                ? 'bg-accent-600 text-white'
                                : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'
                        )}
                    >
                        {f.label}
                        {f.key === 'pending' && pendingCount > 0 && (
                            <span className={cn(
                                'inline-flex items-center justify-center rounded-full text-[10px] font-semibold tabular-nums px-1.5 min-w-[1.25rem] h-4',
                                filter === f.key ? 'bg-white/25 text-white' : 'bg-warning-500 text-white'
                            )}>
                                {pendingCount}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* Lista */}
            {loading ? (
                <Card padding="lg" className="flex items-center justify-center gap-3">
                    <RefreshCw className="w-5 h-5 animate-spin text-accent-600 dark:text-accent-400" aria-hidden="true" />
                    <span className="text-sm text-slate-500 dark:text-slate-400">Cargando pagos…</span>
                </Card>
            ) : payments.length === 0 ? (
                <Card padding="lg">
                    <EmptyState
                        icon={AlertCircle}
                        title={`No hay pagos${filter !== 'all' ? ` "${FILTERS.find(f => f.key === filter)?.label}"` : ''}`}
                        description="Los enlaces generados aparecerán acá automáticamente."
                    />
                </Card>
            ) : (
                <div className="space-y-2">
                    {payments.map(p => (
                        <PaymentRow
                            key={p.id}
                            payment={p}
                            onRefresh={handleRefresh}
                            onGoToChat={onGoToChat}
                            refreshing={refreshing}
                            sellerName={isAdmin ? (sellerIdToName[p.instanceId] || null) : null}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

export default PaymentsView;
