// Configuración de la vista de guiones: etiquetas, etapas del flujo y valores de
// ejemplo para los placeholders. Salió de GuionView.jsx.
import {
    MessageSquare, HelpCircle, Edit3, ShoppingBag, DollarSign, CreditCard, CheckCircle2, MessageCircle, Hand,
} from 'lucide-react';

export const SCRIPT_LABELS = {
    v7: { name: 'V7 · Elena', tone: '2 tiers (≤10 kg → 60d, +10 kg → 120d). Persona Elena, tono argentino cálido. Tras pedir kilos, manda recomendación + precios en mensajes seguidos.' },
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
    'flow.closing': 'Cierre — pide datos de envío',
    'flow.payment_menu': 'TEXTO 4 — Menú de pago (envío + medio)',
    'flow.payment_domicilio_choice': 'Submenú: domicilio → MP o transferencia',
    'flow.payment_retiro_confirm': 'Confirmación retiro en sucursal',
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
    'flow.order_confirmation_cod': 'Confirmación final · contra reembolso',
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
            'payment_menu', 'payment_domicilio_choice', 'payment_retiro_confirm',
            'payment_transfer_alias', 'payment_mp_link', 'payment_mp_link_sena',
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
            'closing',
            'order_confirmation_mp', 'order_confirmation_transfer',
            'order_confirmation_cod', 'order_confirmation_fallback',
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

// Reemplaza placeholders {{X}} con valores ejemplo para que se vea como en
// producción. El runtime los sustituye dinámicamente en `_formatMessage`; acá
// usamos valores plausibles para que admins vean cómo queda el mensaje.
// La preview asume MP (4-6d); en runtime real es 7-10d si transferencia/COD.
const PLACEHOLDER_VALUES = {
    PRICE_CAPSULAS_60: '46.900', PRICE_CAPSULAS_120: '66.900',
    PRICE_SEMILLAS_60: '36.900', PRICE_SEMILLAS_120: '49.900',
    PRICE_GOTAS_60: '48.900',    PRICE_GOTAS_120: '68.900',
    PRICE_TOTAL_CAPSULAS_60: '46.900', PRICE_TOTAL_GOTAS_60: '48.900', PRICE_TOTAL_SEMILLAS_60: '36.900',
    PRICE_PER_DAY_CAPSULAS_120: '558', PRICE_PER_DAY_SEMILLAS_120: '416', PRICE_PER_DAY_GOTAS_120: '574',
    PRICE_60: '46.900', PRICE_120: '66.900',
    ALIAS: 'HERBALIS.TIENDA', TITULAR: 'BIO ORIGEN S.A.S.',
    ANTICIPO: '10.000', ADICIONAL_MAX: '0', COSTO_LOGISTICO: '18.000',
    PRODUCT: 'Cápsulas', PRODUCT_DETAIL: 'Cápsulas',
    PLAN: '120', PLAN_DETAIL: '120 días',
    TOTAL: '66.900',
    LINK: 'https://mpago.la/example',
    SALDO: '56.900',
    SENA_AMOUNT: '10.000', SENA_AMOUNT_FMT: '10.000', SENA_REMAINDER: '56.900',
    POSTDATADO_LINE: '✔ Entrega estimada: 4 a 6 días hábiles desde la confirmación del pago\n',
    CARTO_LINE: '✔ Saldo al cartero: *$56.900* en efectivo al recibir',
};

export function renderText(text) {
    if (!text) return '';
    let r = String(text);
    Object.entries(PLACEHOLDER_VALUES).forEach(([k, v]) => {
        r = r.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
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
