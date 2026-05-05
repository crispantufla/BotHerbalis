import React, { useState, useEffect, useCallback } from 'react';
import { CreditCard, RefreshCw, Copy, Check, ExternalLink, MessageCircle, AlertCircle, User } from 'lucide-react';
import api from '../../config/axios';
import { useSocket } from '../../context/SocketContext';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../context/AuthContext';
import { useSeller } from '../../context/SellerContext';
import { capitalize } from '../../utils/format';

const STATUS_CONFIG = {
    pending:  { label: 'Pendiente',  bg: 'bg-amber-100 dark:bg-amber-900/30',  text: 'text-amber-700 dark:text-amber-400',  dot: 'bg-amber-500' },
    approved: { label: 'Aprobado',   bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' },
    rejected: { label: 'Rechazado',  bg: 'bg-rose-100 dark:bg-rose-900/30',    text: 'text-rose-700 dark:text-rose-400',    dot: 'bg-rose-500' },
    expired:  { label: 'Expirado',   bg: 'bg-slate-100 dark:bg-slate-700/50',  text: 'text-slate-500 dark:text-slate-400',  dot: 'bg-slate-400' },
};

const SOURCE_CONFIG = {
    dashboard: { label: 'Dashboard', bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-700 dark:text-indigo-400' },
    whatsapp:  { label: 'WhatsApp',  bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-400' },
};

function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return `hace ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h}h`;
    return `hace ${Math.floor(h / 24)}d`;
}

function formatArs(amount) {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(amount);
}

function formatPhone(phone) {
    if (!phone) return null;
    return phone.replace('@c.us', '').replace('@s.whatsapp.net', '');
}

const PaymentRow = ({ payment, onRefresh, onGoToChat, refreshing, sellerName }) => {
    const [copied, setCopied] = useState(false);
    const st = STATUS_CONFIG[payment.status] || STATUS_CONFIG.pending;
    const src = SOURCE_CONFIG[payment.source] || SOURCE_CONFIG.dashboard;
    const clientPhone = formatPhone(payment.userPhone);
    const sellerPhone = formatPhone(payment.sellerPhone);

    const handleCopy = () => {
        navigator.clipboard.writeText(payment.link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="bg-white dark:bg-slate-800/80 border border-slate-100 dark:border-slate-700/80 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 hover:shadow-md transition-all">
            {/* Amount + status */}
            <div className="flex items-center gap-3 min-w-[140px]">
                <div className="w-10 h-10 rounded-xl bg-sky-50 dark:bg-sky-900/30 text-sky-500 flex items-center justify-center flex-shrink-0">
                    <CreditCard className="w-5 h-5" />
                </div>
                <div>
                    <p className="font-extrabold text-slate-800 dark:text-slate-100 text-sm leading-none">{formatArs(payment.amount)}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{timeAgo(payment.createdAt)}</p>
                </div>
            </div>

            {/* Badges */}
            <div className="flex flex-wrap gap-1.5 flex-1">
                {/* Status */}
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${st.bg} ${st.text}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`}></span>
                    {st.label}
                </span>
                {/* Source */}
                <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${src.bg} ${src.text}`}>{src.label}</span>
                {/* Seller name (admin only) */}
                {sellerName && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
                        <User className="w-3 h-3" /> {sellerName}
                    </span>
                )}
                {/* Seller phone */}
                {sellerPhone && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-slate-100 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300">
                        📱 {sellerPhone}
                    </span>
                )}
                {/* Client */}
                {clientPhone && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400">
                        👤 {clientPhone}
                    </span>
                )}
                {/* Paid at */}
                {payment.paidAt && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400">
                        ✓ {new Date(payment.paidAt).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </span>
                )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 flex-shrink-0">
                {/* Copy link */}
                <button
                    onClick={handleCopy}
                    title="Copiar enlace"
                    className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all text-xs font-bold ${copied ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600' : 'bg-slate-100 dark:bg-slate-700 text-slate-500 hover:bg-sky-100 dark:hover:bg-sky-900/30 hover:text-sky-600'}`}
                >
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>

                {/* Open link */}
                <a
                    href={payment.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Abrir en MercadoPago"
                    className="w-8 h-8 rounded-lg flex items-center justify-center bg-slate-100 dark:bg-slate-700 text-slate-500 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 hover:text-indigo-600 transition-all"
                >
                    <ExternalLink className="w-4 h-4" />
                </a>

                {/* Go to chat */}
                {clientPhone && (
                    <button
                        onClick={() => onGoToChat(payment.userPhone)}
                        title="Ir al chat del cliente"
                        className="w-8 h-8 rounded-lg flex items-center justify-center bg-slate-100 dark:bg-slate-700 text-slate-500 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 hover:text-emerald-600 transition-all"
                    >
                        <MessageCircle className="w-4 h-4" />
                    </button>
                )}

                {/* Refresh status */}
                <button
                    onClick={() => onRefresh(payment.id)}
                    disabled={refreshing === payment.id}
                    title="Actualizar estado desde MercadoPago"
                    className="w-8 h-8 rounded-lg flex items-center justify-center bg-slate-100 dark:bg-slate-700 text-slate-500 hover:bg-amber-100 dark:hover:bg-amber-900/30 hover:text-amber-600 disabled:opacity-50 transition-all"
                >
                    <RefreshCw className={`w-4 h-4 ${refreshing === payment.id ? 'animate-spin' : ''}`} />
                </button>
            </div>
        </div>
    );
};

const FILTERS = [
    { key: 'all', label: 'Todos' },
    { key: 'pending', label: 'Pendientes' },
    { key: 'approved', label: 'Aprobados' },
    { key: 'rejected', label: 'Rechazados' },
    { key: 'expired', label: 'Expirados' },
];

const PaymentsView = ({ onGoToChat }) => {
    const { toast } = useToast();
    const { socket } = useSocket();
    // Any admin (with or without home sellerId) sees cross-seller payments.
    const { isAdmin } = useAuth();
    const { sellers } = useSeller();
    const [payments, setPayments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(null);
    const [filter, setFilter] = useState('all');

    // Map instanceId → seller account name (for admin badge)
    const sellerIdToName = Object.fromEntries((sellers || []).map(s => [s.sellerId, capitalize(s.name)]));

    // Generate link state
    const [mpAmount, setMpAmount] = useState('');
    const [mpUserPhone, setMpUserPhone] = useState('');
    const [mpLoading, setMpLoading] = useState(false);

    const fetchPayments = useCallback(async (f = filter) => {
        try {
            const params = f !== 'all' ? `?status=${f}` : '';
            // Admin sees ALL payments regardless of selected seller
            const headers = isAdmin ? { 'x-seller-id': '' } : {};
            const res = await api.get(`/api/payments${params}`, { headers });
            setPayments(res.data.payments || []);
        } catch (e) {
            toast.error('Error cargando pagos');
        } finally {
            setLoading(false);
        }
    }, [filter, isAdmin]);

    useEffect(() => { fetchPayments(); }, []);

    // Real-time updates via Socket.IO
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
        } catch (e) {
            toast.error('Error consultando estado en MP');
        } finally {
            setRefreshing(null);
        }
    };

    const handleRefreshAll = async () => {
        const pending = payments.filter(p => p.status === 'pending');
        if (pending.length === 0) { toast.info('No hay pagos pendientes'); return; }

        // Refresca todos los pendientes en paralelo y muestra UN solo toast
        // resumen al final. Antes llamaba a handleRefresh por cada uno y el
        // toast de error individual se acumulaba (11 errores = 11 toasts).
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
        <div className="space-y-6 animate-fade-in">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-700 to-purple-600 dark:from-indigo-400 dark:to-purple-400 leading-none mb-1">
                        Administrador de Pagos
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 text-sm">MercadoPago · Enlace de pago con estado en tiempo real</p>
                </div>
                <button
                    onClick={handleRefreshAll}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-300 hover:text-indigo-600 dark:hover:text-indigo-400 text-sm font-bold transition-all shadow-sm"
                >
                    <RefreshCw className="w-4 h-4" />
                    Refrescar pendientes
                </button>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3">
                {[
                    { label: 'Pendientes', value: pendingCount, color: 'text-amber-600 dark:text-amber-400' },
                    { label: 'Aprobados', value: approvedCount, color: 'text-emerald-600 dark:text-emerald-400' },
                    { label: 'Cobrado', value: formatArs(totalApproved), color: 'text-sky-600 dark:text-sky-400' },
                ].map(s => (
                    <div key={s.label} className="bg-white dark:bg-slate-800/80 border border-slate-100 dark:border-slate-700/80 rounded-2xl p-4 text-center shadow-sm">
                        <p className={`text-xl font-extrabold ${s.color}`}>{s.value}</p>
                        <p className="text-xs text-slate-400 mt-0.5 font-medium">{s.label}</p>
                    </div>
                ))}
            </div>

            {/* Generate link panel */}
            <div className="bg-white dark:bg-slate-800/80 border border-slate-100 dark:border-slate-700/80 rounded-2xl p-5 shadow-sm">
                <div className="flex items-center gap-2 mb-4">
                    <div className="w-8 h-8 rounded-xl bg-sky-50 dark:bg-sky-900/30 text-sky-500 flex items-center justify-center border border-sky-100 dark:border-sky-800/50">
                        <CreditCard className="w-4 h-4" />
                    </div>
                    <span className="font-bold text-slate-700 dark:text-slate-200 text-sm">Generar nuevo enlace de pago</span>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                    <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-semibold text-sm">$</span>
                        <input
                            type="number" min="1" placeholder="Monto"
                            value={mpAmount}
                            onChange={e => setMpAmount(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleGenerateLink()}
                            className="pl-7 pr-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-900/50 text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500 transition-all text-sm w-full sm:w-36"
                        />
                    </div>
                    <input
                        type="text" placeholder="Teléfono cliente (opcional)"
                        value={mpUserPhone}
                        onChange={e => setMpUserPhone(e.target.value)}
                        className="flex-1 px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-900/50 text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500 transition-all text-sm"
                    />
                    <button
                        onClick={handleGenerateLink}
                        disabled={mpLoading || !mpAmount}
                        className="px-5 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-600 disabled:opacity-50 text-white font-bold text-sm transition-all shadow-sm shadow-sky-500/30 flex-shrink-0 flex items-center gap-2"
                    >
                        {mpLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                        Generar y copiar
                    </button>
                </div>
            </div>

            {/* Filter tabs */}
            <div className="flex gap-1.5 flex-wrap">
                {FILTERS.map(f => (
                    <button
                        key={f.key}
                        onClick={() => handleFilter(f.key)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${filter === f.key
                            ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/30'
                            : 'bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-300 hover:text-indigo-600'}`}
                    >
                        {f.label}
                        {f.key === 'pending' && pendingCount > 0 && (
                            <span className="ml-1.5 bg-amber-500 text-white text-[10px] font-extrabold px-1.5 py-0.5 rounded-full">{pendingCount}</span>
                        )}
                    </button>
                ))}
            </div>

            {/* List */}
            {loading ? (
                <div className="flex items-center justify-center py-16 gap-3">
                    <RefreshCw className="w-5 h-5 animate-spin text-indigo-500" />
                    <span className="text-slate-500 font-medium">Cargando pagos...</span>
                </div>
            ) : payments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                    <AlertCircle className="w-10 h-10 text-slate-300 dark:text-slate-600" />
                    <p className="text-slate-500 dark:text-slate-400 font-medium">No hay pagos{filter !== 'all' ? ` con estado "${FILTERS.find(f=>f.key===filter)?.label}"` : ''}</p>
                    <p className="text-slate-400 dark:text-slate-500 text-sm">Los enlaces generados aparecerán acá automáticamente</p>
                </div>
            ) : (
                <div className="space-y-3">
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
