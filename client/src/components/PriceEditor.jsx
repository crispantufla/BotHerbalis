import React, { useState, useEffect } from 'react';
import { API_URL } from '../config/api';

const PriceEditor = () => {
    const [prices, setPrices] = useState(null);
    const [loading, setLoading] = useState(true);
    const [message, setMessage] = useState('');

    useEffect(() => {
        fetchPrices();
    }, []);

    const fetchPrices = async () => {
        setLoading(true);
        try {
            const res = await fetch(`${API_URL}/api/prices`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setPrices(data || {});
        } catch (e) {
            console.error(e);
            setMessage('Error cargando precios. Revisa la conexión.');
            setPrices({}); // Fallback to avoid crash
        } finally {
            setLoading(false);
        }
    };

    const handleChange = (product, plan, value) => {
        setPrices(prev => ({
            ...prev,
            [product]: {
                ...prev[product],
                [plan]: value
            }
        }));
    };

    const savePrices = async () => {
        try {
            setMessage('Guardando...');
            const res = await fetch(`${API_URL}/api/prices`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': import.meta.env.VITE_API_KEY || 'herbalis_secret_key_123'
                },
                body: JSON.stringify(prices)
            });
            if (res.ok) {
                setMessage('✅ Precios actualizados correctamente.');
                setTimeout(() => setMessage(''), 3000);
            } else {
                setMessage('❌ Error al guardar.');
            }
        } catch (e) {
            console.error(e);
            setMessage('❌ Error de red.');
        }
    };

    if (loading) return <div>Cargando precios...</div>;

    return (
        <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200 h-full">
            <h2 className="text-xl font-bold text-slate-800 mb-6 flex items-center gap-2">
                <span className="text-emerald-500">💰</span> Editor de Precios
            </h2>

            <div className="space-y-6">
                {!prices || Object.keys(prices).length === 0 ? (
                    <div className="text-center py-8 text-slate-400">
                        <p>No se pudieron cargar los precios.</p>
                        <button onClick={fetchPrices} className="mt-2 text-emerald-600 underline">Reintentar</button>
                    </div>
                ) : (
                    Object.keys(prices).map(product => (
                        <div key={product} className="pb-4 border-b border-slate-100 last:border-0">
                            <h3 className="text-emerald-600 font-semibold mb-3">{product}</h3>
                            <div className="grid grid-cols-2 gap-4">
                                {Object.keys(prices[product]).map(plan => (
                                    <div key={plan}>
                                        <label className="block text-xs font-bold text-slate-500 mb-1 uppercase tracking-wide">
                                            Plan {plan} días
                                        </label>
                                        <div className="relative">
                                            <span className="absolute left-3 top-2 text-slate-400">$</span>
                                            <input
                                                type="text"
                                                className="w-full pl-7 pr-3 py-2 border border-slate-300 rounded-md focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none transition-all"
                                                value={prices[product][plan]}
                                                onChange={(e) => handleChange(product, plan, e.target.value)}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))
                )}
            </div>

            <div className="mt-6 flex justify-between items-center pt-4 border-t border-slate-100">
                <span className={`text-sm font-medium ${message.includes('Error') ? 'text-red-500' : 'text-emerald-600'}`}>
                    {message}
                </span>
                <button
                    onClick={savePrices}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2 rounded-md font-medium transition-colors shadow-sm"
                >
                    Guardar Cambios
                </button>
            </div>
        </div>
    );
};

export default PriceEditor;
