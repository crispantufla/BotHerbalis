import React, { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';

/**
 * Modal de entrada manual de datos de envío.
 * Aparece cuando POST /orders/manual-complete devuelve 422 con
 * needsManualEntry=true. Pre-rellena con lo que el AI logró extraer
 * (response.data.extracted) y deja al admin completar los campos
 * faltantes antes de re-enviar la orden.
 */
const ManualOrderEntryModal = ({ open, prefill = {}, chatId, onClose, onSubmit, submitting = false }) => {
    const [data, setData] = useState({
        nombre: '', calle: '', ciudad: '', provincia: '', cp: ''
    });

    useEffect(() => {
        if (open) {
            setData({
                nombre: prefill.nombre || '',
                calle: prefill.calle || '',
                ciudad: prefill.ciudad || '',
                provincia: prefill.provincia || '',
                cp: prefill.cp || ''
            });
        }
    }, [open, prefill]);

    if (!open) return null;

    const isValid = data.nombre.trim() && data.calle.trim() && data.ciudad.trim();

    const handleField = (key, value) => setData(prev => ({ ...prev, [key]: value }));

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!isValid || submitting) return;
        onSubmit({
            nombre: data.nombre.trim(),
            calle: data.calle.trim(),
            ciudad: data.ciudad.trim(),
            provincia: data.provincia.trim() || null,
            cp: data.cp.trim() || null,
        });
    };

    return (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md p-6 relative" onClick={e => e.stopPropagation()}>
                <button onClick={onClose} className="absolute top-3 right-3 p-1.5 text-slate-400 hover:text-rose-500 transition-colors" disabled={submitting}>
                    <X className="w-5 h-5" />
                </button>

                <div className="mb-4">
                    <h3 className="text-lg font-extrabold text-slate-800 dark:text-slate-100">Datos de envío</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        El bot no pudo extraer los datos automáticamente. Completá lo que falte para registrar el pedido.
                        {chatId && <span className="block mt-1 font-mono text-[11px] text-slate-400">+{chatId.split('@')[0]}</span>}
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-3">
                    <Field label="Nombre y apellido *" value={data.nombre} onChange={v => handleField('nombre', v)} placeholder="María Pérez" />
                    <Field label="Calle y número *" value={data.calle} onChange={v => handleField('calle', v)} placeholder="Av. Belgrano 1234" />
                    <div className="grid grid-cols-2 gap-3">
                        <Field label="Ciudad *" value={data.ciudad} onChange={v => handleField('ciudad', v)} placeholder="Rosario" />
                        <Field label="CP" value={data.cp} onChange={v => handleField('cp', v)} placeholder="2000" />
                    </div>
                    <Field label="Provincia" value={data.provincia} onChange={v => handleField('provincia', v)} placeholder="Santa Fe" />

                    <div className="flex gap-2 pt-3">
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={submitting}
                            className="flex-1 px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold text-sm hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50"
                        >
                            Cancelar
                        </button>
                        <button
                            type="submit"
                            disabled={!isValid || submitting}
                            className="flex-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold text-sm shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                        >
                            {submitting ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white/50 border-t-white rounded-full animate-spin"></div>
                                    Guardando...
                                </>
                            ) : (
                                <>
                                    <Save className="w-4 h-4" />
                                    Guardar pedido
                                </>
                            )}
                        </button>
                    </div>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 text-center">* obligatorios</p>
                </form>
            </div>
        </div>
    );
};

const Field = ({ label, value, onChange, placeholder }) => (
    <div>
        <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">{label}</label>
        <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder}
            className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-300 transition-all placeholder:text-slate-400"
        />
    </div>
);

export default ManualOrderEntryModal;
