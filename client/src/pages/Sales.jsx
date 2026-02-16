import React, { useState, useEffect } from 'react';
import axios from 'axios';

const Sales = () => {
    const [orders, setOrders] = useState([]);
    const API_URL = 'http://localhost:3001';

    useEffect(() => {
        fetchOrders();
    }, []);

    const fetchOrders = async () => {
        try {
            const res = await axios.get(`${API_URL}/api/orders`);
            setOrders(res.data.reverse()); // Show new first
        } catch (e) { console.error(e); }
    };

    return (
        <div className="space-y-6">
            <h2 className="text-2xl font-bold text-gray-800">Ventas y Pedidos</h2>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-gray-50 border-b">
                            <tr>
                                <th className="p-4 font-semibold text-gray-600">Fecha</th>
                                <th className="p-4 font-semibold text-gray-600">Cliente</th>
                                <th className="p-4 font-semibold text-gray-600">Producto/Plan</th>
                                <th className="p-4 font-semibold text-gray-600">Precio</th>
                                <th className="p-4 font-semibold text-gray-600">Estado</th>
                                <th className="p-4 font-semibold text-gray-600">Dirección</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {orders.length === 0 ? (
                                <tr>
                                    <td colSpan="6" className="p-8 text-center text-gray-400">No hay pedidos registrados aún.</td>
                                </tr>
                            ) : (
                                orders.map(order => (
                                    <tr key={order.id} className="hover:bg-gray-50 transition">
                                        <td className="p-4 text-gray-500 whitespace-nowrap">
                                            {new Date(order.createdAt).toLocaleDateString()}
                                        </td>
                                        <td className="p-4 font-medium text-gray-800">
                                            {order.nombre}<br />
                                            <span className="text-xs text-gray-400">{order.cliente}</span>
                                        </td>
                                        <td className="p-4 text-gray-600">
                                            {order.producto}<br />
                                            <span className="text-xs text-blue-500">{order.plan}</span>
                                        </td>
                                        <td className="p-4 text-gray-800 font-bold">${order.precio}</td>
                                        <td className="p-4">
                                            <span className={`px-2 py-1 rounded-full text-xs font-bold ${order.status === 'Enviado' ? 'bg-blue-100 text-blue-700' :
                                                    order.status === 'Entregado' ? 'bg-green-100 text-green-700' :
                                                        'bg-yellow-100 text-yellow-700'
                                                }`}>
                                                {order.status}
                                            </span>
                                        </td>
                                        <td className="p-4 text-gray-500 max-w-xs truncate">
                                            {order.calle}, {order.ciudad} ({order.cp})
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default Sales;
