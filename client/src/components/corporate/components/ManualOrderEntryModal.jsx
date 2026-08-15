import React, { useState, useEffect } from 'react';
import { X, Save, Home, Store, Banknote, Send, Pill, Droplet, Leaf } from 'lucide-react';
import { formatEUR } from '../../../utils/format';

/**
 * Modal de verificación / carga de pedido.
 * Se abre SIEMPRE que el admin aprieta "Pedido ingresado" o "Solo registrar"
 * (el backend devuelve un `preview` con lo detectado: datos + tipo de envío +
 * medio de pago + producto). El admin verifica/ajusta y recién al confirmar se
 * crea la orden.
 *
 * Reglas de negocio (acopladas):
 *   - Envío a CASA               → contra reembolso: paga al repartidor. Pide dirección completa.
 *   - Recogida en OFICINA        → contra reembolso: paga al recogerlo. Pide ciudad + CP + provincia.
 *   En España no hay pago por adelantado: no existe tarjeta, link de pago,
 *   transferencia ni anticipo, así que las dos modalidades comparten el mismo
 *   `paymentMethod` ('contrarembolso') y solo cambia dónde se cobra.
 *   (Nombre y apellidos se piden siempre — la orden lo necesita.)
 *   - Si el bot NO detectó el producto, el admin lo elige (producto + plan) y el
 *     precio sale de la lista oficial.
 *   - Descuento opcional: resta al total final.
 */
// Las claves ('domicilio' / 'sucursal') y los `value` viajan al backend tal
// cual — no se tocan. Lo que cambia respecto al bot argentino es la oferta:
// aquí solo hay contra reembolso, y la única diferencia entre las dos es el
// momento del cobro (al repartidor o en la oficina de Correos).
const PAY_OPTIONS = {
    domicilio: [
        { value: 'contrarembolso', label: 'Contra reembolso (al repartidor)', icon: Banknote },
    ],
    sucursal: [
        { value: 'contrarembolso', label: 'Contra reembolso (al recogerlo)', icon: Banknote },
    ],
};

const PRODUCT_OPTIONS = [
    { value: 'Cápsulas', label: 'Cápsulas', icon: Pill },
    { value: 'Gotas', label: 'Gotas', icon: Droplet },
    { value: 'Semillas', label: 'Semillas', icon: Leaf },
];

const PLAN_OPTIONS = [
    { value: '60', label: '60 días' },
    { value: '120', label: '120 días' },
];

const onlyDigits = (s) => (s || '').toString().replace(/\D/g, '');
const fmt = (n) => formatEUR(n);

const ManualOrderEntryModal = ({ open, prefill = {}, chatId, silent = false, onClose, onSubmit, submitting = false }) => {
    const [data, setData] = useState({
        nombre: '', calle: '', ciudad: '', provincia: '', cp: '',
        shippingType: 'domicilio', paymentMethod: 'contrarembolso',
        productType: '', plan: '60', discount: '',
        paymentVerified: false,
    });

    const productDetected = !!prefill.productDetected;
    const prices = prefill.prices || null;

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
            productType: '',
            plan: prefill.plan || '60',
            discount: '',
            paymentVerified: false,
        });
    }, [open, prefill]);

    if (!open) return null;

    const isSucursal = data.shippingType === 'sucursal';

    const setShipping = (shippingType) => {
        setData(prev => {
            const allowed = PAY_OPTIONS[shippingType].map(o => o.value);
            const paymentMethod = allowed.includes(prev.paymentMethod) ? prev.paymentMethod : allowed[0];
            return {
                ...prev,
                shippingType,
                paymentMethod,
                // Con contra reembolso no hay nada que verificar a mano (cobra
                // Correos), pero el campo sigue viajando al backend: lo dejamos
                // siempre en false salvo que el método no haya cambiado.
                paymentVerified: paymentMethod === prev.paymentMethod ? prev.paymentVerified : false,
            };
        });
    };

    const handleField = (key, value) => setData(prev => (
        // Cambiar de método de pago invalida cualquier verificación previa.
        key === 'paymentMethod'
            ? { ...prev, paymentMethod: value, paymentVerified: false }
            : { ...prev, [key]: value }
    ));

    // Subtotal: detectado (prefill.total) o calculado desde la lista de precios
    // cuando el admin elige producto+plan a mano.
    const liveTotalStr = (!productDetected && data.productType && prices && prices[data.productType])
        ? prices[data.productType][data.plan]
        : null;
    const baseTotal = liveTotalStr != null
        ? (parseInt(onlyDigits(liveTotalStr), 10) || 0)
        : (prefill.total ? Number(prefill.total) : 0);
    const discountNum = parseInt(onlyDigits(data.discount), 10) || 0;
    const finalTotal = Math.max(0, baseTotal - discountNum);

    // Validación según tipo de envío + producto.
    const addrValid = isSucursal
        ? (data.nombre.trim() && data.ciudad.trim() && data.cp.trim())
        : (data.nombre.trim() && data.calle.trim() && data.ciudad.trim());
    const productValid = productDetected || !!data.productType;
    const isValid = addrValid && productValid;

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!isValid || submitting) return;
        const manualAddr = isSucursal
            ? {
                nombre: data.nombre.trim(),
                ciudad: data.ciudad.trim(),
                provincia: data.provincia.trim() || null,
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
        onSubmit({
            manualAddr,
            shippingType: data.shippingType,
            paymentMethod: data.paymentMethod,
            discount: discountNum,
            paymentVerified: data.paymentMethod === 'transferencia' && data.paymentVerified,
            ...(productDetected ? {} : { productType: data.productType, plan: data.plan }),
        });
    };

    return (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md p-6 relative max-h-[92vh] overflow-y-auto custom-scrollbar" onClick={e => e.stopPropagation()}>
                <button onClick={onClose} className="absolute top-3 right-3 p-1.5 text-slate-400 hover:text-danger-500 transition-colors" disabled={submitting}>
                    <X className="w-5 h-5" />
                </button>

                <div className="mb-4">
                    <h3 className="text-lg font-extrabold text-slate-800 dark:text-slate-100">Verificar pedido</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Revisa los datos antes de confirmar. Ajusta lo que haga falta.
                        {chatId && <span className="block mt-1 font-mono text-[11px] text-slate-400">+{chatId.split('@')[0]}</span>}
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    {/* Producto */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Producto</label>
                        {productDetected ? (
                            <div className="px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
                                <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{prefill.product}</span>
                            </div>
                        ) : (
                            <>
                                <p className="text-[11px] text-warning-600 dark:text-warning-400 mb-1.5">El bot no ha detectado el producto — elígelo:</p>
                                <div className="grid grid-cols-3 gap-2">
                                    {PRODUCT_OPTIONS.map(opt => (
                                        <SelectorButton
                                            key={opt.value}
                                            active={data.productType === opt.value}
                                            icon={opt.icon}
                                            label={opt.label}
                                            onClick={() => handleField('productType', opt.value)}
                                            disabled={submitting}
                                        />
                                    ))}
                                </div>
                                <div className="grid grid-cols-2 gap-2 mt-2">
                                    {PLAN_OPTIONS.map(opt => (
                                        <SelectorButton
                                            key={opt.value}
                                            active={data.plan === opt.value}
                                            label={opt.label}
                                            onClick={() => handleField('plan', opt.value)}
                                            disabled={submitting}
                                        />
                                    ))}
                                </div>
                            </>
                        )}
                    </div>

                    {/* Tipo de envío */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Cómo lo recibe</label>
                        <div className="grid grid-cols-2 gap-2">
                            <SelectorButton active={!isSucursal} icon={Home} label="En casa" onClick={() => setShipping('domicilio')} disabled={submitting} />
                            <SelectorButton active={isSucursal} icon={Store} label="Oficina de Correos" onClick={() => setShipping('sucursal')} disabled={submitting} />
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
                        <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
                            No se cobra nada por adelantado: el cliente paga el total al recibir el pedido.
                        </p>
                    </div>

                    {/* Datos */}
                    <div className="space-y-3 pt-1">
                        <Field label="Nombre y apellidos *" value={data.nombre} onChange={v => handleField('nombre', v)} placeholder="María García Ruiz" />

                        {!isSucursal && (
                            <Field label="Calle y número *" value={data.calle} onChange={v => handleField('calle', v)} placeholder="Calle Mayor 12, 3.º B" />
                        )}

                        <div className="grid grid-cols-2 gap-3">
                            <Field label="Ciudad *" value={data.ciudad} onChange={v => handleField('ciudad', v)} placeholder="Valencia" />
                            <Field label={isSucursal ? 'Código postal *' : 'Código postal'} value={data.cp} onChange={v => handleField('cp', v)} placeholder="46001" />
                        </div>

                        <Field label="Provincia" value={data.provincia} onChange={v => handleField('provincia', v)} placeholder="Valencia" />

                        {isSucursal && (
                            <p className="text-[11px] text-slate-400 dark:text-slate-500">
                                Con la ciudad y el código postal, Correos asigna la oficina que le corresponde. No hace falta la calle.
                            </p>
                        )}
                    </div>

                    {/* Totales + descuento */}
                    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-3 space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-500 dark:text-slate-400">Subtotal</span>
                            <span className="font-semibold text-slate-700 dark:text-slate-200">{baseTotal ? fmt(baseTotal) : '—'}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <label className="text-sm text-slate-500 dark:text-slate-400 whitespace-nowrap">Descuento</label>
                            <div className="relative w-32">
                                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    value={data.discount}
                                    onChange={e => handleField('discount', onlyDigits(e.target.value))}
                                    placeholder="0"
                                    className="w-full pl-6 pr-2 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-right text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent-500/30 focus:border-accent-300"
                                />
                            </div>
                        </div>
                        <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-700 pt-2">
                            <span className="text-sm font-bold text-slate-700 dark:text-slate-200">Total final</span>
                            <span className="text-base font-extrabold text-success-600 dark:text-success-400">{baseTotal ? fmt(finalTotal) : '—'}</span>
                        </div>
                    </div>

                    <div className="flex gap-2 pt-1">
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
                            className="flex-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-accent-600 to-accent-700 text-white font-bold text-sm shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
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
                ? 'border-accent-500 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300 ring-2 ring-accent-500/20'
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
            className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent-500/30 focus:border-accent-300 transition-all placeholder:text-slate-400"
        />
    </div>
);

export default ManualOrderEntryModal;
