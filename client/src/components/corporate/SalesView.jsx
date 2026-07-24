import React, { useState, useEffect } from 'react';
import api from '../../config/axios';
import { useOrders } from '../../hooks/useOrders';
import { useAuth } from '../../context/AuthContext';
import { useSeller } from '../../context/SellerContext';
import { capitalize } from '../../utils/format';
import {
    Button, IconButton, Card, Badge, Modal, Input, Select, EmptyState, useToast
} from '../ui';

import {
    RefreshCw, Download, Search, Filter, ChevronLeft, ChevronRight, MessageCircle,
    Edit2, Trash2, Save, Copy, Check, Package, Phone, MapPin, Inbox, AlertTriangle
} from 'lucide-react';

// Mapeo único de status → tono semántico + dot. Antes había 6 strings con
// `shadow-[0_0_10px_rgba(...)]` hardcoded — ahora una sola fuente de verdad.
const STATUS_TONE = {
    'Pendiente':  { tone: 'warning', dot: true,  label: 'Pendiente' },
    'Confirmado': { tone: 'info',    dot: true,  label: 'Confirmado' },
    'En sistema': { tone: 'accent',  dot: true,  label: 'En sistema' },
    'Enviado':    { tone: 'purple',  dot: false, label: 'Enviado' },
    'Entregado':  { tone: 'success', dot: true,  label: 'Entregado' },
    'Cancelado':  { tone: 'danger',  dot: false, label: 'Cancelado' },
};

const PAYMENT_TONE = {
    'mercadopago':   { tone: 'info',    label: 'MercadoPago' },
    'transferencia': { tone: 'purple',  label: 'Transferencia' },
};
const paymentMeta = (m) => PAYMENT_TONE[m] || { tone: 'warning', label: 'Contra reembolso' };

// Verificación de pago — solo aplica a transferencia (el admin mira el
// comprobante a mano y lo marca en el modal de carga). MP se verifica solo
// contra la API de MercadoPago; contrarembolso se cobra al entregar.
const transferVerifiedMeta = (order) => {
    if (order.paymentMethod !== 'transferencia') return null;
    return order.paymentVerifiedAt
        ? { tone: 'success', label: 'Pago verificado', Icon: Check }
        : { tone: 'danger', label: 'Sin verificar', Icon: AlertTriangle };
};

// Tipo de envío — el Order no tiene campo dedicado. El flujo marca el retiro
// seteando `calle = "A sucursal"` (ver src/flows/utils/messages.ts:135); esa es
// la ÚNICA señal confiable. Ojo: paymentMethod === 'contrarembolso' NO implica
// sucursal — el COD-con-seña entrega a domicilio con ese paymentMethod.
const isSucursal = (order) =>
    String(order.calle || '').trim().toLowerCase() === 'a sucursal';
const shippingMeta = (order) => isSucursal(order)
    ? { tone: 'accent', label: 'Sucursal',  Icon: Package }
    : { tone: 'info',   label: 'Domicilio', Icon: MapPin };

const STATUS_OPTIONS = ['Pendiente', 'Confirmado', 'En sistema', 'Enviado', 'Entregado', 'Cancelado'];

// Date formatter — manejo legacy strings y ISO. Ojo: el calendario "DD/MM/YYYY
// HH:mm" sin coma rompe la pieza original (`dt.includes(',')`); por eso se
// fuerza `dateStyle/timeStyle` que siempre incluye coma en es-AR.
const formatDateBA = (dateStr) => {
    if (!dateStr) return '—';
    try {
        let d = new Date(dateStr);
        if (isNaN(d.getTime()) && typeof dateStr === 'string' && dateStr.includes('/')) {
            const parts = dateStr.split(/[^\d]/);
            if (parts.length >= 3) {
                d = new Date(parts[2], parts[1] - 1, parts[0], parts[3] || 0, parts[4] || 0, parts[5] || 0);
            }
        }
        if (isNaN(d.getTime())) return 'Invalid Date';
        return d.toLocaleString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });
    } catch {
        return dateStr;
    }
};

// Sub-componente — fila clickeable que copia su valor al portapapeles.
// Vivía inline dentro del JSX, lo extraigo para que no se re-cree en cada render.
function CopyRow({ label, value, editField, mono, editing }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = () => {
        if (!value || editing) return;
        navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    };
    return (
        <div
            onClick={handleCopy}
            className={`flex items-center justify-between px-5 py-2.5 border-b border-slate-100 dark:border-slate-800 group transition-colors ${
                !editing ? 'hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer' : ''
            }`}
        >
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 w-24 sm:w-28 flex-shrink-0">
                {label}
            </span>
            <div className="flex-1 min-w-0 ml-3">
                {editing && editField ? editField : (
                    <span className={`text-sm text-slate-900 dark:text-slate-100 block truncate ${mono ? 'font-mono' : 'font-medium'}`}>
                        {value || '—'}
                    </span>
                )}
            </div>
            {!editing && value && (
                <span className="ml-2 flex-shrink-0 w-4 h-4 flex items-center justify-center">
                    {copied
                        ? <Check className="w-3.5 h-3.5 text-success-500" />
                        : <Copy className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                    }
                </span>
            )}
        </div>
    );
}

const SalesView = ({ onGoToChat }) => {
    const { toast, confirm } = useToast();
    const { isAdmin } = useAuth();
    const { sellers } = useSeller();
    const [page, setPage] = useState(1);

    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('Todos');
    const [sellerFilter, setSellerFilter] = useState('Todos');

    // Debounce search — 350ms para no martillar la API en cada tecla. El valor
    // debounceado se manda al hook → API; así "Maria Elina" busca contra TODAS
    // las órdenes históricas, no solo la página actual.
    const [debouncedSearch, setDebouncedSearch] = useState('');
    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(searchTerm.trim()), 350);
        return () => clearTimeout(t);
    }, [searchTerm]);

    useEffect(() => { setPage(1); }, [debouncedSearch, statusFilter, sellerFilter]);

    const apiInstanceId = isAdmin ? sellerFilter : '';

    const {
        orders, pagination, isLoading, isFetching,
        updateDetails, updateStatus, deleteOrder, refetch
    } = useOrders(page, 50, debouncedSearch, statusFilter, apiInstanceId);

    // instanceIds históricos — incluye sellers borrados como `denis` cuyas
    // ventas se preservaron pero la Account ya no existe.
    const [historicalSellerIds, setHistoricalSellerIds] = useState([]);
    useEffect(() => {
        if (!isAdmin) return;
        let cancelled = false;
        api.get('/api/orders/sellers')
            .then(({ data }) => { if (!cancelled) setHistoricalSellerIds(data?.instanceIds || []); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [isAdmin]);

    // Viewing/details state
    const [viewingOrder, setViewingOrder] = useState(null);
    const [isDetailEditing, setIsDetailEditing] = useState(false);
    const [detailEditData, setDetailEditData] = useState({});
    const [savingDetails, setSavingDetails] = useState(false);

    // Edit-status state
    const [editingOrder, setEditingOrder] = useState(null);
    const [editStatus, setEditStatus] = useState('');
    const [editTracking, setEditTracking] = useState('');
    const [savingOrder, setSavingOrder] = useState(false);

    // Tracking state
    const [isTracking, setIsTracking] = useState(false);
    const [trackingData, setTrackingData] = useState(null);
    const [showOriginalAddress, setShowOriginalAddress] = useState(false);

    const startDetailEdit = (order) => {
        setDetailEditData({
            nombre: order.nombre || '', calle: order.calle || '', ciudad: order.ciudad || '',
            cp: order.cp || '', provincia: order.provincia || '', producto: order.producto || '',
            precio: order.precio || '0', tracking: order.tracking || '', postdatado: order.postdatado || ''
        });
        setIsDetailEditing(true);
    };

    const cancelDetailEdit = () => { setIsDetailEditing(false); setDetailEditData({}); };

    const handleSaveOrderDetails = async () => {
        if (!viewingOrder) return;
        setSavingDetails(true);
        try {
            await updateDetails({ id: viewingOrder.id, data: detailEditData });
            setViewingOrder(prev => ({ ...prev, ...detailEditData }));
            setIsDetailEditing(false);
            toast.success('Orden actualizada');
        } catch (err) {
            toast.error('Error al guardar: ' + err.message);
        } finally {
            setSavingDetails(false);
        }
    };

    const handleDetailField = (field, value) => {
        setDetailEditData(prev => ({ ...prev, [field]: value }));
    };

    const handleTrackOrder = async (trackingCode) => {
        if (!trackingCode) return;
        setIsTracking(true);
        setTrackingData(null);
        try {
            const res = await api.get(`/api/orders/tracking/${trackingCode}`);
            setTrackingData(res.data);
        } catch {
            toast.error('Error al consultar seguimiento.');
        } finally {
            setIsTracking(false);
        }
    };

    // Exporta hasta 500 filas (tope del backend) con los filtros activos, no
    // solo la página visible. Mismo contrato que useOrders: filtros server-side
    // + header x-seller-id vacío para vista agregada de admin.
    const [exporting, setExporting] = useState(false);
    const handleExportCSV = async () => {
        if (exporting) return;
        setExporting(true);
        try {
            const headers = isAdmin ? { 'x-seller-id': '' } : {};
            const params = new URLSearchParams({ page: '1', limit: '500' });
            if (debouncedSearch) params.set('search', debouncedSearch);
            if (statusFilter && statusFilter !== 'Todos') params.set('status', statusFilter);
            if (apiInstanceId && apiInstanceId !== 'Todos') params.set('instanceId', apiInstanceId);
            const res = await api.get(`/api/orders?${params.toString()}`, { headers });
            const exportOrders = res.data.data || res.data || [];
            const total = res.data.pagination?.total ?? exportOrders.length;
            if (exportOrders.length === 0) { toast.warning('No hay pedidos para exportar con estos filtros'); return; }

            const csvHeaders = ['Fecha', 'Cliente', 'Nombre', 'Producto', 'Plan', 'Precio', 'Método pago', 'Verificación', 'Postdatado', 'Estado', 'Envío', 'Tracking', 'Ciudad', 'Calle', 'CP'];
            const rows = exportOrders.map(o => [
                o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '',
                o.cliente || '', o.nombre || '', o.producto || '', o.plan || '', o.precio || '',
                paymentMeta(o.paymentMethod).label,
                o.paymentMethod === 'transferencia' ? (o.paymentVerifiedAt ? 'Verificado' : 'Sin verificar') : '',
                o.postdatado || '', o.status || '', shippingMeta(o).label, o.tracking || '', o.ciudad || '', o.calle || '', o.cp || ''
            ]);
            const csvContent = [csvHeaders.join(','), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const truncated = total > exportOrders.length;
            if (truncated) {
                toast.warning(`Se exportaron las ${exportOrders.length} filas más recientes de ${total}. Ajustá los filtros para acotar.`);
            }
            const a = document.createElement('a');
            a.href = url;
            a.download = `pedidos_${new Date().toISOString().split('T')[0]}${truncated ? `_primeras-${exportOrders.length}-de-${total}` : ''}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            toast.error('Error al exportar: ' + (e.response?.data?.error || e.message));
        } finally {
            setExporting(false);
        }
    };

    const openEdit = (order) => {
        setEditingOrder(order);
        setEditStatus(order.status || 'Pendiente');
        setEditTracking(order.tracking || '');
    };

    const handleSaveEdit = async () => {
        if (!editingOrder) return;
        setSavingOrder(true);
        try {
            await updateStatus({ id: editingOrder.id, status: editStatus, tracking: editTracking });
            toast.success('Pedido actualizado');
            setEditingOrder(null);
        } catch {
            toast.error('Error al guardar');
        }
        setSavingOrder(false);
    };

    const handleDeleteOrder = async () => {
        if (!editingOrder) return;
        const ok = await confirm(`¿Eliminar definitivamente el pedido de ${editingOrder.nombre}?`);
        if (!ok) return;
        try {
            await deleteOrder(editingOrder.id);
            setEditingOrder(null);
            toast.success('Pedido eliminado');
        } catch {
            toast.error('Error eliminando pedido');
        }
    };

    const handleGoToChat = async (clienteStr, sellerPhone) => {
        if (!clienteStr) { toast.warning('El pedido no tiene un teléfono asociado.'); return; }
        const toastId = toast.info('Buscando chat...');
        try {
            const statusRes = await api.get('/api/status');
            const connectedPhoneInfo = statusRes.data?.info?.wid?.user;
            const connectedPhone = connectedPhoneInfo || statusRes.data?.config?.alertNumber || statusRes.data?.config?.alertNumbers?.[0];

            if (sellerPhone && connectedPhone) {
                const cleanedSeller = sellerPhone.replace(/\D/g, '');
                const cleanedConnected = connectedPhone.replace(/\D/g, '');
                if (!cleanedSeller.endsWith(cleanedConnected) && !cleanedConnected.endsWith(cleanedSeller)) {
                    toast.dismiss(toastId);
                    toast.warning('Esta venta se hizo desde otro número.');
                    return;
                }
            }

            const res = await api.get('/api/chats');
            const chats = res.data;
            const cleaned = clienteStr.replace(/\D/g, '');
            const chatExists = chats.find(c => {
                const cCleaned = String(c.id).replace(/\D/g, '');
                return c.id === clienteStr || c.id === `${clienteStr}@c.us` ||
                    c.id.includes(cleaned) || cCleaned.endsWith(cleaned) || cleaned.endsWith(cCleaned) ||
                    (c.name && c.name.includes(clienteStr));
            });

            if (chatExists && onGoToChat) onGoToChat(chatExists.id);
            else if (onGoToChat) onGoToChat(`${cleaned}@c.us`);
            toast.dismiss(toastId);
        } catch {
            toast.dismiss(toastId);
            toast.error('Error de conexión al verificar chats activos.');
        }
    };

    const handleCopySaleDetails = (order) => {
        const rawPhone = order.cliente ? order.cliente.split('@')[0] : '';
        const phoneDisplay = rawPhone.length > 13 ? `Oculto por Anuncio Meta (${rawPhone})` : (rawPhone || 'Desconocido');
        const pm = paymentMeta(order.paymentMethod);
        const text = `Nombre: ${order.nombre || 'Cliente'}
Teléfono: ${phoneDisplay}
Producto: ${order.producto}
Total: $${order.precio}
Pago: ${pm.label}
Dirección: ${order.calle || '—'}
Ciudad: ${order.ciudad || '—'}
Provincia: ${order.provincia || '—'}
CP: ${order.cp || '—'}`;

        navigator.clipboard.writeText(text)
            .then(() => toast.success('Venta copiada al portapapeles'))
            .catch(() => toast.error('Error al copiar venta'));
    };

    // Sellers para filtro — admin ve todos, seller solo su número.
    const sellerIdToName = Object.fromEntries((sellers || []).map(s => [s.sellerId, capitalize(s.name)]));
    const uniqueFilterOptions = isAdmin
        ? Array.from(new Set([
            ...(sellers || []).map(s => s.sellerId).filter(Boolean),
            ...historicalSellerIds,
        ]))
        : Array.from(new Set(orders.map(o => o.seller).filter(Boolean)));
    const labelForSeller = (sid) => sellerIdToName[sid] || capitalize(sid || '');

    const filteredOrders = isAdmin
        ? orders
        : orders.filter(o => sellerFilter === 'Todos' || o.seller === sellerFilter);

    return (
        <div className="h-full flex flex-col animate-fade-in relative z-10 w-full gap-4">

            {/* Header + Filters */}
            <Card padding="md">
                <div className="flex flex-row justify-between items-center gap-2 mb-4">
                    <div className="min-w-0">
                        <h1 className="text-display text-slate-900 dark:text-slate-100">Logística y pedidos</h1>
                        <p className="hidden sm:block text-sm text-slate-500 dark:text-slate-400 mt-1">
                            Gestión de estados y envíos en tiempo real.
                        </p>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                        <IconButton
                            label="Refrescar"
                            icon={RefreshCw}
                            variant="subtle"
                            onClick={() => refetch()}
                            className={isFetching ? '[&_svg]:animate-spin' : ''}
                        />
                        <Button
                            onClick={handleExportCSV}
                            disabled={orders.length === 0}
                            loading={exporting}
                            leftIcon={Download}
                        >
                            <span className="hidden sm:inline">Exportar CSV</span>
                            <span className="sm:hidden">CSV</span>
                        </Button>
                    </div>
                </div>

                {/* Filtros */}
                <div className="flex flex-col lg:flex-row gap-2">
                    <div className="flex-1">
                        <Input
                            leftIcon={Search}
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="Buscar por cliente, teléfono o tracking…"
                            aria-label="Buscar pedidos"
                        />
                    </div>
                    <div className="sm:w-56 flex-shrink-0">
                        <Select
                            leftIcon={Filter}
                            value={statusFilter}
                            onChange={e => setStatusFilter(e.target.value)}
                            aria-label="Filtro de estado"
                        >
                            {['Todos', ...STATUS_OPTIONS].map(s => <option key={s} value={s}>{s}</option>)}
                        </Select>
                    </div>
                    {(isAdmin || uniqueFilterOptions.length > 1) && (
                        <div className="sm:w-56 flex-shrink-0">
                            <Select
                                value={sellerFilter}
                                onChange={e => setSellerFilter(e.target.value)}
                                aria-label={isAdmin ? 'Filtro de vendedor' : 'Filtro de número'}
                            >
                                <option value="Todos">{isAdmin ? 'Todos los vendedores' : 'Todos los números'}</option>
                                {uniqueFilterOptions.map(opt => (
                                    <option key={opt} value={opt}>
                                        {isAdmin ? labelForSeller(opt) : `+${opt.replace(/\D/g, '')}`}
                                    </option>
                                ))}
                            </Select>
                        </div>
                    )}
                </div>
            </Card>

            {/* Tabla / Mobile cards */}
            <Card padding="none" className="flex-1 flex flex-col overflow-hidden">
                <div className="overflow-auto custom-scrollbar flex-1">
                    {/* Desktop table — tipografía agrandada para usuarios 50+ años.
                        Lo más chico (hora, producto, teléfono del vendedor) sube a
                        text-xs (12px); lo principal (nombre cliente) a text-base. */}
                    <table className="w-full text-left border-collapse whitespace-nowrap hidden md:table">
                        <thead className="bg-slate-50/80 dark:bg-slate-800/40 border-b border-slate-200/70 dark:border-slate-700/70 sticky top-0 z-10 backdrop-blur-sm">
                            <tr className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
                                <th className="px-4 py-3.5 hidden md:table-cell">Fecha</th>
                                <th className="px-4 py-3.5 w-full">Cliente</th>
                                <th className="px-4 py-3.5">Teléfono</th>
                                <th className="px-4 py-3.5 text-center">Vendedor</th>
                                <th className="px-4 py-3.5 text-center">Envío</th>
                                <th className="px-4 py-3.5 text-center">Estado</th>
                                <th className="px-4 py-3.5 text-right">Acciones</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {isLoading ? (
                                Array.from({ length: 8 }).map((_, i) => (
                                    <tr key={`skel-${i}`} className="animate-pulse">
                                        <td className="px-4 py-3 hidden md:table-cell"><div className="h-3 bg-slate-200 dark:bg-slate-700/50 rounded w-20" /></td>
                                        <td className="px-4 py-3"><div className="h-3 bg-slate-200 dark:bg-slate-700/50 rounded w-32" /></td>
                                        <td className="px-4 py-3"><div className="h-3 bg-slate-200 dark:bg-slate-700/50 rounded w-24" /></td>
                                        <td className="px-4 py-3 text-center"><div className="h-3 bg-slate-200 dark:bg-slate-700/50 rounded w-16 mx-auto" /></td>
                                        <td className="px-4 py-3 text-center"><div className="h-5 bg-slate-200 dark:bg-slate-700/50 rounded-full w-20 mx-auto" /></td>
                                        <td className="px-4 py-3 text-center"><div className="h-5 bg-slate-200 dark:bg-slate-700/50 rounded-full w-20 mx-auto" /></td>
                                        <td className="px-4 py-3"><div className="flex gap-2 justify-end"><div className="w-8 h-8 rounded bg-slate-200 dark:bg-slate-700/50" /><div className="w-8 h-8 rounded bg-slate-200 dark:bg-slate-700/50" /></div></td>
                                    </tr>
                                ))
                            ) : filteredOrders.length === 0 ? (
                                <tr><td colSpan="7">
                                    <EmptyState
                                        icon={Inbox}
                                        title="No se encontraron pedidos"
                                        description="Intentá ajustar los filtros de búsqueda."
                                    />
                                </td></tr>
                            ) : (
                                filteredOrders.map(order => {
                                    const statusMeta = STATUS_TONE[order.status] || STATUS_TONE['Pendiente'];
                                    const shipMeta = shippingMeta(order);
                                    const payVer = transferVerifiedMeta(order);
                                    const dt = formatDateBA(order.createdAt);
                                    const [datePart, timePart] = typeof dt === 'string' && dt.includes(',')
                                        ? dt.split(',').map(s => s.trim())
                                        : [dt, ''];
                                    return (
                                        <tr key={order.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors group">
                                            <td className="px-4 py-3.5 hidden md:table-cell">
                                                <div className="flex flex-col whitespace-nowrap leading-tight">
                                                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200 tabular-nums">{datePart}</span>
                                                    {timePart && (
                                                        <span className="text-xs font-mono text-slate-400 dark:text-slate-500 tabular-nums mt-0.5">{timePart}</span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3.5 max-w-md">
                                                <button
                                                    onClick={() => { setViewingOrder(order); setTrackingData(null); }}
                                                    className="text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:rounded text-base font-medium text-slate-800 dark:text-slate-100 hover:text-accent-600 dark:hover:text-accent-400 transition-colors truncate block w-full"
                                                >
                                                    {order.nombre || 'Desconocido'}
                                                </button>
                                                {order.producto && (
                                                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                                                        {order.producto}
                                                    </p>
                                                )}
                                            </td>
                                            <td className="px-4 py-3.5">
                                                <span className="text-sm font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                                                    {order.cliente ? '+' + order.cliente.split('@')[0].replace(/\D/g, '') : '—'}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3.5 text-center">
                                                {order.instanceId || order.seller ? (
                                                    <div className="flex flex-col items-center gap-0.5">
                                                        {order.instanceId && (
                                                            <span className="text-sm font-medium text-slate-600 dark:text-slate-300 capitalize">
                                                                {labelForSeller(order.instanceId)}
                                                            </span>
                                                        )}
                                                        {order.seller && (
                                                            <span className="text-xs text-slate-400 dark:text-slate-500 font-mono tabular-nums">
                                                                +{order.seller.replace(/\D/g, '').slice(-10)}
                                                            </span>
                                                        )}
                                                    </div>
                                                ) : <span className="text-sm text-slate-400">—</span>}
                                            </td>
                                            <td className="px-4 py-3.5 text-center">
                                                <div className="flex flex-col items-center gap-1">
                                                    <Badge tone={shipMeta.tone} size="md">
                                                        <shipMeta.Icon className="w-3 h-3" />
                                                        {shipMeta.label}
                                                    </Badge>
                                                    {payVer && (
                                                        <Badge tone={payVer.tone} size="sm">
                                                            <payVer.Icon className="w-2.5 h-2.5" />
                                                            {payVer.label}
                                                        </Badge>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3.5 text-center">
                                                <Badge tone={statusMeta.tone} dot={statusMeta.dot} size="lg">
                                                    {statusMeta.label}
                                                </Badge>
                                            </td>
                                            <td className="px-4 py-3.5 text-right">
                                                <div className="flex justify-end gap-1.5">
                                                    <IconButton
                                                        label="Ir al chat"
                                                        icon={MessageCircle}
                                                        variant="ghost"
                                                        size="md"
                                                        onClick={(e) => { e.stopPropagation(); handleGoToChat(order.cliente, order.seller); }}
                                                    />
                                                    <IconButton
                                                        label="Editar pedido"
                                                        icon={Edit2}
                                                        variant="ghost"
                                                        size="md"
                                                        onClick={() => openEdit(order)}
                                                    />
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>

                    {/* Mobile cards */}
                    <div className="md:hidden flex flex-col gap-2 p-3">
                        {isLoading ? (
                            Array.from({ length: 4 }).map((_, i) => (
                                <div key={`skel-m-${i}`} className="p-4 rounded-card bg-slate-100/50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 animate-pulse h-24" />
                            ))
                        ) : filteredOrders.length === 0 ? (
                            <EmptyState
                                icon={Inbox}
                                title="No se encontraron pedidos"
                                description="Intentá ajustar los filtros de búsqueda."
                            />
                        ) : (
                            filteredOrders.map(order => {
                                const statusMeta = STATUS_TONE[order.status] || STATUS_TONE['Pendiente'];
                                const shipMeta = shippingMeta(order);
                                const payVer = transferVerifiedMeta(order);
                                const dt = formatDateBA(order.createdAt);
                                const [datePart] = typeof dt === 'string' && dt.includes(',')
                                    ? dt.split(',').map(s => s.trim())
                                    : [dt, ''];
                                return (
                                    <div key={order.id} className="bg-white dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/70 rounded-card shadow-card p-3 flex flex-col gap-2">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <p className="font-semibold text-base text-slate-900 dark:text-slate-100 truncate">
                                                    {order.nombre || 'Desconocido'}
                                                </p>
                                                <p className="text-sm font-mono text-slate-500 dark:text-slate-400 truncate mt-0.5 tabular-nums">
                                                    {order.cliente ? '+' + order.cliente.split('@')[0].replace(/\D/g, '') : '—'}
                                                </p>
                                            </div>
                                            <div className="flex flex-col items-end gap-1 flex-shrink-0">
                                                <Badge tone={statusMeta.tone} dot={statusMeta.dot} size="md">
                                                    {statusMeta.label}
                                                </Badge>
                                                <Badge tone={shipMeta.tone} size="sm">
                                                    <shipMeta.Icon className="w-2.5 h-2.5" />
                                                    {shipMeta.label}
                                                </Badge>
                                                {payVer && (
                                                    <Badge tone={payVer.tone} size="sm">
                                                        <payVer.Icon className="w-2.5 h-2.5" />
                                                        {payVer.label}
                                                    </Badge>
                                                )}
                                                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                                                    {datePart}
                                                </span>
                                            </div>
                                        </div>
                                        {(order.instanceId || order.seller) && (
                                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                                {order.instanceId && <span className="capitalize font-medium">{labelForSeller(order.instanceId)}</span>}
                                                {order.seller && <span className="font-mono ml-1 tabular-nums">(+{order.seller.replace(/\D/g, '').slice(-10)})</span>}
                                            </p>
                                        )}
                                        <div className="flex gap-1.5 mt-1">
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                fullWidth
                                                onClick={() => { setViewingOrder(order); setTrackingData(null); }}
                                            >
                                                Detalles
                                            </Button>
                                            <IconButton
                                                label="Ir al chat"
                                                icon={MessageCircle}
                                                variant="subtle"
                                                size="sm"
                                                onClick={() => handleGoToChat(order.cliente, order.seller)}
                                            />
                                            <IconButton
                                                label="Editar"
                                                icon={Edit2}
                                                variant="subtle"
                                                size="sm"
                                                onClick={() => openEdit(order)}
                                            />
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>

                {/* Pagination */}
                <div className="px-4 py-3 border-t border-slate-200/70 dark:border-slate-700/70 flex items-center justify-between gap-2 bg-slate-50/50 dark:bg-slate-800/30 flex-shrink-0">
                    <span className="text-sm font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap tabular-nums">
                        <span className="text-slate-900 dark:text-slate-100 font-semibold">{page}</span>
                        <span className="mx-1">/</span>
                        {pagination.totalPages}
                    </span>
                    <div className="flex gap-1.5">
                        <IconButton
                            label="Página anterior"
                            icon={ChevronLeft}
                            variant="ghost"
                            size="sm"
                            disabled={page <= 1 || isFetching}
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                        />
                        <IconButton
                            label="Página siguiente"
                            icon={ChevronRight}
                            variant="ghost"
                            size="sm"
                            disabled={page >= pagination.totalPages || isFetching}
                            onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                        />
                    </div>
                    <Badge tone="neutral" size="sm">
                        <span className="tabular-nums">{pagination.total}</span> totales
                    </Badge>
                </div>
            </Card>

            {/* Edit-status modal */}
            <Modal
                open={!!editingOrder}
                onClose={() => setEditingOrder(null)}
                title="Editar estado"
                subtitle={editingOrder ? `Order #${editingOrder.id?.substring(0, 6) || 'N/A'}` : ''}
                size="md"
            >
                {editingOrder && (
                    <>
                        <Modal.Body>
                            <div className="bg-slate-50 dark:bg-slate-800/40 rounded-control p-4 border border-slate-200/70 dark:border-slate-700/70 mb-4">
                                <p className="font-semibold text-slate-900 dark:text-slate-100 text-sm mb-0.5">
                                    {editingOrder.nombre || 'Sin nombre'}
                                </p>
                                <p className="text-xs font-mono text-slate-500 dark:text-slate-400 mb-2">
                                    {editingOrder.cliente}
                                </p>
                                <div className="flex items-center justify-between gap-2">
                                    <Badge tone="accent" size="md">{editingOrder.producto}</Badge>
                                    <span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                                        ${editingOrder.precio}
                                    </span>
                                </div>
                            </div>

                            <div className="space-y-3">
                                <Select
                                    label="Estado del pedido"
                                    leftIcon={Filter}
                                    value={editStatus}
                                    onChange={(e) => setEditStatus(e.target.value)}
                                >
                                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                                </Select>

                                <Input
                                    label="Código de seguimiento"
                                    type="text"
                                    value={editTracking}
                                    onChange={(e) => setEditTracking(e.target.value)}
                                    placeholder="Ej: CP123456789AR"
                                    className="font-mono"
                                />
                            </div>
                        </Modal.Body>

                        <Modal.Footer className="flex-col sm:flex-row gap-2">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={handleDeleteOrder}
                                leftIcon={Trash2}
                                className="!text-danger-600 hover:!bg-danger-50 dark:hover:!bg-danger-900/20 mr-auto"
                            >
                                Eliminar
                            </Button>
                            <Button variant="secondary" onClick={() => setEditingOrder(null)}>
                                Cancelar
                            </Button>
                            <Button
                                onClick={handleSaveEdit}
                                loading={savingOrder}
                            >
                                Aplicar cambios
                            </Button>
                        </Modal.Footer>
                    </>
                )}
            </Modal>

            {/* Detail modal */}
            <Modal
                open={!!viewingOrder}
                onClose={() => { setViewingOrder(null); cancelDetailEdit(); }}
                size="fullscreen-mobile"
                statusSlot={viewingOrder && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                        {(() => {
                            const s = STATUS_TONE[viewingOrder.status] || STATUS_TONE['Pendiente'];
                            const p = paymentMeta(viewingOrder.paymentMethod);
                            const pv = transferVerifiedMeta(viewingOrder);
                            return (
                                <>
                                    <Badge tone={s.tone} dot={s.dot} size="md">{s.label}</Badge>
                                    <Badge tone={p.tone} size="md">{p.label}</Badge>
                                    {pv && (
                                        <Badge tone={pv.tone} size="md">
                                            <pv.Icon className="w-3 h-3" />
                                            {pv.label}
                                        </Badge>
                                    )}
                                    {viewingOrder.postdatado &&
                                        String(viewingOrder.postdatado).trim() !== '' &&
                                        !['no', 'false'].includes(String(viewingOrder.postdatado).toLowerCase()) && (
                                        <Badge tone="warning" dot size="md">{viewingOrder.postdatado}</Badge>
                                    )}
                                </>
                            );
                        })()}
                    </div>
                )}
            >
                {viewingOrder && (
                    <>
                        {/* Action bar — edit toggle */}
                        <div className="px-5 py-2 border-b border-slate-200 dark:border-slate-700 flex justify-end gap-1.5 flex-shrink-0">
                            {!isDetailEditing ? (
                                <IconButton
                                    label="Editar"
                                    icon={Edit2}
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => startDetailEdit(viewingOrder)}
                                />
                            ) : (
                                <Button variant="ghost" size="sm" onClick={cancelDetailEdit}>
                                    Cancelar edición
                                </Button>
                            )}
                        </div>

                        <Modal.Body padded={false}>
                            {(() => {
                                const editInput = (field, placeholder) => (
                                    <input
                                        type="text"
                                        value={detailEditData[field] || ''}
                                        onChange={e => handleDetailField(field, e.target.value)}
                                        className="w-full text-sm font-medium text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-800 rounded-control px-3 py-1.5 border border-slate-200 dark:border-slate-700 focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 outline-none"
                                        placeholder={placeholder}
                                    />
                                );
                                const rawPhone = viewingOrder.cliente ? viewingOrder.cliente.split('@')[0] : '';
                                const phoneDisplay = rawPhone.length > 13 ? `Oculto (${rawPhone.slice(-6)})` : rawPhone;
                                const addressDisplay = showOriginalAddress && viewingOrder.calleOriginal
                                    ? viewingOrder.calleOriginal
                                    : (viewingOrder.calle || '');

                                return (
                                    <>
                                        <CopyRow editing={isDetailEditing} label="Nombre" value={viewingOrder.nombre || 'Sin nombre'} editField={editInput('nombre', 'Nombre completo')} />
                                        <CopyRow editing={isDetailEditing} label="Teléfono" value={phoneDisplay} mono />
                                        <CopyRow editing={isDetailEditing} label="Producto" value={viewingOrder.producto || 'Sin producto'} editField={editInput('producto', 'Producto')} />
                                        <CopyRow editing={isDetailEditing} label="Total" value={`$${viewingOrder.precio}`} editField={editInput('precio', 'Precio')} />

                                        {/* Seña pagada — el cartero NO cobra el total, solo el saldo restante */}
                                        {viewingOrder.senaPaid && viewingOrder.senaAmount > 0 && (
                                            <div className="px-5 py-3 border-b border-warning-100 dark:border-warning-900/40 bg-warning-50 dark:bg-warning-900/20">
                                                <div className="flex items-center justify-between gap-2">
                                                    <span className="text-[11px] font-medium uppercase tracking-wide text-warning-700 dark:text-warning-500">
                                                        Seña pagada
                                                    </span>
                                                    <span className="text-sm font-semibold tabular-nums text-warning-700 dark:text-warning-500">
                                                        ${Number(viewingOrder.senaAmount).toLocaleString('es-AR')} por MP
                                                    </span>
                                                </div>
                                                <div className="flex items-center justify-between gap-2 mt-1.5">
                                                    <span className="text-[11px] font-medium uppercase tracking-wide text-success-700 dark:text-success-500">
                                                        Cobrar al cartero
                                                    </span>
                                                    <span className="text-base font-semibold tabular-nums text-success-700 dark:text-success-500">
                                                        ${Number(viewingOrder.cashRemainder || 0).toLocaleString('es-AR')}
                                                    </span>
                                                </div>
                                            </div>
                                        )}

                                        <CopyRow editing={isDetailEditing} label="Dirección" value={addressDisplay || 'Sin domicilio'} editField={editInput('calle', 'Calle y número')} />
                                        <CopyRow editing={isDetailEditing} label="Ciudad" value={viewingOrder.ciudad || '—'} editField={editInput('ciudad', 'Ciudad')} />
                                        <CopyRow editing={isDetailEditing} label="Provincia" value={viewingOrder.provincia || '—'} editField={editInput('provincia', 'Provincia')} />
                                        <CopyRow editing={isDetailEditing} label="C.P." value={viewingOrder.cp || '—'} editField={editInput('cp', 'Código postal')} mono />
                                        <CopyRow editing={isDetailEditing} label="Fecha" value={formatDateBA(viewingOrder.createdAt)} />
                                        {viewingOrder.tracking && (
                                            <CopyRow editing={isDetailEditing} label="Tracking" value={viewingOrder.tracking} mono />
                                        )}
                                    </>
                                );
                            })()}

                            {/* Original address toggle */}
                            {!isDetailEditing && viewingOrder.calleOriginal && viewingOrder.calleOriginal !== viewingOrder.calle && (
                                <div className="px-5 py-2.5 border-b border-slate-100 dark:border-slate-800">
                                    <Button
                                        size="sm"
                                        variant="subtle"
                                        leftIcon={MapPin}
                                        onClick={() => setShowOriginalAddress(!showOriginalAddress)}
                                    >
                                        {showOriginalAddress ? 'Ver dirección de Maps' : 'Ver dirección original'}
                                    </Button>
                                </div>
                            )}

                            {/* Tracking timeline */}
                            {viewingOrder.tracking && (
                                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                                    <div className="flex justify-between items-center mb-3">
                                        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                            Seguimiento
                                        </span>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => handleTrackOrder(viewingOrder.tracking)}
                                            loading={isTracking}
                                        >
                                            Rastrear
                                        </Button>
                                    </div>
                                    {trackingData && (
                                        <div className="animate-fade-in">
                                            {trackingData.success ? (
                                                trackingData.events && trackingData.events.length > 0 ? (
                                                    <ul className="space-y-2.5 ml-1.5 border-l-2 border-accent-100 dark:border-accent-900/50 pl-4">
                                                        {trackingData.events.map((ev, i) => (
                                                            <li key={i} className="relative">
                                                                <span className="absolute -left-[18px] top-1.5 w-2 h-2 rounded-full bg-accent-500 ring-2 ring-white dark:ring-slate-900" />
                                                                <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                                                                    <span className="text-xs font-medium text-slate-700 dark:text-slate-200 min-w-[100px]">
                                                                        {ev.fecha}
                                                                        {ev.planta && <span className="text-[10px] text-info-500 font-medium uppercase tracking-wide ml-1.5">{ev.planta}</span>}
                                                                    </span>
                                                                    <p className="text-xs text-slate-600 dark:text-slate-400 flex-1">{ev.historia}</p>
                                                                </div>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                ) : (
                                                    <p className="text-xs text-slate-500 dark:text-slate-400">Sin movimientos recientes.</p>
                                                )
                                            ) : (
                                                <p className="text-xs text-danger-600 dark:text-danger-500 font-medium">
                                                    {trackingData.error || 'Sin información.'}
                                                </p>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Status history */}
                            {viewingOrder.logs && viewingOrder.logs.length > 0 && (
                                <div className="px-5 py-4">
                                    <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3 block">
                                        Historial
                                    </span>
                                    <ul className="space-y-2.5 ml-1.5 border-l-2 border-accent-100 dark:border-accent-900/50 pl-4">
                                        {[...viewingOrder.logs].reverse().map((log, idx) => (
                                            <li key={idx} className="relative">
                                                <span className="absolute -left-[19px] top-1 w-2.5 h-2.5 rounded-full bg-white dark:bg-slate-900 border-2 border-accent-500" />
                                                <div className="flex justify-between items-baseline mb-0.5">
                                                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{log.status}</span>
                                                    <span className="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">{formatDateBA(log.timestamp)}</span>
                                                </div>
                                                <p className="text-xs text-slate-500 dark:text-slate-400">{log.message}</p>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {viewingOrder.status === 'Cancelado' && (
                                <div className="mx-5 my-4 bg-danger-50 dark:bg-danger-900/20 text-danger-700 dark:text-danger-500 text-sm font-medium p-3 rounded-control text-center border border-danger-100 dark:border-danger-900/40">
                                    Pedido cancelado
                                </div>
                            )}
                        </Modal.Body>

                        <Modal.Footer>
                            {isDetailEditing ? (
                                <>
                                    <Button variant="secondary" onClick={cancelDetailEdit}>
                                        Cancelar
                                    </Button>
                                    <Button
                                        onClick={handleSaveOrderDetails}
                                        loading={savingDetails}
                                        leftIcon={Save}
                                    >
                                        Guardar
                                    </Button>
                                </>
                            ) : (
                                <>
                                    <Button
                                        variant="secondary"
                                        onClick={() => handleCopySaleDetails(viewingOrder)}
                                        leftIcon={Copy}
                                    >
                                        Copiar todo
                                    </Button>
                                    <Button onClick={() => { setViewingOrder(null); cancelDetailEdit(); }}>
                                        Cerrar
                                    </Button>
                                </>
                            )}
                        </Modal.Footer>
                    </>
                )}
            </Modal>
        </div>
    );
};

export default SalesView;
