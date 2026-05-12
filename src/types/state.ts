export enum FlowStep {
    GREETING = "greeting",
    GENERAL = "general",
    WAITING_WEIGHT = "waiting_weight",
    WAITING_PREFERENCE = "waiting_preference",
    WAITING_PREF_CONSULT = "waiting_preference_consultation",
    WAITING_PLAN_CHOICE = "waiting_plan_choice",
    WAITING_PRICE_CONFIRMATION = "waiting_price_confirmation",
    WAITING_OK = "waiting_ok",
    WAITING_DATA = "waiting_data",
    WAITING_FINAL_CONFIRMATION = "waiting_final_confirmation",
    WAITING_ADMIN_OK = "waiting_admin_ok",
    WAITING_ADMIN_VALIDATION = "waiting_admin_validation",
    POST_SALE = "post_sale",
    SAFETY_CHECK = "safety_check",
    CLOSING = "closing",
    COMPLETED = "completed",
    WAITING_MAPS_CONFIRMATION = "waiting_maps_confirmation",
    WAITING_PAYMENT_METHOD = "waiting_payment_method",
    WAITING_MP_PAYMENT = "waiting_mp_payment",
    WAITING_TRANSFER_CONFIRMATION = "waiting_transfer_confirmation",
    REJECTED_MEDICAL = "rejected_medical",
    REJECTED_ABUSIVE = "rejected_abusive",
    REJECTED_GEO = "rejected_geo"
}

export interface Address {
    nombre?: string | null;
    calle?: string | null;
    calleOriginal?: string | null;
    ciudad?: string | null;
    provincia?: string | null;
    cp?: string | null;
    postdatado?: string | null;
}

export interface HistoryMessage {
    role: 'user' | 'bot' | 'system';
    content: string;
    timestamp: number;
}

export interface CartItem {
    product: string;
    plan: string;
    price: string | number;
}

export interface UserState {
    step: FlowStep | string;
    history: HistoryMessage[];
    cart: CartItem[];
    summary: string;
    partialAddress: Address;

    // Opciones del carrito y preferencias
    selectedProduct?: string | null;
    selectedPlan?: string | null;
    totalPrice?: string | number | null;
    price?: string | number | null;
    weightGoal?: string | number | null;
    isContraReembolsoMAX?: boolean;
    adicionalMAX?: number;

    // Variables de iteración y validación de direcciones
    addressAttempts?: number;
    fieldReaskCount?: Record<string, number>;
    addressIssueType?: string | null;       // 'no_number' | 'intersection' | 'conflict' (last issue seen)
    addressIssueTries?: number;             // legacy field, replaced by addressIssueAttempts
    addressIssueAttempts?: Record<string, number>; // per-issue-type counter; reset on resolved address
    mapsFormattedAddress?: string | null;   // Address returned by Google Maps
    pendingCPFromMaps?: string | null;      // CP suggested by Google Maps, awaiting user confirmation
    lastAddressMsg?: string;

    // Multi-modal (Para envío de fotos / OCR)
    lastImageMime?: string | null;
    lastImageData?: string | null;
    lastImageContext?: string | null;
    profile?: string | null;
    consultativeSale?: boolean;

    // Otros flags
    geoRejected?: boolean;
    stepEnteredAt: number;
    postdatado?: string | null;
    assignedScript?: string;

    // Scheduler Flags
    staleAlerted?: boolean;
    reengagementSent?: boolean;
    cartRecovered?: boolean;
    secondFollowUpSent?: boolean;
    cashRetryShown?: boolean; // last-mile retry mostrado al elegir contra reembolso
    lastInteraction?: number;
    lastActivityAt?: number;

    // Objeto usado cuando el pedido está listo para guardarse
    pendingOrder?: Address & { cart: CartItem[] } | null;

    // Funnel analytics
    funnelLog?: { step: string; enteredAt: number; exitedAt?: number }[];

    // A/B follow-up tracking
    followUpData?: {
        type: 'cold_lead' | 'abandoned_cart';
        reason: string;
        step: string;
        variantIndex: number;
        sentAt: number;
        converted: boolean;
    };

    // Ad source tracking
    adSource?: string | null;        // Which ad the client came from (detected from first message)

    // Flags de estados especiales del cliente
    hasSoldBefore?: boolean;         // true si ya se concretó al menos una venta exitosa
    pendingCancelConfirm?: boolean;  // true si el bot está esperando confirmación de cancelación
    currentWeight?: number;          // Peso corporal actual del cliente (distinto de weightGoal)
    userName?: string;               // Nombre del cliente extraído del chat

    // Payment method flow
    paymentMethod?: 'mercadopago' | 'contrarembolso' | 'transferencia' | null;
    mpPaymentLinkId?: string | null;  // ID del registro PaymentLink en DB
    mpPaymentLinkUrl?: string | null; // URL init_point enviada al cliente

    // Seña por Mercado Pago para pago al recibir (política mayo 2026).
    // Si está seteado, el link MP que se genera es por este monto (no por totalPrice).
    // El saldo (totalPrice - senaAmount) lo cobra el cartero en efectivo.
    senaAmount?: number | null;
    senaPaid?: boolean;

    // Objection detector: tracks which objection types already got a
    // pre-calibrated rebuttal so we don't repeat the same canned line.
    objectionsHandled?: Record<string, number>;

    // Rolling summary: timestamp of last successful background summarization,
    // used to rate-limit repeat calls to the summarizer.
    lastSummarizedAt?: number;
}

export interface AlertOrderData {
    product: string | null;
    plan: string | null;
    price: string | number | null;
    address: Address | null;
    step: string | null;
}

export interface QuickReply {
    label: string;       // Short description shown to admin
    message: string;     // Actual message to send to client
}

export interface AlertEntry {
    id: number;
    timestamp: Date;
    reason: string;
    userPhone: string;
    userName: string;
    details: string | null;
    orderData: AlertOrderData;
    quickReplies?: QuickReply[];
}

export interface BotConfig {
    activeScript: string;
    alertNumbers: string[];
    [key: string]: any;
}

export interface SharedState {
    userState: Record<string, UserState>;
    chatResets: Record<string, number>;
    pausedUsers: Set<string>;
    sessionAlerts: AlertEntry[];
    config: BotConfig;
    knowledge: any;
    multiKnowledge: Record<string, any>;
    isConnected: boolean;
    qrCodeData: string | null;
    sellerId?: string;       // tenant/seller identity (also lives on each seller instance) — used when scoping DB queries from shared services
    lastAlertUser?: string; // @deprecated — kept for backward compat; prefer alert queue selector
    saveState: (userId?: string | null) => void;
    saveKnowledge: (scriptName?: string | null) => void;
    loadKnowledge: (scriptName?: string | null) => void;
    reloadKnowledge: (scriptName?: string | null) => void;
    availableScripts: string[];
    handleAdminCommand: (targetChatId: string | null, commandText: string, isApi?: boolean) => Promise<string>;
    logAndEmit: (chatId: string, sender: string, text: string, step?: string) => void;
    io: any;
    requestPairingCode?: (phone: string) => Promise<string>;
}
