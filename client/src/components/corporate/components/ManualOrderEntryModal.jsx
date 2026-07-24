import React, { useState, useEffect } from 'react';
import { X, Save, Home, Store, CreditCard, Banknote, Send, Pill, Droplet, Leaf } from 'lucide-react';

/**
 * Modal de verificación / carga de pedido.
 * Se abre SIEMPRE que el admin aprieta "Pedido ingresado" o "Solo registrar"
 * (el backend devuelve un `preview` con lo detectado: datos + tipo de envío +
 * medio de pago + producto). El admin verifica/ajusta y recién al confirmar se
 * crea la orden.
 *
 * Reglas de negocio (acopladas):
 *   - Envío a DOMICILIO  → pago: Mercado Pago o Transferencia. Pide dirección completa.
 *   - Retiro en SUCURSAL → pago: Efectivo al retirar. Pide ciudad + CP + provincia.
 *   (Nombre y apellido se pide siempre — la orden lo necesita.)
 *   - Si el bot NO detectó el producto, el admin lo elige (producto + plan) y el
 *     precio sale de la lista oficial.
 *   - Descuento opcional: resta al total final.
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
const fmt = (n) => Number(n || 0).toLocaleString('es-AR');

const ManualOrderEntryModal = ({ open, prefill = {}, chatId, silent = false, onClose, onSubmit, submitting = false }) => {
    const [data, setData] = useState({
        nombre: '', calle: '', ciudad: '', provincia: '', cp: '',
        shippingType: 'domicilio', paymentMethod: 'mercadopago',
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
                // Si el cambio de envío cambió el método, el tilde de verificación
                // ya no aplica — resetear para que no quede marcado en silencio.
                paymentVerified: paymentMethod === prev.paymentMethod ? prev.paymentVerified : false,
            };
        });
    };

    const handleField = (key, value) => setData(prev => (
        // Cambiar de método de pago invalida la verificación previa: sin este
        // reset, transferencia→MP→transferencia dejaba el checkbox tildado.
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
                                <p className="text-[11px] text-amber-600 dark:text-amber-400 mb-1.5">El bot no detectó el producto — elegilo:</p>
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
                        {data.paymentMethod === 'transferencia' && (
                            <label className={`mt-2 flex items-start gap-2.5 px-3 py-2.5 rounded-xl border cursor-pointer transition-all ${
                                data.paymentVerified
                                    ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20'
                                    : 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/15'
                            }`}>
                                <input
                                    type="checkbox"
                                    checked={data.paymentVerified}
                                    onChange={e => handleField('paymentVerified', e.target.checked)}
                                    disabled={submitting}
                                    className="mt-0.5 w-4 h-4 accent-emerald-600 flex-shrink-0"
                                />
                                <span className="text-xs leading-snug">
                                    <span className={`font-bold block ${data.paymentVerified ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
                                        {data.paymentVerified ? 'Transferencia verificada ✓' : 'Transferencia SIN verificar'}
                                    </span>
                                    <span className="text-slate-500 dark:text-slate-400">
                                        Marcalo solo si ya viste el comprobante y la plata está acreditada.
                                    </span>
                                </span>
                            </label>
                        )}
                    </div>

                    {/* Datos */}
                    <div className="space-y-3 pt-1">
                        <Field label="Nombre y apellido *" value={data.nombre} onChange={v => handleField('nombre', v)} placeholder="María Pérez" />

                        {!isSucursal && (
                            <Field label="Calle y número *" value={data.calle} onChange={v => handleField('calle', v)} placeholder="Av. Belgrano 1234" />
                        )}

                        <div className="grid grid-cols-2 gap-3">
                            <Field label="Ciudad *" value={data.ciudad} onChange={v => handleField('ciudad', v)} placeholder="Rosario" />
                            <Field label={isSucursal ? 'CP *' : 'CP'} value={data.cp} onChange={v => handleField('cp', v)} placeholder="2000" />
                        </div>

                        <Field label="Provincia" value={data.provincia} onChange={v => handleField('provincia', v)} placeholder="Santa Fe" />

                        {isSucursal && (
                            <p className="text-[11px] text-slate-400 dark:text-slate-500">
                                Con la ciudad y el CP, el Correo asigna la sucursal más cercana. No hace falta la calle.
                            </p>
                        )}
                    </div>

                    {/* Totales + descuento */}
                    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-3 space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-500 dark:text-slate-400">Subtotal</span>
                            <span className="font-semibold text-slate-700 dark:text-slate-200">{baseTotal ? `$${fmt(baseTotal)}` : '—'}</span>
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
                                    className="w-full pl-6 pr-2 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-right text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-300"
                                />
                            </div>
                        </div>
                        <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-700 pt-2">
                            <span className="text-sm font-bold text-slate-700 dark:text-slate-200">Total final</span>
                            <span className="text-base font-extrabold text-emerald-600 dark:text-emerald-400">{baseTotal ? `$${fmt(finalTotal)}` : '—'}</span>
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
