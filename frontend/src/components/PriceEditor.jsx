import React, { useState, useEffect } from 'react';

const PriceEditor = () => {
    const [prices, setPrices] = useState(null);
    const [loading, setLoading] = useState(true);
    const [message, setMessage] = useState('');

    useEffect(() => {
        fetchPrices();
    }, []);

    const fetchPrices = async () => {
        try {
            const res = await fetch('http://localhost:3000/api/prices');
            const data = await res.json();
            setPrices(data);
            setLoading(false);
        } catch (e) {
            console.error(e);
            setMessage('Error cargando precios.');
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
            const res = await fetch('http://localhost:3000/api/prices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
        <div style={{ padding: '20px', maxWidth: '600px', background: '#fff', borderRadius: '8px', boxShadow: '0 2px 5px rgba(0,0,0,0.1)' }}>
            <h2 style={{ marginBottom: '20px', color: '#333' }}>💰 Editor de Precios</h2>

            {Object.keys(prices).map(product => (
                <div key={product} style={{ marginBottom: '20px', paddingBottom: '15px', borderBottom: '1px solid #eee' }}>
                    <h3 style={{ color: '#25D366', marginBottom: '10px' }}>{product}</h3>
                    <div style={{ display: 'flex', gap: '20px' }}>
                        {Object.keys(prices[product]).map(plan => (
                            <div key={plan} style={{ flex: 1 }}>
                                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '14px' }}>
                                    Plan {plan} días
                                </label>
                                <div style={{ display: 'flex', alignItems: 'center' }}>
                                    <span style={{ marginRight: '5px', color: '#666' }}>$</span>
                                    <input
                                        type="text"
                                        value={prices[product][plan]}
                                        onChange={(e) => handleChange(product, plan, e.target.value)}
                                        style={{
                                            width: '100%',
                                            padding: '8px',
                                            borderRadius: '4px',
                                            border: '1px solid #ddd',
                                            fontSize: '16px'
                                        }}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ))}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px' }}>
                <span style={{ color: message.includes('Error') ? 'red' : 'green', fontWeight: 'bold' }}>
                    {message}
                </span>
                <button
                    onClick={savePrices}
                    style={{
                        padding: '10px 25px',
                        background: '#25D366',
                        color: 'white',
                        border: 'none',
                        borderRadius: '5px',
                        cursor: 'pointer',
                        fontSize: '16px',
                        fontWeight: 'bold'
                    }}
                >
                    Guardar Cambios
                </button>
            </div>
        </div>
    );
};

export default PriceEditor;
