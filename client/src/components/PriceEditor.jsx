import React, { useState, useEffect, useId } from 'react';
import { DollarSign, Settings } from 'lucide-react';
import api from '../config/axios';

const LABEL_CLS = 'block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1 uppercase tracking-wide';
const INPUT_CLS = 'w-full pl-7 pr-3 py-2 border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 rounded-md focus:ring-2 focus:ring-success-500 focus:border-transparent outline-none transition-shadow';
const PREFIX_CLS = 'absolute left-3 top-2 text-slate-500 dark:text-slate-400';
const HINT_CLS = 'text-[11px] text-slate-500 dark:text-slate-400 mt-1';

const PriceEditor = () => {
    const [prices, setPrices] = useState(null);
    const [loading, setLoading] = useState(true);
    const [message, setMessage] = useState('');
    // Base de los id de los campos: cada <label> apunta a su <input>.
    const uid = useId();

    useEffect(() => {
        fetchPrices();
    }, []);

    const fetchPrices = async () => {
        setLoading(true);
        try {
            const { data } = await api.get('/api/prices');

            // Ensure Config Defaults
            if (!data.costoLogistico) data.costoLogistico = '18.000';

            setPrices(data || {});
            setMessage('');
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
            await api.post('/api/prices', prices);
            setMessage('✅ Precios actualizados correctamente.');
            setTimeout(() => setMessage(''), 3000);
        } catch (e) {
            console.error(e);
            const status = e.response?.status;
            if (status === 403) {
                setMessage('❌ Solo un admin puede modificar los precios.');
            } else {
                setMessage('❌ Error al guardar.');
            }
        }
    };

    if (loading) return <div className="text-sm text-slate-500 dark:text-slate-400">Cargando precios...</div>;

    const isError = message.includes('Error') || message.startsWith('❌');

    return (
        <div className="bg-transparent p-1 sm:p-6 h-full transition-colors duration-300">
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-6 flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-success-500" aria-hidden="true" /> Editor de Precios
            </h2>

            <div className="space-y-6">
                {!prices || Object.keys(prices).length === 0 ? (
                    <div className="text-center py-8 text-slate-500 dark:text-slate-400">
                        <p>No se pudieron cargar los precios.</p>
                        <button type="button" onClick={fetchPrices} className="mt-2 min-h-[40px] px-2 text-success-700 dark:text-success-500 underline hover:text-success-900 dark:hover:text-success-100">Reintentar</button>
                    </div>
                ) : (
                    <>
                        {/* Render Products (nested objects) */}
                        {Object.entries(prices)
                            .filter(([_, value]) => typeof value === 'object' && value !== null)
                            .map(([product, plans], pIdx) => (
                                <div key={product} className="pb-4 border-b border-slate-100 dark:border-slate-700 last:border-0">
                                    <h3 className="text-success-700 dark:text-success-500 font-semibold mb-3">{product}</h3>
                                    <div className="grid grid-cols-2 gap-4">
                                        {Object.keys(plans).map((plan, planIdx) => {
                                            const fieldId = `${uid}-p${pIdx}-${planIdx}`;
                                            return (
                                                <div key={plan}>
                                                    <label htmlFor={fieldId} className={LABEL_CLS}>
                                                        Plan {plan} días
                                                        <span className="sr-only"> — {product}</span>
                                                    </label>
                                                    <div className="relative">
                                                        <span className={PREFIX_CLS} aria-hidden="true">$</span>
                                                        <input
                                                            id={fieldId}
                                                            type="text"
                                                            className={INPUT_CLS}
                                                            value={plans[plan]}
                                                            onChange={(e) => handleChange(product, plan, e.target.value)}
                                                        />
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}

                        {/* Render Global Config (Strings) */}
                        <div className="pt-6 mt-2 border-t border-slate-200 dark:border-slate-700">
                            <h3 className="text-slate-800 dark:text-slate-100 font-bold mb-4 flex items-center gap-2">
                                <Settings className="w-5 h-5 text-success-500" aria-hidden="true" /> Configuración Adicional
                            </h3>
                            <div className="grid grid-cols-1 gap-4">
                                {/* Costo Logístico */}
                                <div>
                                    <label htmlFor={`${uid}-logistico`} className={LABEL_CLS}>
                                        Costo Logístico (Multa)
                                    </label>
                                    <div className="relative">
                                        <span className={PREFIX_CLS} aria-hidden="true">$</span>
                                        <input
                                            id={`${uid}-logistico`}
                                            aria-describedby={`${uid}-logistico-hint`}
                                            type="text"
                                            className={INPUT_CLS}
                                            value={prices.costoLogistico || ''}
                                            onChange={(e) => setPrices(prev => ({ ...prev, costoLogistico: e.target.value }))}
                                            placeholder="18.000"
                                        />
                                    </div>
                                    <p id={`${uid}-logistico-hint`} className={HINT_CLS}>Costo por rechazo o no retiro.</p>
                                </div>
                                {/* Precio promo del plan 60 (pestaña Promos). Solo rige en los chats que recibieron la promo. */}
                                <div>
                                    <label htmlFor={`${uid}-promo60`} className={LABEL_CLS}>
                                        Precio promo — plan 60 días
                                    </label>
                                    <div className="relative">
                                        <span className={PREFIX_CLS} aria-hidden="true">$</span>
                                        <input
                                            id={`${uid}-promo60`}
                                            aria-describedby={`${uid}-promo60-hint`}
                                            type="text"
                                            className={INPUT_CLS}
                                            value={prices.promoPrice60 || ''}
                                            onChange={(e) => setPrices(prev => ({ ...prev, promoPrice60: e.target.value }))}
                                            placeholder="44.900"
                                        />
                                    </div>
                                    <p id={`${uid}-promo60-hint`} className={HINT_CLS}>Lo usan las campañas de Promos. Cápsulas y gotas bajan a este precio; semillas sigue con el de lista si es más bajo.</p>
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>

            <div className="mt-6 flex justify-between items-center gap-3 pt-4 border-t border-slate-100 dark:border-slate-700">
                <span role="status" className={`text-sm font-medium ${isError ? 'text-danger-600 dark:text-danger-500' : 'text-success-700 dark:text-success-500'}`}>
                    {message}
                </span>
                <button
                    type="button"
                    onClick={savePrices}
                    className="flex-shrink-0 bg-success-700 hover:bg-success-800 text-white px-6 py-2 rounded-md font-medium transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-success-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
                >
                    Guardar Cambios
                </button>
            </div>
        </div>
    );
};

export default PriceEditor;
