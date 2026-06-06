import React, { useState, useEffect } from 'react';
import { X, Save, Home, Store, CreditCard, Banknote, Send } from 'lucide-react';

/**
 * Modal de verificación / carga de pedido.
 * Se abre SIEMPRE que el admin aprieta "Pedido ingresado" o "Solo registrar"
 * (el backend devuelve un `preview` con lo detectado: datos + tipo de envío +
 * medio de pago + producto). El admin verifica/ajusta y recién al confirmar se
 * crea la orden.
 *
 * Reglas de negocio (acopladas):
 *   - Envío a DOMICILIO  → pago: Mercado Pago o Transferencia. Pide dirección completa.
 *   - Retiro en SUCURSAL → pago: Efectivo al retirar. Pide solo Ciudad + CP.
 *   (Nombre y apellido se pide siempre — la orden lo necesita.)
 */
const PAY_OPTIONS = {
    domicilio: [
        { value: 'mercadopago', label: 'Mercado Pago', icon: CreditCard },
        { value: 'transferencia', label: 'Transferencia', icon: Banknote },
    ],
    sucursal: [
        { value: 'contrarembolso', label: 'Efectivo al retirar', icon: Banknote },
    ],
};

const ManualOrderEntryModal = ({ open, prefill = {}, chatId, silent = false, onClose, onSubmit, submitting = false }) => {
    const [data, setData] = useState({
        nombre: '', calle: '', ciudad: '', provincia: '', cp: '',
        shippingType: 'domicilio', paymentMethod: 'mercadopago',
    });

    useEffect(() => {
        if (!open) return;
        const shippingType = prefill.shippingType === 'sucursal' ? 'sucursal' : 'domicilio';
        const allowedPayments = PAY_OPTIONS[shippingType].map(o => o.value);
        const paymentMethod = allowedPayments.includes(prefill.paymentMethod)
            ? prefill.paymentMethod
            : allowedPayments[0];
        setData({
            nombre: prefill.nombre || '',
            calle: prefill.calle || '',
            ciudad: prefill.ciudad || '',
            provincia: prefill.provincia || '',
            cp: prefill.cp || '',
            shippingType,
            paymentMethod,
        });
    }, [open, prefill]);

    if (!open) return null;

    const isSucursal = data.shippingType === 'sucursal';

    // Al cambiar el tipo de envío, re-encuadramos el medio de pago a uno válido.
    const setShipping = (shippingType) => {
        setData(prev => {
            const allowed = PAY_OPTIONS[shippingType].map(o => o.value);
            const paymentMethod = allowed.includes(prev.paymentMethod) ? prev.paymentMethod : allowed[0];
            return { ...prev, shippingType, paymentMethod };
        });
    };

    const handleField = (key, value) => setData(prev => ({ ...prev, [key]: value }));

    // Validación según tipo de envío.
    const isValid = isSucursal
        ? (data.nombre.trim() && data.ciudad.trim() && data.cp.trim())
        : (data.nombre.trim() && data.calle.trim() && data.ciudad.trim());

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!isValid || submitting) return;
        const manualAddr = isSucursal
            ? {
                nombre: data.nombre.trim(),
                ciudad: data.ciudad.trim(),
                cp: data.cp.trim() || null,
                // calle se omite: el backend la setea como "A sucursal".
            }
            : {
                nombre: data.nombre.trim(),
                calle: data.calle.trim(),
                ciudad: data.ciudad.trim(),
                provincia: data.provincia.trim() || null,
                cp: data.cp.trim() || null,
            };
        onSubmit({ manualAddr, shippingType: data.shippingType, paymentMethod: data.paymentMethod });
    };

    const totalFmt = prefill.total
        ? Number(prefill.total).toLocaleString('es-AR')
        : null;

    return (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md p-6 relative max-h-[92vh] overflow-y-auto custom-scrollbar" onClick={e => e.stopPropagation()}>
                <button onClick={onClose} className="absolute top-3 right-3 p-1.5 text-slate-400 hover:text-rose-500 transition-colors" disabled={submitting}>
                    <X className="w-5 h-5" />
                </button>

                <div className="mb-4">
                    <h3 className="text-lg font-extrabold text-slate-800 dark:text-slate-100">Verificar pedido</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Revisá los datos antes de confirmar. Ajustá lo que haga falta.
                        {chatId && <span className="block mt-1 font-mono text-[11px] text-slate-400">+{chatId.split('@')[0]}</span>}
                    </p>
                </div>

                {/* Producto / total detectados (solo lectura) */}
                {(prefill.product || totalFmt) && (
                    <div className="mb-4 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{prefill.product || 'Producto'}</span>
                        {totalFmt && <span className="text-sm font-extrabold text-emerald-600 dark:text-emerald-400">${totalFmt}</span>}
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                    {/* Tipo de envío */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Tipo de envío</label>
                        <div className="grid grid-cols-2 gap-2">
                            <SelectorButton active={!isSucursal} icon={Home} label="A domicilio" onClick={() => setShipping('domicilio')} disabled={submitting} />
                            <SelectorButton active={isSucursal} icon={Store} label="Retiro en sucursal" onClick={() => setShipping('sucursal')} disabled={submitting} />
                        </div>
                    </div>

                    {/* Método de pago (acoplado al envío) */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Método de pago</label>
                        <div className={`grid gap-2 ${PAY_OPTIONS[data.shippingType].length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                            {PAY_OPTIONS[data.shippingType].map(opt => (
                                <SelectorButton
                                    key={opt.value}
                                    active={data.paymentMethod === opt.value}
                                    icon={opt.icon}
                                    label={opt.label}
                                    onClick={() => handleField('paymentMethod', opt.value)}
                                    disabled={submitting}
                                />
                            ))}
                        </div>
                        {isSucursal && (
                            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5">Paga el total en efectivo al retirar en la sucursal.</p>
                        )}
                    </div>

                    {/* Datos */}
                    <div className="space-y-3 pt-1">
                        <Field label="Nombre y apellido *" value={data.nombre} onChange={v => handleField('nombre', v)} placeholder="María Pérez" />

                        {!isSucursal && (
                            <Field label="Calle y número *" value={data.calle} onChange={v => handleField('calle', v)} placeholder="Av. Belgrano 1234" />
                        )}

                        <div className="grid grid-cols-2 gap-3">
                            <Field label={isSucursal ? 'Ciudad *' : 'Ciudad *'} value={data.ciudad} onChange={v => handleField('ciudad', v)} placeholder="Rosario" />
                            <Field label={isSucursal ? 'CP *' : 'CP'} value={data.cp} onChange={v => handleField('cp', v)} placeholder="2000" />
                        </div>

                        {!isSucursal && (
                            <Field label="Provincia" value={data.provincia} onChange={v => handleField('provincia', v)} placeholder="Santa Fe" />
                        )}

                        {isSucursal && (
                            <p className="text-[11px] text-slate-400 dark:text-slate-500">
                                Con la ciudad y el CP, el Correo asigna la sucursal más cercana. No hace falta la calle.
                            </p>
                        )}
                    </div>

                    <div className="flex gap-2 pt-2">
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
                            ) : silent ? (
                                <>
                                    <Save className="w-4 h-4" />
                                    Registrar pedido
                                </>
                            ) : (
                                <>
                                    <Send className="w-4 h-4" />
                                    Confirmar y enviar
                                </>
                            )}
                        </button>
                    </div>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 text-center">
                        {silent ? 'Se registra la venta sin enviar mensaje al cliente.' : 'Se envía la confirmación al cliente.'} · * obligatorios
                    </p>
                </form>
            </div>
        </div>
    );
};

const SelectorButton = ({ active, icon: Icon, label, onClick, disabled }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-bold transition-all disabled:opacity-50 ${
            active
                ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 ring-2 ring-indigo-500/20'
                : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600'
        }`}
    >
        {Icon && <Icon className="w-4 h-4" />}
        <span>{label}</span>
    </button>
);

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
