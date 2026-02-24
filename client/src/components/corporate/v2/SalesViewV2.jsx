import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import { useToast } from '../../ui/Toast';

const IconsV2 = {
    Refresh: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>,
    Download: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>,
    Search: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
    Filter: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>,
    Chat: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>,
    Edit: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>,
    Trash: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
    Script: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
};

const SalesViewV2 = ({ onGoToChat }) => {
    const { toast, confirm } = useToast();
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);

    // Advanced Filters V2
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('Todos');

    // Viewing / Details State
    const [viewingOrder, setViewingOrder] = useState(null);

    // Editing State
    const [editingOrder, setEditingOrder] = useState(null);
    const [editStatus, setEditStatus] = useState('');
    const [editTracking, setEditTracking] = useState('');
    const [savingOrder, setSavingOrder] = useState(false);

    // Tracking State
    const [isTracking, setIsTracking] = useState(false);
    const [trackingData, setTrackingData] = useState(null);

    const fetchOrders = async () => {
        setLoading(true);
        try {
            const res = await api.get('/api/orders');
            setOrders(res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
        } catch (e) {
            toast.error("Error cargando pedidos");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchOrders(); }, []);

    // Tracking Request
    const handleTrackOrder = async (trackingCode) => {
        if (!trackingCode) return;
        setIsTracking(true);
        setTrackingData(null);
        try {
            const res = await api.get(`/api/orders/tracking/${trackingCode}`);
            setTrackingData(res.data);
        } catch (e) {
            toast.error("Error al consultar seguimiento.");
        } finally {
            setIsTracking(false);
        }
    };

    // Export CSV
    const handleExportCSV = () => {
        if (orders.length === 0) return;
        const headers = ['Fecha', 'Cliente', 'Nombre', 'Producto', 'Plan', 'Precio', 'Postdatado', 'Estado', 'Tracking', 'Ciudad', 'Calle', 'CP'];
        const rows = orders.map(o => [
            o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '',
            o.cliente || '', o.nombre || '', o.producto || '', o.plan || '', o.precio || '',
            o.postdatado || '', o.status || '', o.tracking || '', o.ciudad || '', o.calle || '', o.cp || ''
        ]);
        const csvContent = [headers.join(','), ...rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `pedidos_${new Date().toISOString().split('T')[0]}.csv`; a.click();
        URL.revokeObjectURL(url);
    };

    // Edit logic
    const openEdit = (order) => {
        setEditingOrder(order);
        setEditStatus(order.status || 'Pendiente');
        setEditTracking(order.tracking || '');
    };

    const handleSaveEdit = async () => {
        if (!editingOrder) return;
        setSavingOrder(true);
        try {
            await api.post(`/api/orders/${editingOrder.id}/status`, { status: editStatus, tracking: editTracking });
            setOrders(prev => prev.map(o => o.id === editingOrder.id ? { ...o, status: editStatus, tracking: editTracking } : o));
            toast.success("Pedido actualizado");
            setEditingOrder(null);
        } catch (e) { toast.error('Error al guardar'); }
        setSavingOrder(false);
    };

    const handleDeleteOrder = async () => {
        if (!editingOrder) return;
        const ok = await confirm(`¿Eliminar definitivamente el pedido de ${editingOrder.nombre}?`);
        if (!ok) return;
        try {
            await api.delete(`/api/orders/${editingOrder.id}`);
            setOrders(prev => prev.filter(o => o.id !== editingOrder.id));
            setEditingOrder(null);
            toast.success('Pedido eliminado');
        } catch (e) { toast.error('Error eliminando pedido'); }
    };

    const handleGoToChat = async (clienteStr) => {
        if (!clienteStr) {
            toast.warning('El pedido no tiene un teléfono asociado.');
            return;
        }

        const toastId = toast.info('Buscando chat...');
        try {
            const res = await api.get('/api/chats');
            const chats = res.data;
            const cleaned = clienteStr.replace(/\D/g, ''); // phone numbers only mode

            const chatExists = chats.find(c =>
                c.id === clienteStr ||
                c.id === `${clienteStr}@c.us` ||
                c.id.includes(cleaned) ||
                (c.name && c.name.includes(clienteStr))
            );

            if (chatExists) {
                if (onGoToChat) onGoToChat(chatExists.id);
                toast.dismiss(toastId);
            } else {
                toast.dismiss(toastId);
                toast.warning('No se ha encontrado un chat activo en WhatsApp para este cliente. Asegurate de que el bot esté conectado y el cliente haya escrito.');
            }
        } catch (e) {
            toast.dismiss(toastId);
            toast.error('Error de conexión al verificar chats activos.');
        }
    };

    const handleCopySaleDetails = (order) => {
        const rawPhone = order.cliente ? order.cliente.split('@')[0] : '';
        const phoneDisplay = rawPhone.length > 13 ? `Oculto por Anuncio Meta (${rawPhone})` : rawPhone || 'Desconocido';

        const textToCopy = `Nombre: ${order.nombre || 'Cliente'}
Dirección: ${order.calle}, ${order.ciudad} (CP: ${order.cp})
Producto: ${order.producto}
Plan: ${order.plan} Días
A pagar: ${order.precio}
Teléfono: ${phoneDisplay}`;

        navigator.clipboard.writeText(textToCopy)
            .then(() => toast.success('Venta copiada al portapapeles'))
            .catch(() => toast.error('Error al copiar venta'));
    };

    // Styling Maps
    const statusOptions = ['Pendiente', 'Confirmado', 'Enviado', 'Entregado', 'Cancelado'];
    const statusStyles = {
        'Pendiente': 'bg-amber-100/80 text-amber-700 border-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.2)]',
        'Confirmado': 'bg-blue-100/80 text-blue-700 border-blue-300 shadow-[0_0_10px_rgba(59,130,246,0.2)]',
        'Enviado': 'bg-purple-100/80 text-purple-700 border-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.2)]',
        'Entregado': 'bg-emerald-100/80 text-emerald-700 border-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.2)]',
        'Cancelado': 'bg-rose-100/80 text-rose-700 border-rose-300 shadow-[0_0_10px_rgba(244,63,94,0.2)]'
    };

    // Filters logic
    const filteredOrders = orders.filter(order => {
        const matchesSearch = searchTerm === '' ||
            (order.nombre || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
            (order.cliente || '').includes(searchTerm) ||
            (order.tracking || '').toLowerCase().includes(searchTerm.toLowerCase());

        const matchesStatus = statusFilter === 'Todos' || (order.status || 'Pendiente') === statusFilter;

        return matchesSearch && matchesStatus;
    });

    // Timezone & Date Formatter
    const formatDateBA = (dateStr) => {
        if (!dateStr) return '—';
        try {
            // Handle DB legacy strings like "22/02/2026, 17:30" or ISO
            let d = new Date(dateStr);
            if (isNaN(d.getTime()) && dateStr.includes('/')) {
                // Try strictly parsing DD/MM/YYYY
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
        } catch (e) {
            return dateStr;
        }
    };

    return (
        <div className="h-full flex flex-col animate-fade-in relative z-10 w-full space-y-6">

            {/* V2 Header & Advanced Filters */}
            <div className="bg-white/40 backdrop-blur-xl rounded-[2rem] border border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] p-8">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8">
                    <div>
                        <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-700 to-purple-600 tracking-tight">
                            Logística y Pedidos
                        </h1>
                        <p className="text-slate-500 mt-2 font-medium">Gestión inteligente de estados y envíos en tiempo real.</p>
                    </div>

                    <div className="flex gap-4">
                        <button onClick={fetchOrders} className="p-3 bg-white border border-slate-200 rounded-xl text-slate-600 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-all shadow-sm active:scale-95 group">
                            <span className="group-hover:rotate-180 transition-transform duration-500 block"><IconsV2.Refresh /></span>
                        </button>
                        <button onClick={handleExportCSV} disabled={orders.length === 0} className="px-6 py-3 bg-gradient-to-r from-slate-800 to-slate-700 text-white rounded-xl text-sm font-bold shadow-lg shadow-slate-800/20 hover:shadow-slate-800/40 hover:scale-105 transition-all flex items-center gap-2 disabled:opacity-50 disabled:scale-100">
                            <IconsV2.Download />
                            <span>Exportar CSV</span>
                        </button>
                    </div>
                </div>

                {/* Filters Bar V2 */}
                <div className="flex flex-col lg:flex-row gap-4">
                    <div className="flex-1 relative group">
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="Buscar por cliente, teléfono o tracking..."
                            className="w-full bg-white/80 border border-white rounded-xl pl-12 pr-4 py-3.5 text-sm font-medium focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all text-slate-700 shadow-inner placeholder:text-slate-400"
                        />
                        <span className="absolute left-4 top-3.5 text-slate-400 group-focus-within:text-indigo-500 transition-colors"><IconsV2.Search /></span>
                    </div>

                    <div className="flex items-center gap-2 bg-white/60 p-2 rounded-xl border border-white/80 shadow-inner overflow-x-auto custom-scrollbar">
                        <div className="pl-3 pr-2 text-slate-400"><IconsV2.Filter /></div>
                        {['Todos', ...statusOptions].map(status => (
                            <button
                                key={status}
                                onClick={() => setStatusFilter(status)}
                                className={`px-4 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${statusFilter === status ? 'bg-indigo-600 text-white shadow-md' : 'bg-transparent text-slate-600 hover:bg-white'}`}
                            >
                                {status}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* V2 Glassmorphism Table */}
            <div className="flex-1 bg-white/60 backdrop-blur-xl rounded-[2rem] border border-white/80 shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden flex flex-col relative text-sm">

                {/* Background Glow */}
                <div className="absolute -bottom-32 -left-32 w-96 h-96 bg-purple-400/10 blur-[100px] rounded-full pointer-events-none"></div>

                <div className="overflow-auto custom-scrollbar flex-1 relative z-10">
                    {/* PC & Tablet Table View */}
                    <table className="w-full text-left border-collapse whitespace-nowrap hidden md:table">
                        <thead className="bg-white/40 border-b border-white/60 sticky top-0 z-20 backdrop-blur-md">
                            <tr className="text-xs uppercase tracking-widest text-slate-500 font-extrabold">
                                <th className="px-4 sm:px-8 py-5 hidden md:table-cell">Fecha</th>
                                <th className="px-4 sm:px-8 py-5 w-full">Cliente</th>
                                <th className="px-4 sm:px-8 py-5 whitespace-nowrap">Teléfono</th>
                                <th className="px-4 sm:px-8 py-5 text-center">Estado</th>
                                <th className="px-4 sm:px-8 py-5 text-right w-10">Acciones</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200/50">
                            {loading ? (
                                <tr><td colSpan="5" className="text-center py-20">
                                    <div className="flex flex-col items-center justify-center gap-4 text-indigo-500">
                                        <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin shadow-lg"></div>
                                        <span className="font-bold tracking-widest text-xs uppercase text-slate-400">Sincronizando Base de Datos</span>
                                    </div>
                                </td></tr>
                            ) : filteredOrders.length === 0 ? (
                                <tr><td colSpan="5" className="text-center py-20">
                                    <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4 border-2 border-dashed border-slate-300">
                                        <IconsV2.Search />
                                    </div>
                                    <p className="text-slate-500 font-bold text-lg">No se encontraron pedidos</p>
                                    <p className="text-slate-400 text-sm mt-1">Intentá ajustar los filtros de búsqueda.</p>
                                </td></tr>
                            ) : (
                                filteredOrders.map(order => (
                                    <tr key={order.id} className="hover:bg-white/50 transition-colors group">
                                        <td className="px-4 py-5 hidden md:table-cell w-32">
                                            {(() => {
                                                const dt = formatDateBA(order.createdAt);
                                                if (typeof dt === 'string' && dt.includes(',')) {
                                                    const [datePart, timePart] = dt.split(',');
                                                    return (
                                                        <div className="flex flex-col whitespace-nowrap">
                                                            <span className="font-sans text-[13px] font-extrabold text-slate-700">{datePart.trim()}</span>
                                                            <span className="font-mono text-[10px] font-bold text-indigo-400 tracking-wider mt-0.5">{timePart.trim()}</span>
                                                        </div>
                                                    );
                                                }
                                                return <span className="font-sans text-[13px] font-extrabold text-slate-700">{dt}</span>;
                                            })()}
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 w-full min-w-[200px] sm:max-w-md truncate">
                                            <button onClick={() => { setViewingOrder(order); setTrackingData(null); }} className="text-left group/click focus:outline-none flex items-center gap-3 w-full">
                                                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-50 to-purple-50 flex items-center justify-center text-indigo-600 font-extrabold text-[13px] shrink-0 border border-indigo-100/80 shadow-sm hidden sm:flex">
                                                    {order.nombre ? order.nombre.substring(0, 2).toUpperCase() : '??'}
                                                </div>
                                                <div className="flex flex-col truncate">
                                                    <p className="font-extrabold text-[14px] text-slate-800 group-hover/click:text-indigo-600 transition-colors truncate">
                                                        {order.nombre || 'Desconocido'}
                                                    </p>
                                                </div>
                                            </button>
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 whitespace-nowrap">
                                            <p className="text-[12px] text-slate-500 font-mono flex items-center gap-2 opacity-90 hover:opacity-100 transition-opacity">
                                                <svg className="w-4 h-4 text-emerald-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                                                {order.cliente ? '+' + order.cliente.split('@')[0].replace(/\D/g, '') : '—'}
                                            </p>
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 text-center">
                                            <span className={`px-3 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-widest border ${statusStyles[order.status] || statusStyles['Pendiente']}`}>
                                                {order.status || 'Pendiente'}
                                            </span>
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 text-right">
                                            <div className="flex justify-end gap-3 transition-opacity">
                                                <button onClick={(e) => { e.stopPropagation(); handleGoToChat(order.cliente); }} className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 hover:bg-emerald-500 hover:text-white transition-all flex items-center justify-center shadow-sm" title="Ir al Chat">
                                                    <IconsV2.Chat />
                                                </button>
                                                <button onClick={() => openEdit(order)} className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 hover:bg-blue-500 hover:text-white transition-all flex items-center justify-center shadow-sm" title="Editar Pedido">
                                                    <IconsV2.Edit />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>

                    {/* Mobile Cards View (sm and below) */}
                    <div className="md:hidden flex flex-col gap-4 p-4">
                        {loading ? (
                            <div className="flex flex-col items-center justify-center gap-4 text-indigo-500 py-10">
                                <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin shadow-lg"></div>
                                <span className="font-bold tracking-widest text-xs uppercase text-slate-400">Sincronizando Base de Datos</span>
                            </div>
                        ) : filteredOrders.length === 0 ? (
                            <div className="text-center py-10">
                                <div className="w-16 h-16 bg-white/60 rounded-full flex items-center justify-center mx-auto mb-3 shadow-sm border border-white">
                                    <IconsV2.Search />
                                </div>
                                <p className="text-slate-500 font-bold text-[15px]">No se encontraron pedidos</p>
                            </div>
                        ) : (
                            filteredOrders.map(order => (
                                <div key={order.id} className="bg-white/80 backdrop-blur-md border border-white rounded-[1.5rem] shadow-sm p-5 flex flex-col gap-4 relative overflow-hidden flex-shrink-0 animate-fade-in transition-all active:scale-[0.98]">
                                    <div className="flex justify-between items-start gap-3 w-full">
                                        <div className="flex items-center gap-3 min-w-0 flex-1">
                                            <div className="w-11 h-11 rounded-full bg-gradient-to-br from-indigo-50 to-purple-100 flex items-center justify-center text-indigo-600 font-extrabold text-[15px] shrink-0 border border-white shadow-sm shadow-indigo-100/50">
                                                {order.nombre ? order.nombre.substring(0, 2).toUpperCase() : '??'}
                                            </div>
                                            <div className="flex flex-col min-w-0 truncate pr-2">
                                                <p className="font-black text-[15px] text-slate-800 tracking-tight leading-tight truncate">{order.nombre || 'Desconocido'}</p>
                                                <p className="text-[12px] text-slate-500 font-mono mt-0.5 flex items-center gap-1.5 opacity-90 truncate">
                                                    <svg className="w-3.5 h-3.5 text-emerald-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                                                    {order.cliente ? '+' + order.cliente.split('@')[0].replace(/\D/g, '') : '—'}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex flex-col items-end gap-1.5 shrink-0">
                                            <span className={`px-2.5 py-1 rounded-md text-[9px] font-black uppercase tracking-widest border shadow-sm ${statusStyles[order.status] || statusStyles['Pendiente']}`}>
                                                {order.status || 'Pendiente'}
                                            </span>
                                            {(() => {
                                                const dt = formatDateBA(order.createdAt);
                                                if (typeof dt === 'string' && dt.includes(',')) {
                                                    const [datePart] = dt.split(',');
                                                    return <span className="font-extrabold text-[10px] text-slate-400 bg-slate-50 px-2 py-0.5 rounded border border-slate-100">{datePart.trim()}</span>;
                                                }
                                                return <span className="font-extrabold text-[10px] text-slate-400 bg-slate-50 px-2 py-0.5 rounded border border-slate-100">{dt}</span>;
                                            })()}
                                        </div>
                                    </div>

                                    <div className="flex gap-2">
                                        <button onClick={() => { setViewingOrder(order); setTrackingData(null); }} className="flex-1 bg-white border border-slate-200 text-indigo-600 rounded-xl py-2.5 text-[11px] font-extrabold uppercase tracking-widest flex items-center justify-center gap-1.5 shadow-sm active:bg-indigo-50 transition-colors">
                                            <IconsV2.Script className="w-3.5 h-3.5" /> Detalles
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); handleGoToChat(order.cliente); }} className="w-12 bg-emerald-50 border border-emerald-100 text-emerald-600 rounded-xl flex items-center justify-center shadow-sm active:bg-emerald-100 transition-colors">
                                            <IconsV2.Chat className="w-4 h-4" />
                                        </button>
                                        <button onClick={() => openEdit(order)} className="w-12 bg-blue-50 border border-blue-100 text-blue-600 rounded-xl flex items-center justify-center shadow-sm active:bg-blue-100 transition-colors">
                                            <IconsV2.Edit className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                </div>

                {/* Footer */}
                <div className="px-8 py-5 border-t border-white/60 flex justify-between items-center bg-white/30 backdrop-blur-md">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">Mostrando {filteredOrders.length} registros</span>
                    <span className="text-xs font-bold text-indigo-500 bg-indigo-50 px-3 py-1 rounded-full border border-indigo-100">{orders.length} Totales en BD</span>
                </div>
            </div>

            {/* V2 GLASSMORPHISM EDIT MODAL */}
            {editingOrder && (
                <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md z-50 flex items-center justify-center animate-fade-in p-4">
                    <div className="bg-white/90 backdrop-blur-2xl rounded-[2rem] shadow-2xl w-full max-w-md p-8 border border-white relative overflow-hidden">

                        <div className="absolute top-0 right-0 w-40 h-40 bg-indigo-500/10 blur-[50px] rounded-full pointer-events-none"></div>

                        <div className="flex justify-between items-center mb-8 relative z-10">
                            <div>
                                <h3 className="text-2xl font-extrabold text-slate-800 tracking-tight">Editar Estado</h3>
                                <p className="text-xs font-bold text-indigo-600 uppercase tracking-widest mt-1">Order #{editingOrder.id?.substring(0, 6) || 'N/A'}</p>
                            </div>
                            <button onClick={() => setEditingOrder(null)} className="w-10 h-10 rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors flex items-center justify-center">✕</button>
                        </div>

                        <div className="space-y-6 relative z-10">
                            <div className="bg-gradient-to-br from-slate-50 to-blue-50/50 rounded-2xl p-5 border border-slate-200/60 shadow-inner">
                                <p className="text-lg font-extrabold text-slate-800 mb-1">{editingOrder.nombre || 'Sin nombre'}</p>
                                <p className="text-sm font-mono text-slate-500 mb-3">{editingOrder.cliente}</p>
                                <div className="flex items-center gap-2">
                                    <span className="px-2.5 py-1 rounded-lg bg-indigo-100 text-indigo-700 text-xs font-bold">{editingOrder.producto}</span>
                                    <span className="text-sm font-extrabold text-slate-800 ml-auto">${editingOrder.precio}</span>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-extrabold text-slate-500 uppercase tracking-widest mb-2 ml-1">Estado del Pedido</label>
                                <div className="relative">
                                    <select
                                        value={editStatus}
                                        onChange={(e) => setEditStatus(e.target.value)}
                                        className="w-full appearance-none bg-white border border-slate-200 rounded-xl px-5 py-4 text-sm font-bold text-slate-700 focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all shadow-sm cursor-pointer"
                                    >
                                        {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                    <div className="absolute inset-y-0 right-0 flex items-center px-5 pointer-events-none text-slate-400">
                                        <IconsV2.Filter />
                                    </div>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-extrabold text-slate-500 uppercase tracking-widest mb-2 ml-1">Código de Seguimiento (Andreani)</label>
                                <input
                                    type="text"
                                    value={editTracking}
                                    onChange={(e) => setEditTracking(e.target.value)}
                                    placeholder="Ej: CP123456789AR"
                                    className="w-full bg-white border border-slate-200 rounded-xl px-5 py-4 text-sm font-mono font-bold text-slate-700 focus:ring-4 focus:ring-blue-500/20 focus:border-blue-400 outline-none transition-all shadow-sm placeholder:text-slate-300 placeholder:font-sans placeholder:font-normal"
                                />
                            </div>
                        </div>

                        <div className="mt-8 space-y-3 relative z-10">
                            <div className="flex gap-3">
                                <button onClick={() => setEditingOrder(null)} className="flex-1 py-4 bg-slate-100 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-200 transition-colors shadow-sm">
                                    Cancelar
                                </button>
                                <button onClick={handleSaveEdit} disabled={savingOrder} className="flex-1 py-4 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-[1.02] transition-all disabled:opacity-50 disabled:scale-100">
                                    {savingOrder ? 'Guardando...' : 'Aplicar Cambios'}
                                </button>
                            </div>

                            <button onClick={handleDeleteOrder} className="w-full py-4 bg-transparent border-2 border-rose-100 text-rose-500 rounded-xl text-xs font-extrabold uppercase tracking-widest hover:bg-rose-50 hover:border-rose-200 transition-all flex items-center justify-center gap-2 mt-4">
                                <IconsV2.Trash />
                                Eliminar Registro
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* V2 DETAILS MODAL (TICKET STYLE COMPACTADO) */}
            {viewingOrder && (
                <div className="fixed inset-0 bg-white/95 sm:bg-slate-900/60 backdrop-blur-none sm:backdrop-blur-md z-50 flex items-center justify-center animate-fade-in p-0 sm:p-4" onClick={() => setViewingOrder(null)}>
                    <div className="bg-slate-50/95 sm:bg-white/70 backdrop-blur-none sm:backdrop-blur-2xl rounded-none sm:rounded-3xl shadow-none sm:shadow-[0_16px_40px_rgb(0,0,0,0.15)] w-full h-full sm:h-auto max-w-2xl overflow-hidden flex flex-col sm:max-h-[90vh] relative border-0 sm:border border-white" onClick={e => e.stopPropagation()}>

                        {/* Compact Header Glassmorphism */}
                        <div className="bg-white/40 p-4 sm:p-5 flex justify-between items-center relative overflow-hidden shrink-0 border-b border-white/50">
                            <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 blur-[50px] rounded-full pointer-events-none"></div>
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-white/70 text-indigo-600 flex items-center justify-center shadow-sm">
                                    <IconsV2.Script />
                                </div>
                                <div>
                                    <h3 className="text-xl font-black text-slate-800 tracking-tight leading-none">Detalles del Ticket</h3>
                                    <p className="text-indigo-600 font-bold text-[10px] uppercase tracking-widest mt-0.5">{viewingOrder.id ? `#${viewingOrder.id.substring(0, 8)}` : 'REGISTRO DE VENTA'}</p>
                                </div>
                            </div>
                            <button onClick={() => setViewingOrder(null)} className="w-8 h-8 rounded-full bg-white text-slate-400 hover:text-rose-500 shadow-sm transition-all flex items-center justify-center border border-slate-100 hover:border-rose-100">✕</button>
                        </div>

                        {/* Ticket Body scrollable - Compact Grid */}
                        <div className="p-3 sm:p-4 overflow-y-auto custom-scrollbar flex-1 relative bg-slate-50/20">
                            <div className="absolute -left-10 top-1/4 w-40 h-40 bg-purple-400/10 blur-[50px] rounded-full pointer-events-none"></div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                                {/* Card 1: Titular */}
                                <div className="bg-white/60 backdrop-blur-md rounded-2xl p-4 border border-white shadow-sm flex flex-col justify-between relative overflow-hidden">
                                    <div className="absolute right-0 bottom-0 w-16 h-16 bg-emerald-400/10 blur-[20px] rounded-full pointer-events-none"></div>
                                    <span className="text-[10px] font-black uppercase text-indigo-400 tracking-widest mb-2 flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-indigo-400"></div> Titular</span>
                                    <p className="font-extrabold text-slate-800 text-sm leading-tight">{viewingOrder.nombre || 'Sin nombre'}</p>
                                    <p className="font-mono text-slate-500 text-[11px] font-bold mt-0.5">{viewingOrder.cliente ? viewingOrder.cliente.split('@')[0] : '—'}</p>
                                    <div className="mt-2 pt-2 border-t border-white text-[11px]">
                                        <span className="text-slate-400 font-bold">Creación:</span> <span className="text-slate-700 font-extrabold">{formatDateBA(viewingOrder.createdAt)}</span>
                                    </div>
                                </div>

                                {/* Card 2: Destino */}
                                <div className="bg-white/60 backdrop-blur-md rounded-2xl p-4 border border-white shadow-sm flex flex-col justify-between">
                                    <span className="text-[10px] font-black uppercase text-indigo-400 tracking-widest mb-2 flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-indigo-400"></div> Destino de Entrega</span>
                                    <p className="font-extrabold text-slate-800 text-sm leading-tight flex-1">{viewingOrder.calle || 'Sin domicilio'}, <br />{viewingOrder.ciudad || 'Sin ciudad'}</p>
                                    <div className="mt-2 pt-2 border-t border-white flex items-center justify-between text-[11px]">
                                        <div><span className="text-slate-400 font-bold">C.P.:</span> <span className="text-slate-700 font-extrabold">{viewingOrder.cp || '—'}</span></div>
                                        {viewingOrder.postdatado && <span className="text-amber-500 font-bold bg-amber-50 px-1.5 py-0.5 rounded shadow-sm">Postdatado: {viewingOrder.postdatado}</span>}
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {/* Card 3: Mercaderia */}
                                <div className="bg-white/60 backdrop-blur-md rounded-2xl p-4 border border-white shadow-sm flex flex-col justify-between">
                                    <span className="text-[10px] font-black uppercase text-indigo-400 tracking-widest mb-2 flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-indigo-400"></div> Mercadería</span>
                                    <div>
                                        <p className="font-extrabold text-slate-800 text-sm leading-tight">{viewingOrder.producto}</p>
                                        {viewingOrder.plan && <p className="text-slate-500 font-bold text-[11px] mt-0.5">Plan {viewingOrder.plan} Días</p>}
                                    </div>
                                    <div className="mt-2 pt-2 border-t border-white flex items-center justify-between">
                                        <span className="text-emerald-600 font-extrabold text-[10px] uppercase tracking-wider">A Pagar</span>
                                        <span className="font-black text-emerald-600 text-lg tracking-tighter leading-none">${viewingOrder.precio?.replace(/\D/g, '') || '0'}</span>
                                    </div>
                                </div>

                                {/* Card 4: Bitacora */}
                                <div className="bg-white/60 backdrop-blur-md rounded-2xl p-4 border border-white shadow-sm flex flex-col">
                                    <span className="text-[10px] font-black uppercase text-indigo-400 tracking-widest mb-2 flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-indigo-400"></div> Bitácora</span>

                                    <div className="flex justify-between items-center mb-2">
                                        <div className="flex flex-col gap-0.5">
                                            <span className="text-slate-400 font-bold text-[10px] uppercase">Status</span>
                                            <span className={`inline-block px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-wider border shadow-sm ${statusStyles[viewingOrder.status] || statusStyles['Pendiente']}`}>
                                                {viewingOrder.status || 'Pendiente'}
                                            </span>
                                        </div>
                                        {viewingOrder.tracking && (
                                            <div className="flex flex-col items-end gap-0.5">
                                                <span className="text-slate-400 font-bold text-[10px] uppercase">Tracking TCA</span>
                                                <span className="font-bold font-mono text-slate-700 bg-white/80 px-2 py-0.5 rounded shadow-sm border border-slate-100 text-[10px]">{viewingOrder.tracking}</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Tracking Controls */}
                                    {viewingOrder.tracking ? (
                                        <div className="mt-auto pt-1">
                                            <button onClick={() => handleTrackOrder(viewingOrder.tracking)} disabled={isTracking} className="w-full justify-center flex items-center gap-1.5 px-3 py-1.5 bg-blue-50/80 text-blue-600 hover:bg-blue-100 font-bold text-[11px] rounded-lg transition-all shadow-sm border border-blue-200/50 disabled:opacity-50">
                                                {isTracking ? 'Consultando...' : '🔍 Rastrear en Vivo'}
                                            </button>
                                            {/* Tracking Events Expansion Compact - MOVED BELOW */}
                                        </div>
                                    ) : (
                                        <span className="text-slate-400 font-extrabold text-[10px] text-center mt-auto block pt-2 border-t border-white">—</span>
                                    )}
                                </div>
                            </div>

                            {/* Card 5: Tracking Events Expansion (Full Width) */}
                            {trackingData && (
                                <div className="mt-3 bg-white/60 backdrop-blur-md rounded-2xl p-4 border border-white shadow-sm flex flex-col w-full animate-fade-in">
                                    <span className="text-[10px] font-black uppercase text-indigo-400 tracking-widest mb-3 flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></div> Historial Integral del Paquete</span>

                                    <div className="bg-white/50 border border-white/80 rounded-xl p-3 shadow-[inset_0_2px_10px_rgb(0,0,0,0.02)] max-h-48 overflow-y-auto custom-scrollbar">
                                        {trackingData.success ? (
                                            trackingData.events && trackingData.events.length > 0 ? (
                                                <div className="space-y-2">
                                                    {trackingData.events.map((ev, i) => (
                                                        <div key={i} className="flex flex-col sm:flex-row sm:items-center bg-white/80 p-3 rounded-lg shadow-sm border border-white/50 text-[11px] backdrop-blur-sm gap-2 sm:gap-4 transition-all hover:bg-white hover:shadow-md">
                                                            <div className="flex flex-col justify-center min-w-[130px]">
                                                                <span className="font-extrabold text-slate-800 border-b border-slate-100 pb-0.5 mb-1 sm:border-0 sm:pb-0 sm:mb-0">{ev.fecha}</span>
                                                                <span className="text-blue-600 bg-blue-50 px-2 py-0.5 rounded font-black uppercase tracking-widest text-[9px] w-fit sm:mt-0.5">{ev.planta}</span>
                                                            </div>
                                                            <div className="hidden sm:block w-px h-8 bg-slate-200"></div>
                                                            <span className="text-slate-600 font-medium leading-relaxed flex-1">{ev.historia}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <p className="text-slate-500 italic text-[11px] font-medium text-center py-3">El operador logístico aún no reportó movimientos.</p>
                                            )
                                        ) : (
                                            <p className="text-rose-600 font-bold text-[11px] bg-rose-50 p-2.5 rounded-lg text-center border border-rose-100">{trackingData.error || "Tracking incorrecto o inactivo."}</p>
                                        )}
                                    </div>
                                </div>
                            )}

                        </div>

                        {/* Footer Buttons Compact Glassmorphism */}
                        <div className="bg-white/50 border-t border-white/50 p-3 sm:p-4 flex justify-end gap-2.5 shrink-0 backdrop-blur-md">
                            <button onClick={() => handleCopySaleDetails(viewingOrder)} className="flex items-center gap-1.5 px-4 py-2 sm:px-5 sm:py-2.5 bg-white/70 text-indigo-700 hover:bg-white hover:text-indigo-600 border border-white shadow-sm font-extrabold text-[11px] uppercase tracking-wider rounded-xl transition-all hover:-translate-y-0.5">
                                <IconsV2.Script className="w-3.5 h-3.5" /> Copiar Venta
                            </button>
                            <button onClick={() => setViewingOrder(null)} className="px-6 py-2 sm:px-8 sm:py-2.5 bg-slate-800/90 text-white rounded-xl text-[11px] uppercase tracking-wider font-extrabold hover:bg-slate-900 transition-all shadow-md shadow-slate-800/20 hover:-translate-y-0.5 backdrop-blur-sm">
                                Entendido
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SalesViewV2;
