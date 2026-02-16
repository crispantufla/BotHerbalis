import React, { useState, useEffect } from 'react';
import axios from 'axios';

const SalesView = () => {
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchOrders = async () => {
            try {
                const res = await axios.get('http://localhost:3000/api/orders');
                setOrders(res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
            } catch (e) {
                console.error("Failed to load orders", e);
            } finally {
                setLoading(false);
            }
        };
        fetchOrders();
    }, []);

    return (
        <div className="h-full flex flex-col animate-fade-in">
            {/* Header */}
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-slate-800 tracking-tight">Logística y Pedidos</h2>
                    <p className="text-sm text-slate-500">Seguimiento en tiempo real de ventas y envíos.</p>
                </div>
                <div className="flex gap-3">
                    <button className="px-4 py-2 bg-white border border-slate-300 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50 transition shadow-sm">
                        Actualizar Datos
                    </button>
                    <button className="px-4 py-2 bg-slate-900 text-white rounded-md text-sm font-medium shadow-sm hover:bg-slate-800 transition">
                        Exportar CSV
                    </button>
                </div>
            </div>

            {/* Table Container */}
            <div className="flex-1 bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                <div className="overflow-x-auto custom-scrollbar flex-1">
                    <table className="w-full text-left border-collapse">
                        <thead className="bg-slate-50 border-b border-slate-200">
                            <tr className="text-xs uppercase tracking-wider text-slate-500 font-bold">
                                <th className="px-6 py-4">Fecha</th>
                                <th className="px-6 py-4">Cliente</th>
                                <th className="px-6 py-4">Producto / Plan</th>
                                <th className="px-6 py-4 text-right">Monto</th>
                                <th className="px-6 py-4 text-center">Estado</th>
                                <th className="px-6 py-4 text-right">Acciones</th>
                            </tr>
                        </thead>
                        <tbody className="text-sm text-slate-600 divide-y divide-slate-100">
                            {loading ? (
                                <tr><td colSpan="6" className="text-center py-10 opacity-50">Cargando pedidos...</td></tr>
                            ) : orders.length === 0 ? (
                                <tr><td colSpan="6" className="text-center py-10 opacity-50">No se encontró base de datos de pedidos.</td></tr>
                            ) : (
                                orders.map(order => (
                                    <tr key={order.id} className="hover:bg-slate-50 transition-colors group">
                                        <td className="px-6 py-4 font-mono text-xs opacity-70">
                                            {new Date(order.createdAt).toLocaleDateString()}
                                        </td>
                                        <td className="px-6 py-4 font-medium text-slate-800">
                                            {order.nombre || 'Desconocido'}
                                            <div className="text-xs text-slate-400 font-normal">{order.cliente}</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className="px-2 py-1 rounded bg-slate-100 text-slate-600 text-xs font-semibold border border-slate-200">
                                                {order.producto}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right font-mono text-slate-800 font-bold">
                                            ${order.precio}
                                        </td>
                                        <td className="px-6 py-4 text-center">
                                            <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide border ${order.status === 'Pendiente' ? 'bg-amber-50 text-amber-600 border-amber-200' :
                                                order.status === 'Enviado' ? 'bg-blue-50 text-blue-600 border-blue-200' :
                                                    'bg-emerald-50 text-emerald-600 border-emerald-200'
                                                }`}>
                                                {order.status}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button className="text-slate-400 hover:text-blue-600 transition font-medium text-xs">Editar</button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Pagination */}
                <div className="px-6 py-4 border-t border-slate-200 flex justify-between items-center text-xs text-slate-500 bg-slate-50/50">
                    <span>Mostrando {orders.length} registros</span>
                    <div className="flex gap-2">
                        <button className="px-3 py-1 bg-white border border-slate-300 rounded hover:bg-slate-50">Anterior</button>
                        <button className="px-3 py-1 bg-white border border-slate-300 rounded hover:bg-slate-50">Siguiente</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SalesView;
