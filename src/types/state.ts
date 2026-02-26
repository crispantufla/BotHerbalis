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
    REJECTED_MEDICAL = "rejected_medical"
}

export interface Address {
    nombre?: string | null;
    calle?: string | null;
    ciudad?: string | null;
    provincia?: string | null;
    cp?: string | null;
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
    lastInteraction?: number;
    lastActivityAt?: number;

    // Objeto usado cuando el pedido está listo para guardarse
    pendingOrder?: Address & { cart: CartItem[] } | null;
}

export interface SharedState {
    userState: Record<string, UserState>;
    chatResets: Record<string, number>;
    pausedUsers: Set<string>;
    sessionAlerts: any[];
    config: any;
    knowledge: any;
    multiKnowledge: Record<string, any>;
    isConnected: boolean;
    qrCodeData: string | null;
    saveState: (userId?: string | null) => void;
    saveKnowledge: (scriptName?: string | null) => void;
    loadKnowledge: (scriptName?: string | null) => void;
    reloadKnowledge: (scriptName?: string | null) => void;
    availableScripts: string[];
    handleAdminCommand: any;
    logAndEmit: any;
    io: any;
    requestPairingCode?: (phone: string) => Promise<string>;
}
