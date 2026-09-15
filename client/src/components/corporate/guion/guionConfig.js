// Configuración de la vista de guiones: etiquetas, etapas del flujo y valores de
// ejemplo para los placeholders. Salió de GuionView.jsx.
import {
    MessageSquare, HelpCircle, Edit3, ShoppingBag, DollarSign, CreditCard, CheckCircle2, MessageCircle, Hand,
} from 'lucide-react';
import { BANK_ALIAS, BANK_HOLDER, fillPricePlaceholders } from '../../../utils/scriptPlaceholders';

export const SCRIPT_LABELS = {
    v7: { name: 'V8 · Elena · zona Rosario', tone: '2 tiers (≤10 kg → 60d, +10 kg → 120d). Persona Elena, tono argentino cálido. Tras elegir plan pregunta la localidad: Rosario y 60 km → reparto propio con pago al recibir; resto del país → Correo prepago (tarjeta o transferencia), a domicilio o sucursal.' },
};

export const SECTION_LABELS = {
    'flow.greeting': 'Saludo inicial',
    'flow.recommendation': 'Recomendación (genérica)',
    'flow.recommendation_1': 'Recomendación tier 1 (hasta 10 kg)',
    'flow.recommendation_2': 'Recomendación tier 2 (10 a 20 kg)',
    'flow.recommendation_3': 'Recomendación tier 3 (más de 20 kg)',
    'flow.prices_60': 'Precios tier 1 (auto, plan 60d)',
    'flow.prices_120': 'Precios tier 2 (auto, plan 120d)',
    'flow.prices': 'TEXTO 3 — Precios (legacy V5/V6)',
    'flow.preference_capsulas': 'Cliente elige cápsulas',
    'flow.preference_gotas': 'Cliente elige gotas',
    'flow.preference_semillas': 'Cliente elige semillas',
    'flow.closing': 'Cierre — pide datos de envío (domicilio, ya pagado)',
    'flow.closing_sucursal': 'Cierre — pide datos de sucursal (ya pagado)',
    'flow.payment_menu': 'TEXTO 4 — Menú de pago (pregunta la localidad)',
    'flow.zone_km': 'Zona: localidad desconocida → pregunta los km',
    'flow.zone_reask': 'Zona: no se entendió la localidad',
    'flow.zone_no_local': 'Zona: quiere venir a buscarlo (no hay local)',
    'flow.zone_in': 'Dentro de zona → reparto propio, pide nombre y calle',
    'flow.zone_out': 'Fuera de zona → Correo prepago, ¿casa o sucursal?',
    'flow.payment_domicilio_choice': 'Submenú: domicilio → tarjeta o transferencia',
    'flow.payment_sucursal_choice': 'Submenú: sucursal → tarjeta o transferencia',
    'flow.prepay_objection': 'Fuera de zona pide contrarreembolso (1ª vez)',
    'flow.prepay_refusal_close': 'Fuera de zona insiste → cierre + asesor',
    'flow.payment_mp_link_sucursal': 'TEXTO 5a — link de tarjeta (retiro en sucursal)',
    'flow.payment_transfer_alias': 'TEXTO 5b — Transferencia (alias)',
    'flow.payment_cod_retry': 'TEXTO 5c — Contra reembolso (modalidad)',
    'flow.payment_cod_anticipo': 'TEXTO 5d — Confirmación COD (anticipo)',
    'flow.payment_mp_link': 'TEXTO 5a — MercadoPago (link)',
    'flow.payment_mp_link_sena': 'Variante MP — link de seña (legacy)',
    'flow.payment_mp_failed': 'Mensaje cuando MP falla 2 veces',
    'flow.payment_mp_retry': 'Mensaje tras pago rechazado en MP',
    'flow.payment_mp_retry_sena': 'Variante retry MP (legacy seña)',
    'flow.transfer_received': 'Cliente avisó "listo" tras transferencia',
    'flow.cod_received': 'Cliente avisó "listo" tras anticipo COD',
    'flow.order_confirmation_mp': 'Confirmación final · pago MP completo',
    'flow.order_confirmation_transfer': 'Confirmación final · transferencia',
    'flow.order_confirmation_reparto': 'Confirmación final · reparto propio (paga al recibir)',
    'flow.order_confirmation_cod': 'Confirmación final · retiro contra reembolso (legacy)',
    'flow.order_confirmation_fallback': 'Confirmación final · fallback genérico',
};

export const TYPE_META = {
    note:       { label: 'Nota',       icon: MessageSquare, tone: 'neutral' },
    correction: { label: 'Corrección', icon: Edit3,         tone: 'warning' },
    question:   { label: 'Pregunta',   icon: HelpCircle,    tone: 'info'    },
};

// Agrupación visual del guión en 6 etapas del flujo. Cada etapa es un bloque
// colapsable; las secciones (y los slots "entre dos" dentro de la misma etapa)
// se renderizan adentro cuando se expande. Las "between" cross-etapa quedan
// como una mini-row entre los bloques (raras, pero las conservamos para no
// perder comentarios viejos creados en esos paths).
export const STAGE_GROUPS = [
    {
        key: 'onboarding',
        label: 'Saludo y recomendación',
        icon: Hand,
        sectionKeys: ['greeting', 'recommendation', 'recommendation_1', 'recommendation_2', 'recommendation_3'],
    },
    {
        key: 'product',
        label: 'Elige producto',
        icon: ShoppingBag,
        sectionKeys: ['preference_capsulas', 'preference_gotas', 'preference_semillas'],
    },
    {
        key: 'prices',
        label: 'Precios',
        icon: DollarSign,
        sectionKeys: ['prices_60', 'prices_120', 'prices'],
    },
    {
        key: 'payment',
        label: 'Pago',
        icon: CreditCard,
        sectionKeys: [
            'payment_menu', 'zone_km', 'zone_reask', 'zone_no_local', 'zone_in', 'zone_out',
            'payment_domicilio_choice', 'payment_sucursal_choice',
            'prepay_objection', 'prepay_refusal_close',
            'payment_transfer_alias', 'payment_mp_link', 'payment_mp_link_sucursal', 'payment_mp_link_sena',
            'payment_mp_failed', 'payment_mp_retry', 'payment_mp_retry_sena',
            'payment_cod_retry', 'payment_cod_anticipo',
            'transfer_received', 'cod_received',
        ],
    },
    {
        key: 'confirmation',
        label: 'Cierre y confirmación',
        icon: CheckCircle2,
        sectionKeys: [
            'closing', 'closing_sucursal',
            'order_confirmation_mp', 'order_confirmation_transfer',
            'order_confirmation_reparto', 'order_confirmation_cod', 'order_confirmation_fallback',
        ],
    },
    {
        key: 'faq',
        label: 'FAQ',
        icon: MessageCircle,
        isFaq: true,
    },
];

// Path estable para comentarios entre dos pasos. Lo dejamos como string
// para reusar el mismo endpoint sin cambios en el backend.
export const betweenPath = (prev, next) => `between:${prev}|${next}`;

// Valores de ejemplo para ver un texto como le llegaría al cliente: el bot los
// sustituye en runtime (`_formatMessage`) con los datos de cada charla. La vista
// previa asume Cápsulas × 120 días pagando con MP (4-6 días; en runtime son 7-10
// si es transferencia o contrarreembolso). Los precios no están acá: salen del
// Editor de Precios.
const EXAMPLE_VALUES = {
    ALIAS: BANK_ALIAS, TITULAR: BANK_HOLDER,
    PRODUCT: 'Cápsulas', PRODUCT_DETAIL: 'Cápsulas',
    PLAN: '120', PLAN_DETAIL: '120 días',
    LINK: 'https://mpago.la/example',
    LOCALIDAD: 'Funes',
    ENVIO_LINE: '✔ Correo Argentino — envío a domicilio\n',
    POSTDATADO_LINE: '✔ Entrega estimada: 4 días hábiles desde la confirmación\n',
};

export function renderText(text, prices) {
    if (!text) return '';
    let r = fillPricePlaceholders(String(text), prices);
    // El total del ejemplo es Cápsulas 120 del Editor; sin precios, {{TOTAL}} queda visible.
    const values = { ...EXAMPLE_VALUES, TOTAL: prices?.['Cápsulas']?.['120'] };
    Object.entries(values).forEach(([k, v]) => {
        if (v != null && v !== '') r = r.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    });
    r = r.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    r = r.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    return r;
}

export function formatDate(iso) {
    const d = new Date(iso);
    return `${d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
}

// Un comentario es "nuevo" si llegó después de la última visita y sigue abierto.
export const isNewComment = (comment, lastVisitTs) =>
    new Date(comment.createdAt).getTime() > lastVisitTs && !comment.resolved;
