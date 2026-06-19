import React, { useState, useEffect, useCallback } from 'react';
import {
    Package, RefreshCw, AlertCircle, User, MapPin, Mail, Phone, Copy, Check, MessageCircle, Truck,
} from 'lucide-react';
import api from '../../config/axios';
import { Card, Button, Badge, Input, EmptyState, useToast, cn } from '../ui';

const STATUS_TONE = {
    pending:    { tone: 'warning', label: 'Pendiente' },
    in_process: { tone: 'warning', label: 'En proceso' },
    approved:   { tone: 'success', label: 'Aprobado' },
    rejected:   { tone: 'danger',  label: 'Rechazado' },
    cancelled:  { tone: 'neutral', label: 'Cancelado' },
};

const FILTERS = [
    { key: 'all',      label: 'Todos' },
    { key: 'approved', label: 'Aprobados' },
    { key: 'pending',  label: 'Pendientes' },
    { key: 'rejected', label: 'Rechazados' },
];

const formatArs = (amount) =>
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(amount || 0);

const fullDate = (d) =>
    new Date(d).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

function OrderCard({ order, onShip }) {
    const [copied, setCopied] = useState(false);
    const [tracking, setTracking] = useState('');
    const [saving, setSaving] = useState(false);
    const st = STATUS_TONE[order.status] || STATUS_TONE.pending;
    const items = Array.isArray(order.items) ? order.items : [];
    const nombre = [order.nombre, order.apellido].filter(Boolean).join(' ');
    const addressLine = [
        [order.calle, order.piso].filter(Boolean).join(', '),
        order.ciudad,
        order.provincia,
        order.cp ? `CP ${order.cp}` : null,
    ].filter(Boolean).join(' · ');
    const phoneClean = (order.telefono || '').replace(/\D/g, '');

    const copyAddress = () => {
        const text = `${nombre}\n${[order.calle, order.piso].filter(Boolean).join(', ')}\n${order.ciudad}, ${order.provincia} (CP ${order.cp})\nTel: ${order.telefono}`;
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const doShip = async () => {
        setSaving(true);
        await onShip(order.id, true, tracking);
        setSaving(false);
    };

    return (
        <Card padding="md" className="flex flex-col gap-3">
            {/* Encabezado: total + fecha + estado */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-control bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-500 flex items-center justify-center flex-shrink-0">
                        <Package className="w-5 h-5" aria-hidden="true" />
                    </div>
                    <div>
                        <p className="font-semibold text-slate-900 dark:text-slate-100 text-base leading-none tabular-nums">
                            {formatArs(order.total)}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{fullDate(order.createdAt)}</p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <Badge tone={st.tone} dot size="md">{st.label}</Badge>
                    {order.shipped && <Badge tone="info" size="md"><Truck className="w-3 h-3" /> Enviado</Badge>}
                </div>
            </div>

            {/* Items */}
            <ul className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-300">
                {items.map((it, idx) => (
                    <li key={idx} className="flex items-center gap-2">
                        <span className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">{it.qty}×</span>
                        <span>{it.name}{it.plan ? ` · ${it.plan}` : ''}</span>
                    </li>
                ))}
            </ul>

            {/* Datos de envío */}
            <div className="rounded-control bg-slate-50 dark:bg-slate-800/50 p-3 text-sm space-y-1.5">
                <p className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
                    <User className="w-4 h-4 text-slate-400" /> {nombre || '—'}
                </p>
                <p className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
                    <MapPin className="w-4 h-4 text-slate-400 flex-shrink-0" /> {addressLine || '—'}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-600 dark:text-slate-400">
                    {order.email && (
                        <span className="flex items-center gap-1.5"><Mail className="w-3.5 h-3.5 text-slate-400" /> {order.email}</span>
                    )}
                    {order.telefono && (
                        <span className="flex items-center gap-1.5"><Phone className="w-3.5 h-3.5 text-slate-400" /> {order.telefono}</span>
                    )}
                </div>
                {order.notas && (
                    <p className="text-slate-500 dark:text-slate-400 italic">Nota: {order.notas}</p>
                )}
            </div>

            {/* Despacho */}
            {order.shipped ? (
                <div className="flex flex-wrap items-center gap-2 rounded-control bg-info-50 dark:bg-info-900/20 p-2.5 text-sm">
                    <Truck className="w-4 h-4 text-info-600 dark:text-info-400" />
                    <span className="font-medium text-info-700 dark:text-info-300">Enviado</span>
                    {order.tracking && (
                        <span className="text-slate-600 dark:text-slate-300">· Seguimiento: <span className="font-medium">{order.tracking}</span></span>
                    )}
                    {order.shippedAt && <span className="text-xs text-slate-400">· {fullDate(order.shippedAt)}</span>}
                    <button
                        type="button"
                        onClick={() => onShip(order.id, false)}
                        className="ml-auto text-xs font-medium text-slate-500 hover:text-rose-600 dark:hover:text-rose-400"
                    >
                        Desmarcar
                    </button>
                </div>
            ) : (
                <div className="flex flex-col sm:flex-row gap-2">
                    <div className="flex-1">
                        <Input
                            value={tracking}
                            onChange={e => setTracking(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && doShip()}
                            placeholder="N° de seguimiento (opcional)"
                            aria-label="Número de seguimiento"
                        />
                    </div>
                    <Button leftIcon={Truck} loading={saving} onClick={doShip} className="flex-shrink-0">
                        Marcar como enviado
                    </Button>
                </div>
            )}

            {/* Acciones */}
            <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" leftIcon={copied ? Check : Copy} onClick={copyAddress}>
                    {copied ? 'Copiado' : 'Copiar datos de envío'}
                </Button>
                {phoneClean.length >= 8 && (
                    <a
                        href={`https://wa.me/${phoneClean}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 h-8 rounded-control text-xs font-semibold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                    >
                        <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
                    </a>
                )}
            </div>
        </Card>
    );
}

const WebOrdersView = () => {
    const { toast } = useToast();
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all');
    const [onlyToShip, setOnlyToShip] = useState(false);

    const fetchOrders = useCallback(async (f = filter) => {
        try {
            const params = f !== 'all' ? `?status=${f}` : '';
            const res = await api.get(`/api/web-orders${params}`);
            setOrders(res.data.orders || []);
        } catch {
            toast.error('Error cargando pedidos web');
        } finally {
            setLoading(false);
        }
    }, [filter]);

    useEffect(() => { fetchOrders(); /* eslint-disable-next-line */ }, []);

    const handleFilter = (f) => {
        setFilter(f);
        setLoading(true);
        fetchOrders(f);
    };

    const handleShip = async (id, shipped, tracking) => {
        try {
            const res = await api.post(`/api/web-orders/${id}/ship`, { shipped, tracking });
            setOrders(prev => prev.map(o => o.id === id ? res.data.order : o));
            toast.success(shipped ? 'Marcado como enviado' : 'Marca de envío quitada');
        } catch {
            toast.error('No se pudo actualizar el envío');
        }
    };

    const approvedCount = orders.filter(o => o.status === 'approved').length;
    const toShipCount = orders.filter(o => o.status === 'approved' && !o.shipped).length;
    const totalApproved = orders.filter(o => o.status === 'approved').reduce((s, o) => s + (o.total || 0), 0);

    const visible = onlyToShip ? orders.filter(o => o.status === 'approved' && !o.shipped) : orders;

    return (
        <div className="space-y-4 animate-fade-in">
            <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                    <h1 className="text-display text-slate-900 dark:text-slate-100">Pedidos web</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        Compras desde la tienda online, con datos de envío y despacho.
                    </p>
                </div>
                <Button variant="secondary" leftIcon={RefreshCw} onClick={() => { setLoading(true); fetchOrders(); }}>
                    Refrescar
                </Button>
            </header>

            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Card padding="lg" className="text-center">
                    <p className="text-3xl sm:text-4xl font-semibold tabular-nums text-slate-700 dark:text-slate-200 leading-none">{orders.length}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 font-medium">Pedidos</p>
                </Card>
                <Card padding="lg" className="text-center">
                    <p className="text-3xl sm:text-4xl font-semibold tabular-nums text-success-600 dark:text-success-500 leading-none">{approvedCount}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 font-medium">Aprobados</p>
                </Card>
                <Card padding="lg" className="text-center">
                    <p className="text-3xl sm:text-4xl font-semibold tabular-nums text-warning-600 dark:text-warning-500 leading-none">{toShipCount}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 font-medium">Por enviar</p>
                </Card>
                <Card padding="lg" className="text-center">
                    <p className="text-2xl sm:text-3xl font-semibold tabular-nums text-info-600 dark:text-info-500 leading-none">{formatArs(totalApproved)}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 font-medium">Cobrado</p>
                </Card>
            </div>

            {/* Filtros */}
            <div className="flex flex-wrap items-center gap-1.5">
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
                    </button>
                ))}
                <button
                    type="button"
                    onClick={() => setOnlyToShip(v => !v)}
                    className={cn(
                        'ml-auto inline-flex items-center gap-1.5 px-3 h-8 rounded-control text-xs font-semibold transition-colors',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                        onlyToShip
                            ? 'bg-warning-500 text-white'
                            : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'
                    )}
                >
                    <Truck className="w-3.5 h-3.5" /> Solo por enviar
                </button>
            </div>

            {/* Lista */}
            {loading ? (
                <Card padding="lg" className="flex items-center justify-center gap-3">
                    <RefreshCw className="w-5 h-5 animate-spin text-accent-600 dark:text-accent-400" aria-hidden="true" />
                    <span className="text-sm text-slate-500 dark:text-slate-400">Cargando pedidos…</span>
                </Card>
            ) : visible.length === 0 ? (
                <Card padding="lg">
                    <EmptyState
                        icon={AlertCircle}
                        title={onlyToShip ? 'No hay pedidos por enviar' : `No hay pedidos web${filter !== 'all' ? ` "${FILTERS.find(f => f.key === filter)?.label}"` : ''}`}
                        description="Las compras hechas en la tienda online aparecerán acá."
                    />
                </Card>
            ) : (
                <div className="grid gap-3 md:grid-cols-2">
                    {visible.map(o => <OrderCard key={o.id} order={o} onShip={handleShip} />)}
                </div>
            )}
        </div>
    );
};

export default WebOrdersView;
