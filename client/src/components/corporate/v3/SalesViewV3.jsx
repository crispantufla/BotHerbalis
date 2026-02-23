import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import { useToast } from '../../ui/Toast';

const IconsV3 = {
    Refresh: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>,
    Download: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>,
    Search: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
    Filter: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>,
    Chat: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>,
    Edit: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>,
    Trash: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
    ChevronRight: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>,
    BoxOpen: () => <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
};

const SalesViewV3 = ({ onGoToChat }) => {
    const { toast, confirm } = useToast();
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);

    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('Todos');

    const [viewingOrder, setViewingOrder] = useState(null);
    const [editingOrder, setEditingOrder] = useState(null);
    const [editStatus, setEditStatus] = useState('');
    const [editTracking, setEditTracking] = useState('');

    const fetchOrders = async () => {
        setLoading(true);
        try {
            const res = await api.get('/api/orders');
            setOrders(res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
        } catch (e) { toast.error("Error cargando pedidos"); }
        finally { setLoading(false); }
    };

    useEffect(() => { fetchOrders(); }, []);

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
        a.href = url; a.download = `Ventas_Herbalis_${new Date().toISOString().split('T')[0]}.csv`; a.click();
        URL.revokeObjectURL(url);
        toast.success('Lista de pedidos descargada');
    };

    const handleSaveEdit = async () => {
        if (!editingOrder) return;
        try {
            await api.post(`/api/orders/${editingOrder.id}/status`, { status: editStatus, tracking: editTracking });
            setOrders(prev => prev.map(o => o.id === editingOrder.id ? { ...o, status: editStatus, tracking: editTracking } : o));
            toast.success("Pedido actualizado");
            setEditingOrder(null);
        } catch (e) { toast.error('Error al guardar estado de envío'); }
    };

    const handleDeleteOrder = async () => {
        if (!editingOrder) return;
        const ok = await confirm(`¿Borrar permanentemente el pedido de ${editingOrder.nombre}?`);
        if (!ok) return;
        try {
            await api.delete(`/api/orders/${editingOrder.id}`);
            setOrders(prev => prev.filter(o => o.id !== editingOrder.id));
            setEditingOrder(null);
            setViewingOrder(null);
            toast.success('Orden de pedido eliminada del registro');
        } catch (e) { toast.error('Error borrando pedido'); }
    };

    const attemptChatMatch = async (phoneStr) => {
        if (!phoneStr) return toast.warning('No hay un contacto atado al bot');
        const tid = toast.info('Buscando cliente...');
        try {
            const res = await api.get('/api/chats');
            const chats = res.data;
            const cln = phoneStr.replace(/\D/g, '');
            const chatMatch = chats.find(c => c.id === phoneStr || c.id === `${phoneStr}@c.us` || c.id.includes(cln));
            toast.dismiss(tid);
            if (chatMatch) onGoToChat(chatMatch.id);
            else toast.warning('El usuario cerró chat, desconectó WA o usa otro número.');
        } catch (e) {
            toast.dismiss(tid);
            toast.error('Falló comunicación interna al bot');
        }
    };

    const statusOptions = ['Pendiente', 'Confirmado', 'Enviado', 'Entregado', 'Cancelado'];

    // Status visual map for V3
    const getStatusStyle = (status) => {
        switch (status) {
            case 'Pendiente': return 'bg-amber-100 text-amber-700 border-amber-200';
            case 'Confirmado': return 'bg-blue-100 text-blue-700 border-blue-200';
            case 'Enviado': return 'bg-purple-100 text-purple-700 border-purple-200';
            case 'Entregado': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
            case 'Cancelado': return 'bg-rose-100 text-rose-700 border-rose-200';
            default: return 'bg-slate-100 text-slate-700 border-slate-200';
        }
    };

    const filteredOrders = orders.filter(ord => {
        const query = searchTerm.toLowerCase();
        const matchesQuery = !query ||
            (ord.nombre && ord.nombre.toLowerCase().includes(query)) ||
            (ord.cliente && ord.cliente.toLowerCase().includes(query)) ||
            (ord.ciudad && ord.ciudad.toLowerCase().includes(query)) ||
            (ord.cp && ord.cp.toLowerCase().includes(query));
        const matchesStatus = statusFilter === 'Todos' || ord.status === statusFilter;
        return matchesQuery && matchesStatus;
    });

    return (
        <div className="w-full max-w-7xl mx-auto flex flex-col h-[calc(100vh-140px)] relative z-10">

            {/* Header / Top Panel */}
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6 shrink-0 bg-white/60 p-5 rounded-3xl border border-slate-200/60 shadow-sm backdrop-blur-xl">
                <div className="flex flex-col gap-1">
                    <h1 className="text-3xl font-black text-slate-800 tracking-tight">Logística y <span className="text-blue-600">Envíos</span></h1>
                    <p className="text-slate-500 font-medium text-sm">Gestiona tickets de ventas, empaque y despachos.</p>
                </div>

                <div className="flex items-center gap-3">
                    <div className="relative">
                        <input
                            type="text"
                            placeholder="Buscar cliente, DNI, CP..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="bg-white border border-slate-200 rounded-2xl py-2.5 pl-11 pr-4 text-sm font-medium focus:ring-2 focus:ring-blue-500 outline-none w-full lg:w-64"
                        />
                        <div className="absolute left-4 top-2.5 text-slate-400"><IconsV3.Search /></div>
                    </div>

                    <div className="relative hidden sm:block">
                        <select
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value)}
                            className="appearance-none bg-white border border-slate-200 rounded-2xl py-2.5 pl-4 pr-10 text-sm font-bold text-slate-700 focus:ring-2 focus:ring-blue-500 outline-none cursor-pointer"
                        >
                            <option value="Todos">Todas las Operaciones</option>
                            {statusOptions.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                        <div className="absolute right-4 top-3 text-slate-400 pointer-events-none"><IconsV3.Filter /></div>
                    </div>

                    <button onClick={fetchOrders} className="p-2.5 bg-slate-100 text-slate-600 rounded-2xl hover:bg-slate-200 transition-colors tooltip" title="Actualizar Datos">
                        <IconsV3.Refresh />
                    </button>
                    <button onClick={handleExportCSV} className="p-2.5 bg-blue-50 text-blue-600 border border-blue-200 rounded-2xl hover:bg-blue-100 transition-colors tooltip" title="Imprimir Etiquetas (CSV)">
                        <IconsV3.Download />
                    </button>
                </div>
            </div>

            {/* Main Content Area - Grid of Cards */}
            <div className="flex-1 overflow-y-auto hide-scrollbar pb-10">
                {loading ? (
                    <div className="flex items-center justify-center h-64">
                        <div className="w-12 h-12 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin"></div>
                    </div>
                ) : filteredOrders.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 text-center bg-white/50 rounded-[2rem] border-2 border-dashed border-slate-200">
                        <IconsV3.BoxOpen className="text-slate-300 w-16 h-16 mb-4" />
                        <h3 className="text-xl font-bold text-slate-700">Baúl Vacío</h3>
                        <p className="text-slate-500 max-w-sm mt-1">No se encontraron remitos o despachos listos con los filtros actuales.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        {filteredOrders.map(order => (
                            <div key={order.id} className="bg-white border border-slate-200/60 rounded-3xl p-5 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 flex flex-col group cursor-pointer" onClick={() => setViewingOrder(order)}>

                                <div className="flex justify-between items-start mb-4">
                                    <div className={`px-3 py-1.5 rounded-xl border text-[10px] font-black uppercase tracking-widest ${getStatusStyle(order.status || 'Pendiente')}`}>
                                        {order.status || 'Pendiente'}
                                    </div>
                                    <div className="text-[10px] font-bold text-slate-400 bg-slate-50 px-2.5 py-1 rounded-lg">
                                        {new Date(order.createdAt).toLocaleDateString([], { day: '2-digit', month: 'short' })}
                                    </div>
                                </div>

                                <div className="mb-4">
                                    <h3 className="text-lg font-bold text-slate-800 line-clamp-1 group-hover:text-blue-600 transition-colors">{order.nombre || 'Desconocido'}</h3>
                                    <p className="text-xs font-semibold text-slate-500 tracking-wide mt-1 truncate">{order.ciudad ? `${order.ciudad}, CP ${order.cp}` : 'Destino omitido'}</p>
                                </div>

                                <div className="bg-slate-50 rounded-2xl p-3 mb-4 border border-slate-100">
                                    <p className="text-sm font-bold text-slate-700 truncate">{order.producto || 'Genérico'}</p>
                                    <p className="text-[11px] text-slate-500 font-medium">Plan {order.plan || '?'} Días | Total: ${order.precio || '0'}</p>
                                </div>

                                <div className="mt-auto flex justify-between items-center border-t border-slate-100 pt-4">
                                    <span className="text-[11px] font-medium text-slate-400 line-clamp-1 max-w-[60%]">
                                        ID: {order.id.slice(-6)}
                                    </span>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); openEdit(order); }}
                                        className="text-blue-600 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors inline-flex items-center gap-1.5"
                                    >
                                        <IconsV3.Edit /> Editar
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* VIEW/EDIT MODAL OVERLAY */}
            {(viewingOrder || editingOrder) && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => { setViewingOrder(null); setEditingOrder(null); }}></div>

                    <div className="bg-white rounded-[2.5rem] w-full max-w-2xl max-h-[90vh] overflow-y-auto relative z-10 shadow-2xl animate-scale-up border border-slate-100">
                        {/* Header Image Gradient */}
                        <div className="h-32 bg-gradient-to-r from-blue-600 to-indigo-600 p-8 flex items-end relative overflow-hidden">
                            <div className="absolute top-[-50px] right-[-50px] w-48 h-48 bg-white/20 rounded-full blur-2xl"></div>
                            <h2 className="text-3xl font-black text-white relative z-10">{editingOrder ? 'Editar Encomienda' : 'Detalles del Ticket'}</h2>
                        </div>

                        <div className="p-8">
                            {editingOrder ? (
                                <div className="space-y-6">
                                    <div>
                                        <label className="text-xs font-black uppercase tracking-widest text-slate-400 mb-2 block">Estado Fase Logística</label>
                                        <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-slate-700 font-bold focus:ring-2 focus:ring-blue-500 outline-none">
                                            {statusOptions.map(o => <option key={o} value={o}>{o}</option>)}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="text-xs font-black uppercase tracking-widest text-slate-400 mb-2 block">Código de Seguimiento (Correo)</label>
                                        <input type="text" value={editTracking} onChange={(e) => setEditTracking(e.target.value)} placeholder="TN: EJ12345678" className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-slate-700 font-bold focus:ring-2 focus:ring-blue-500 outline-none" />
                                    </div>
                                    <div className="flex justify-between items-center pt-6 mt-4 border-t border-slate-200">
                                        <button onClick={handleDeleteOrder} className="text-rose-600 bg-rose-50 px-5 py-3 rounded-2xl font-bold hover:bg-rose-100 flex items-center gap-2 transition-colors">
                                            <IconsV3.Trash /> Borrar Ficha
                                        </button>
                                        <div className="flex gap-3">
                                            <button onClick={() => setEditingOrder(null)} className="text-slate-500 hover:bg-slate-100 px-6 py-3 rounded-2xl font-bold transition-colors">Cancelar</button>
                                            <button onClick={handleSaveEdit} className="bg-blue-600 text-white px-8 py-3 rounded-2xl font-bold shadow-lg shadow-blue-500/30 hover:bg-blue-700 transition-colors">Guardar</button>
                                        </div>
                                    </div>
                                </div>
                            ) : viewingOrder && (
                                <div className="space-y-6 text-slate-700">
                                    <div className="grid grid-cols-2 gap-6 bg-slate-50 p-6 rounded-[2rem] border border-slate-100">
                                        <div>
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Titular</p>
                                            <p className="font-bold text-lg">{viewingOrder.nombre}</p>
                                            <p className="text-sm font-medium mt-1">{viewingOrder.cliente}</p>
                                        </div>
                                        <div>
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Creación</p>
                                            <p className="font-bold text-lg">{new Date(viewingOrder.createdAt).toLocaleDateString()}</p>
                                        </div>
                                    </div>

                                    <div className="px-2">
                                        <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-4 border-b pb-2">Destino de Entrega</h4>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                            <p className="text-sm"><b>Ubicación:</b> {viewingOrder.ciudad}, {viewingOrder.provincia}</p>
                                            <p className="text-sm"><b>Domicilio:</b> {viewingOrder.calle}</p>
                                            <p className="text-sm"><b>Piso/Dpto:</b> {viewingOrder.piso_depto || 'Casa'}</p>
                                            <p className="text-sm"><b>Código Postal:</b> {viewingOrder.cp}</p>
                                        </div>
                                    </div>

                                    <div className="px-2">
                                        <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-4 border-b pb-2">Mercadería Adquirida</h4>
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                            <p className="text-sm"><b>Variedad:</b> {viewingOrder.producto}</p>
                                            <p className="text-sm"><b>Plan:</b> {viewingOrder.plan} Días</p>
                                            <p className="text-sm text-green-600"><b>A Pagar:</b> ${viewingOrder.precio}</p>
                                        </div>
                                    </div>

                                    <div className="px-2">
                                        <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-4 border-b pb-2">Bitácora Interna</h4>
                                        <div className="grid grid-cols-1 gap-4">
                                            <p className="text-sm"><b>Status Operativo:</b> <span className={`px-2 py-0.5 rounded ml-1 text-xs font-bold ${getStatusStyle(viewingOrder.status || 'Pendiente')}`}>{viewingOrder.status || 'Pendiente'}</span></p>
                                            <p className="text-sm"><b>Tracking:</b> {viewingOrder.tracking ? <span className="font-mono bg-slate-100 px-2 py-1 rounded text-slate-800 tracking-wide">{viewingOrder.tracking}</span> : 'A la espera de carga.'}</p>
                                            {viewingOrder.postdatado && <p className="text-sm text-amber-600 bg-amber-50 p-3 rounded-xl border border-amber-100"><b>Aviso Postdatado:</b> Entregar a partir de {viewingOrder.postdatado}</p>}
                                        </div>
                                    </div>

                                    <div className="flex justify-end gap-3 pt-6 mt-4">
                                        <button onClick={() => attemptChatMatch(viewingOrder.cliente)} className="text-blue-600 bg-blue-50 px-5 py-3 rounded-2xl font-bold flex items-center gap-2 hover:bg-blue-100 transition-colors">
                                            <IconsV3.Chat /> Volver al Chat
                                        </button>
                                        <button onClick={() => setViewingOrder(null)} className="bg-slate-900 text-white px-8 py-3 rounded-2xl font-bold shadow-lg shadow-slate-900/20 hover:bg-slate-800 transition-colors">
                                            Entendido
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SalesViewV3;
