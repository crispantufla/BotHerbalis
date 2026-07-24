import React, { useState, useEffect, useMemo } from 'react';
import {
    Search, Bot, Play, Pause, Trash2, FileText, Type, ShoppingCart, ChevronLeft,
    MessageCircle
} from 'lucide-react';

import api from '../../config/axios';
import { useChat } from '../../hooks/useChat';
import { useSeller } from '../../context/SellerContext';

import {
    Button, IconButton, Card, Badge, Input, Select, Modal, EmptyState, useToast, cn
} from '../ui';

import ChatMessageList from './components/ChatMessageList';
import ChatInputArea from './components/ChatInputArea';
import AiCorrectionModal from './components/AiCorrectionModal';
import ManualOrderEntryModal from './components/ManualOrderEntryModal';
import ManualMpLinkModal from './components/ManualMpLinkModal';

import ChatSidebarItem from './comms/ChatSidebarItem';
import AlertBanner from './comms/AlertBanner';
import OrdersDrawer from './comms/OrdersDrawer';
import ScriptPanel from './comms/ScriptPanel';

const CommsView = ({ initialChatId, onChatSelected, onChatOpened, alerts = [], onAlertAction }) => {
    const { toast } = useToast();
    const { selectedSellerId } = useSeller();

    // UI state
    // Guardamos solo el ID seleccionado y derivamos el objeto del array `chats`
    // (memo más abajo). Antes se guardaba una COPIA congelada del chat: si el
    // bot se auto-pausaba server-side con el chat abierto, el header seguía
    // "Auto-bot activo" y los guards decidían sobre `isPaused` viejo.
    // `selectedChatFallback` cubre chats que todavía no están en la lista
    // (resultado de búsqueda backend-only, link directo desde otra vista).
    const [selectedChatId, setSelectedChatId] = useState(null);
    const [selectedChatFallback, setSelectedChatFallback] = useState(null);
    const [input, setInput] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [showScriptPanel, setShowScriptPanel] = useState(false);
    const [showOrdersPanel, setShowOrdersPanel] = useState(false);
    const [showFontSlider, setShowFontSlider] = useState(false);
    const [alertExpanded, setAlertExpanded] = useState(true);

    // Datos
    const [scriptFlow, setScriptFlow] = useState({});
    const [availableScripts, setAvailableScripts] = useState({ v7: {} });
    const [prices, setPrices] = useState(null);
    const [summarizing, setSummarizing] = useState(false);
    const [summaryText, setSummaryText] = useState(null);
    const [attachment, setAttachment] = useState(null);
    const [sendingMedia, setSendingMedia] = useState(false);
    const [isTracking, setIsTracking] = useState(false);
    const [trackingData, setTrackingData] = useState(null);

    const [chatFontSize, setChatFontSize] = useState(
        () => parseInt(localStorage.getItem('herbalis_chat_font_size') || '14', 10)
    );

    // Búsqueda backend
    const [searchResults, setSearchResults] = useState(null);
    const [isSearching, setIsSearching] = useState(false);

    // Modales
    const [manualEntry, setManualEntry] = useState(null);
    const [submittingManual, setSubmittingManual] = useState(false);
    const [showCorrectionModal, setShowCorrectionModal] = useState(false);
    const [reportedMsgId, setReportedMsgId] = useState(null);
    const [showConfirmFillModal, setShowConfirmFillModal] = useState(false);
    const [confirmFillTemplate, setConfirmFillTemplate] = useState('');
    const [confirmFillData, setConfirmFillData] = useState({ product: '', plan: '60', total: '' });
    const [showMpLinkModal, setShowMpLinkModal] = useState(false);
    const [mpLinkTemplate, setMpLinkTemplate] = useState('');
    const [mpLinkSuggestedAmount, setMpLinkSuggestedAmount] = useState('');

    const {
        chats, setChats, messages, setMessages,
        isLoadingChats, isLoadingMessages,
        globalPause,
        sendMessage, sendMedia, deleteMessage, toggleBot, clearChat
    } = useChat(selectedChatId);

    // Objeto derivado: siempre la versión viva del array `chats` (los updates
    // de bot_status_change / new_log fluyen al chat abierto). El fallback solo
    // aplica mientras el chat no exista en la lista.
    const selectedChat = useMemo(() => {
        if (!selectedChatId) return null;
        return chats.find(c => c.id === selectedChatId)
            || (selectedChatFallback?.id === selectedChatId ? selectedChatFallback : { id: selectedChatId, name: selectedChatId });
    }, [chats, selectedChatId, selectedChatFallback]);

    // Reset selected chat cuando un admin cambia de seller.
    useEffect(() => { setSelectedChatId(null); setSelectedChatFallback(null); }, [selectedSellerId]);

    // Wrapper que dispara `onChatOpened` (típicamente colapsa el sidebar
    // principal) sólo cuando un chat se selecciona — no al limpiar (null).
    const selectChat = (chat) => {
        setSelectedChatId(chat?.id || null);
        setSelectedChatFallback(chat || null);
        if (chat && onChatOpened) onChatOpened();
    };

    useEffect(() => {
        localStorage.setItem('herbalis_chat_font_size', chatFontSize);
    }, [chatFontSize]);

    // Búsqueda debounced contra el backend (mensajes, número, nombre, fuera de memoria).
    // Mientras el usuario tipea mostramos el filtro client-side instantáneo sobre los
    // chats ya cargados; cuando llega la respuesta del backend, hacemos merge.
    useEffect(() => {
        const term = searchTerm.trim();
        if (term.length < 2) {
            setSearchResults(null);
            setIsSearching(false);
            return;
        }
        setIsSearching(true);
        const t = setTimeout(async () => {
            try {
                const res = await api.get('/api/chats/search', { params: { q: term, limit: 50 } });
                setSearchResults(res.data || []);
            } catch (e) {
                console.error('[CHATS/SEARCH] error:', e);
                setSearchResults([]);
            } finally {
                setIsSearching(false);
            }
        }, 300);
        return () => clearTimeout(t);
    }, [searchTerm]);

    // Lista derivada para mostrar:
    //   - sin búsqueda activa → chats normales (en memoria)
    //   - mientras espera el backend → filter client-side instantáneo
    //   - con resultados → merge: backend primero (con snippet) + memoria que matcheó
    //     pero no apareció en backend (clientes manuales sin User en DB).
    const filteredChats = (() => {
        const term = searchTerm.trim();
        if (!term) return chats;

        const lower = term.toLowerCase();
        const digits = term.replace(/\D/g, '');
        const inMemMatches = chats.filter(c => {
            const nameMatch = c.name?.toLowerCase().includes(lower);
            const phoneMatch = digits.length >= 4 && c.id?.replace(/\D/g, '').includes(digits);
            const messageMatch = typeof c.lastMessage?.body === 'string' && c.lastMessage.body.toLowerCase().includes(lower);
            return nameMatch || phoneMatch || messageMatch;
        });

        if (searchResults === null) return inMemMatches;

        const inMemMap = new Map(chats.map(c => [c.id, c]));
        const backendIds = new Set(searchResults.map(r => r.id));
        const enrichedBackend = searchResults.map(r => {
            const inMem = inMemMap.get(r.id);
            return {
                ...r,
                ...(inMem || {}),
                searchSnippet: r.snippet,
                searchMatchedField: r.matchedField,
                searchSnippetRole: r.snippetRole,
                hasBought: r.hasBought ?? inMem?.hasBought,
            };
        });
        const inMemOnly = inMemMatches.filter(c => !backendIds.has(c.id));
        return [...enrichedBackend, ...inMemOnly];
    })();

    // Auto-abrir chat si la búsqueda devolvió exactamente 1 resultado.
    const autoSelectId = (searchTerm.trim() && searchResults !== null && filteredChats.length === 1)
        ? filteredChats[0].id : null;
    useEffect(() => {
        if (!autoSelectId) return;
        if (selectedChatId === autoSelectId) return;
        const target = filteredChats.find(c => c.id === autoSelectId);
        if (target) {
            setSelectedChatId(target.id);
            setSelectedChatFallback(target);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoSelectId]);

    const chatAlert = selectedChat
        ? alerts.find(a => a.userPhone === selectedChat.id || a.userPhone === selectedChat.id.split('@')[0])
        : null;

    // initialChatId via prop (link directo desde otra vista)
    useEffect(() => {
        if (initialChatId && chats.length > 0) {
            setSelectedChatId(initialChatId);
            setSelectedChatFallback({ id: initialChatId, name: initialChatId });
            if (onChatSelected) onChatSelected();
        }
    }, [initialChatId, chats, onChatSelected]);

    // Bootstrap: cargar el guion activo (V7) y precios en paralelo.
    // V5/V6 fueron archivados may-2026 — solo V7 está vivo.
    useEffect(() => {
        (async () => {
            try {
                const [scriptV7, pricesRes] = await Promise.all([
                    api.get('/api/script/v7'),
                    api.get('/api/prices'),
                ]);
                const scripts = { v7: scriptV7.data?.flow || {} };
                setAvailableScripts(scripts);
                setScriptFlow(scripts.v7);
                if (pricesRes.data) setPrices(pricesRes.data);
            } catch (e) { console.error('Error fetching scripts:', e); }
        })();
    }, []);

    // Cambiar de flow según el assignedScript del chat seleccionado.
    // V7 es el único guion activo desde may-2026 — los chats viejos pueden
    // tener assignedScript='v5'/'v6' grabado, pero el backend ya migra esos
    // valores en runtime. Default a 'v7' si no viene seteado.
    useEffect(() => {
        if (!selectedChat) return;
        const targetVersion = selectedChat.assignedScript || 'v7';
        if (availableScripts[targetVersion]) {
            setScriptFlow(availableScripts[targetVersion]);
        } else if (availableScripts['v7']) {
            // Chat con assignedScript de un guion archivado (v3..v6) — caemos a V7.
            setScriptFlow(availableScripts['v7']);
        }
    }, [selectedChat, availableScripts]);

    useEffect(() => {
        if (!selectedChat) return;
        setSummaryText(null);
    }, [selectedChat?.id]);

    // ─── Helpers de mensaje ─────────────────────────────────────────────────

    const formatScriptMessage = (text, chat = null) => {
        if (!text) return text;
        let result = text;
        // Precios: SOLO desde /api/prices — NUNCA números inventados en código.
        // Si un precio no cargó, el placeholder {{PRICE_*}} queda visible tal
        // cual (el sweep final los preserva) para que el admin no mande un
        // valor viejo/falso al cliente sin darse cuenta.
        const p = prices || {};
        const subPrice = (re, val) => {
            if (val != null && val !== '') result = result.replace(re, String(val));
        };
        subPrice(/{{PRICE_CAPSULAS_60}}/g, p['Cápsulas']?.['60']);
        subPrice(/{{PRICE_CAPSULAS_120}}/g, p['Cápsulas']?.['120']);
        subPrice(/{{PRICE_SEMILLAS_60}}/g, p['Semillas']?.['60']);
        subPrice(/{{PRICE_SEMILLAS_120}}/g, p['Semillas']?.['120']);
        subPrice(/{{PRICE_GOTAS_60}}/g, p['Gotas']?.['60']);
        subPrice(/{{PRICE_GOTAS_120}}/g, p['Gotas']?.['120']);
        subPrice(/{{ADICIONAL_MAX}}/g, p.adicionalMAX);
        subPrice(/{{COSTO_LOGISTICO}}/g, p.costoLogistico);
        const ctx = chat || selectedChat;
        const product = ctx?.selectedProduct || ctx?.cart?.[0]?.product || 'Producto';
        const plan = ctx?.selectedPlan || ctx?.cart?.[0]?.plan || '60';
        let total = ctx?.totalPrice || '';
        if (!total && ctx?.cart?.length > 0) {
            total = ctx.cart
                .reduce((s, i) => s + parseInt((i.price || '0').toString().replace(/\D/g, '')), 0)
                .toLocaleString('es-AR');
        }
        result = result
            .replace(/{{PRODUCT}}/g, product)
            .replace(/{{PRODUCT_DETAIL}}/g, product)
            .replace(/{{PLAN}}/g, plan)
            .replace(/{{PLAN_DETAIL}}/g, `${plan} días`)
            .replace(/{{TOTAL}}/g, total ? total : '0');

        // PLAN_MONTHS: "2 meses" / "4 meses"
        const planNum = parseInt(String(plan), 10);
        const months = isNaN(planNum) ? '' : `${Math.round(planNum / 30)} meses`;
        result = result.replace(/{{PLAN_MONTHS}}/g, months);

        // DOSAGE_REASON según weightGoal (mismo mapeo que server-side messages.ts)
        const w = typeof ctx?.weightGoal === 'number'
            ? ctx.weightGoal
            : parseInt(String(ctx?.weightGoal || 0), 10) || 0;
        let dosageReason = '';
        if (w > 0 && w <= 10) dosageReason = 'Con el plan de 60 días te alcanza para tu objetivo.';
        else if (w > 10 && w <= 20) dosageReason = 'Con el plan de 120 días te puede sobrar un poco; muchas clientas usan el sobrante como mantenimiento.';
        else if (w > 20) dosageReason = 'El plan de 120 días es el tiempo que tu cuerpo necesita para bajar tranqui, sin rebote.';
        result = result.replace(/{{DOSAGE_REASON}}/g, dosageReason);

        // PRICE_60 / PRICE_120 genéricos según producto seleccionado. Igual que
        // arriba: sin precio cargado, el placeholder queda visible.
        const productKey = product.includes('Gota') ? 'Gotas'
            : product.includes('Semilla') ? 'Semillas'
            : 'Cápsulas';
        subPrice(/{{PRICE_60}}/g, p[productKey]?.['60']);
        subPrice(/{{PRICE_120}}/g, p[productKey]?.['120']);

        // PRICE_PER_DAY_X_120 — para anclas de precio/día en V6 legacy. Calculo
        // como (precio plan 120 / 120) redondeado.
        const perDay = (priceStr) => {
            if (!priceStr) return null;
            const n = parseInt(priceStr.replace(/\./g, ''), 10);
            if (isNaN(n)) return null;
            return Math.round(n / 120).toLocaleString('es-AR');
        };
        subPrice(/{{PRICE_PER_DAY_CAPSULAS_120}}/g, perDay(p['Cápsulas']?.['120']));
        subPrice(/{{PRICE_PER_DAY_SEMILLAS_120}}/g, perDay(p['Semillas']?.['120']));
        subPrice(/{{PRICE_PER_DAY_GOTAS_120}}/g, perDay(p['Gotas']?.['120']));
        subPrice(/{{PRICE_PER_DAY_120}}/g, perDay(p[productKey]?.['120']));

        // Constantes bancarias + entrega standard + saldo legacy seña.
        // POSTDATADO_LINE: muestra entrega standard (7-10 días). Para el preview
        // no contamos con state.postdatado — el server lo resuelve en runtime.
        result = result
            .replace(/{{ALIAS}}/g, 'HERBALIS.TIENDA')
            .replace(/{{TITULAR}}/g, 'BIO ORIGEN S.A.S.')
            .replace(/{{ANTICIPO}}/g, '10.000')
            .replace(/{{POSTDATADO_LINE}}/g, '✔ Entrega estimada: 7 a 10 días hábiles desde la confirmación\n')
            .replace(/{{CARTO_LINE}}/g, '')
            .replace(/{{LINK}}/g, '(link se genera al confirmar el pago)')
            .replace(/{{SENA_AMOUNT}}/g, '10.000')
            .replace(/{{SENA_AMOUNT_FMT}}/g, '10.000')
            .replace(/{{SENA_REMAINDER}}/g, '')
            .replace(/{{SALDO}}/g, '');

        // Sweep defensivo: cualquier {{X}} residual queda invisible en el preview
        // (igual que hace el server-side _formatMessage antes de mandar al cliente)
        // — EXCEPTO los de precios: esos quedan visibles tal cual para que un
        // precio no cargado nunca se convierta en silencio o número inventado.
        result = result.replace(/\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g, (match, tag) =>
            /^(PRICE_|ADICIONAL_MAX$|COSTO_LOGISTICO$)/.test(tag) ? match : '');

        return result;
    };

    // Extrae product/plan/total del state primero, sino escanea mensajes.
    // Plan SOLO se confía si el usuario lo dijo (el bot muestra ambos 60/120,
    // escanear todo daría false positives). Total SOLO si el bot mencionó UN
    // único precio (no una lista).
    const extractConfirmationContext = () => {
        let product = selectedChat?.selectedProduct || selectedChat?.cart?.[0]?.product || null;
        let plan = selectedChat?.selectedPlan || selectedChat?.cart?.[0]?.plan || null;
        let total = selectedChat?.totalPrice || null;

        if (!product || !plan || !total) {
            const userText = messages.filter(m => !m.fromMe).map(m => m.body || '').join('\n');
            const botText  = messages.filter(m =>  m.fromMe).map(m => m.body || '').join('\n');
            const allText  = messages.map(m => m.body || '').join('\n');

            if (!product) {
                if (/c[áa]psulas?/i.test(allText)) product = 'Cápsulas de Nuez de la India';
                else if (/semillas?/i.test(allText)) product = 'Semillas de Nuez de la India';
                else if (/gotas?/i.test(allText))    product = 'Gotas de Nuez de la India';
            }
            if (!plan) {
                if (/\b120\b/.test(userText)) plan = '120';
                else if (/\b60\b/.test(userText)) plan = '60';
            }
            if (!total) {
                const priceMatches = botText.match(/\$\s*\d{2,3}[.,]\d{3}/g) || [];
                const uniquePrices = [...new Set(priceMatches)];
                if (uniquePrices.length === 1) {
                    total = uniquePrices[0].replace(/\$\s*/, '').replace(',', '.');
                }
            }
        }
        return { product, plan, total };
    };

    const buildConfirmMessage = (template, { product, plan, total }) => {
        // Construimos un "fake chat" con los valores del modal para reusar
        // formatScriptMessage (cubre PRODUCT/PLAN/TOTAL + ALIAS, TITULAR,
        // POSTDATADO_LINE, PRODUCT_DETAIL, PLAN_DETAIL, etc.). Sin esto algunos
        // placeholders del order_confirmation_* quedaban literales.
        const totalClean = String(total || '').replace(/^\$+/, '').trim();
        const fakeChat = {
            selectedProduct: product || 'Producto',
            selectedPlan: plan || '60',
            totalPrice: totalClean,
            cart: [],
        };
        return formatScriptMessage(template, fakeChat);
    };

    // ─── Handlers ──────────────────────────────────────────────────────────

    const handleSummarize = async () => {
        if (!selectedChat) return;
        setSummarizing(true);
        try {
            const res = await api.get(`/api/summarize/${selectedChat.id}`);
            setSummaryText(res.data.summary || res.data.message);
        } catch { toast.error('Error generando resumen'); }
        setSummarizing(false);
    };

    const handleDownloadHistory = () => {
        if (!selectedChat || messages.length === 0) {
            toast.warning('No hay mensajes para descargar');
            return;
        }
        let txtContent = `Analiza esta conversacion:\n\n`;
        messages.forEach(msg => {
            let dateStr = '';
            try {
                const d = new Date(msg.timestamp);
                if (!isNaN(d.getTime())) {
                    dateStr = `[${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })}, ${d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}] `;
                }
            } catch { /* */ }
            const sender = msg.fromMe ? 'Herbalis' : (selectedChat.name || selectedChat.id).split('@')[0];
            let body = msg.body || '';
            if (body.startsWith('MEDIA_IMAGE:')) body = '[Imagen adjunta]';
            if (body.startsWith('MEDIA_AUDIO:')) {
                const parts = body.split('|');
                const trans = parts[1] ? parts[1].replace('TRANSCRIPTION:', '').trim() : '';
                body = trans ? `[Audio transcrito]: ${trans}` : `[Audio adjunto]`;
            }
            if (body.startsWith('🎤 Audio:')) body = `[Audio transcrito]: ${body.replace(/^🎤\s*Audio:\s*/, '').replace(/^"|"$/g, '').trim()}`;
            txtContent += `${dateStr}${sender}: ${body}\n`;
        });
        const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safePhone = selectedChat.id.split('@')[0].replace(/\D/g, '');
        a.download = `chat_${safePhone}_${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success('Historial descargado para análisis');
    };

    const handleSend = async (e) => {
        if (e) e.preventDefault();
        if (!input.trim() || !selectedChat) return;
        const text = input;
        if (text.trim().toLowerCase() === '/descargar') {
            handleDownloadHistory();
            setInput('');
            return;
        }
        setInput('');
        setMessages(prev => [...prev, { id: `temp-${Date.now()}`, fromMe: true, body: text, type: 'chat', timestamp: Date.now(), pending: true }]);
        try { await sendMessage({ chatId: selectedChat.id, message: text }); }
        catch { toast.error('Error al enviar mensaje'); }
    };

    // Paso 1: SIEMPRE abrimos el modal de verificación (con mensaje o sin). Pedimos
    // un "preview" al backend (detecta datos + tipo de envío + medio de pago +
    // producto SIN crear la orden) y pre-cargamos el modal. La orden se crea recién
    // cuando el admin confirma el modal.
    const handleManualCompletion = async (silent = false) => {
        if (!selectedChat) return;
        try {
            const res = await api.post('/api/orders/manual-complete', { chatId: selectedChat.id, silent, preview: true });
            setManualEntry({ chatId: selectedChat.id, silent, prefill: res.data?.prefill || {} });
        } catch (e) {
            toast.error('No pude preparar el pedido: ' + (e.response?.data?.error || e.message));
        }
    };

    // Paso 2: el admin verificó/ajustó en el modal y confirma. Acá sí se crea la
    // orden, enviando los datos + el tipo de envío y medio de pago elegidos.
    const handleManualEntrySubmit = async ({ manualAddr, shippingType, paymentMethod, discount, productType, plan, paymentVerified }) => {
        if (!manualEntry) return;
        setSubmittingManual(true);
        try {
            await api.post('/api/orders/manual-complete', {
                chatId: manualEntry.chatId,
                silent: manualEntry.silent,
                manualAddr, shippingType, paymentMethod, discount, productType, plan, paymentVerified,
            });
            toast.success(manualEntry.silent ? 'Venta registrada (sin mensaje)' : 'Pedido ingresado y confirmación enviada');
            setManualEntry(null);
            setInput('');
        } catch (e) {
            toast.error('Error al registrar pedido: ' + (e.response?.data?.error || e.message));
        } finally {
            setSubmittingManual(false);
        }
    };

    const handleDeleteMessage = async (msgId) => {
        if (!selectedChat || !msgId) return;
        if (!window.confirm('¿Eliminar este mensaje para todos?')) return;
        try {
            setMessages(prev => prev.filter(m => m.id !== msgId));
            await deleteMessage({ chatId: selectedChat.id, messageId: msgId });
            toast.success('Mensaje eliminado');
        } catch { toast.error('Error eliminando mensaje'); }
    };

    const handleToggleBot = async () => {
        if (!selectedChat) return;
        const newStatus = !selectedChat.isPaused;
        try {
            await toggleBot({ chatId: selectedChat.id, paused: newStatus });
            // Update optimista sobre la fuente de verdad (el array `chats`);
            // el evento bot_status_change del server lo confirma después.
            setChats(prev => Array.isArray(prev)
                ? prev.map(c => c.id === selectedChat.id ? { ...c, isPaused: newStatus } : c)
                : prev);
            setSelectedChatFallback(prev => prev && prev.id === selectedChat.id
                ? { ...prev, isPaused: newStatus }
                : prev);
            toast.success(newStatus ? 'Bot pausado' : 'Bot reactivado');
        } catch { toast.error('Error cambiando estado del bot'); }
    };

    const handleClearChat = async () => {
        if (!window.confirm('¿Reiniciar historial de este usuario?')) return;
        try {
            await clearChat(selectedChat.id);
            setMessages([]);
            toast.success('Chat reiniciado');
        } catch (e) {
            console.error('Error al reiniciar chat:', e);
            toast.error('Error: ' + e.message);
        }
    };

    // Importante: abrir el modal SINCRÓNICAMENTE antes de cualquier await — si
    // lo abrimos después de un await, el reconciler de React rompe con
    // NotFoundError ('insertBefore' on Node) y deja la pantalla en blanco.
    const handleReportMessage = (msgId) => {
        if (!selectedChat) return;
        setReportedMsgId(msgId);
        setShowCorrectionModal(true);
        if (!selectedChat.isPaused) {
            handleToggleBot().catch(e => console.warn('Auto-pause failed:', e));
        }
    };

    const handleTrackOrder = async (trackingCode) => {
        if (!trackingCode) return;
        setIsTracking(true);
        setTrackingData(null);
        try {
            const res = await api.get(`/api/orders/tracking/${trackingCode}`);
            setTrackingData(res.data);
        } catch { toast.error('Error al consultar seguimiento.'); }
        finally { setIsTracking(false); }
    };

    const handleCopySale = (order) => {
        const rawPhone = selectedChat?.id?.split('@')[0] || '';
        const phoneDisplay = rawPhone.length > 13 ? `Oculto por Anuncio Meta (${rawPhone})` : rawPhone || 'Desconocido';
        const text = `Nombre: ${selectedChat?.name || order.nombre || 'Cliente'}
Dirección: ${order.calle}, ${order.ciudad} (CP: ${order.cp})
Producto: ${order.producto}
Plan: ${order.plan || '120'} Días
A pagar: $${order.precio || '0'}
Teléfono: ${phoneDisplay}`;
        navigator.clipboard.writeText(text)
            .then(() => toast.success('Venta copiada al portapapeles'))
            .catch(() => toast.error('Error al copiar venta'));
    };

    const handleSendMedia = async () => {
        setSendingMedia(true);
        const isPdf = attachment.mimetype === 'application/pdf';
        try {
            await sendMedia({
                chatId: selectedChat.id, base64: attachment.base64, mimetype: attachment.mimetype,
                filename: attachment.file.name, caption: input.trim(),
            });
            const caption = input.trim();
            const label = isPdf ? `📎 PDF enviado (${attachment.file.name})` : '📷 Imagen enviada';
            const body = caption ? `${label}: ${caption}` : label;
            setMessages(prev => [...prev, { id: `temp-media-${Date.now()}`, fromMe: true, body, type: 'chat', timestamp: Date.now(), pending: true }]);
            setAttachment(null);
            setInput('');
        } catch { toast.error(isPdf ? 'Error al enviar PDF' : 'Error al enviar imagen'); }
        setSendingMedia(false);
    };

    const handlePickScriptStep = (stepKey, scriptResponse) => {
        // payment_mp_link → necesita un link real de MP. Abrimos modal que pide
        // el monto, crea la preferencia en MP, y sustituye {{LINK}} con la URL real.
        if (stepKey === 'payment_mp_link') {
            // Sugerimos el total del chat seleccionado si existe.
            const suggested = selectedChat?.totalPrice
                || selectedChat?.cart?.reduce((s, i) => s + parseInt((i.price || '0').toString().replace(/\D/g, '') || 0, 10), 0)
                || '';
            setMpLinkSuggestedAmount(String(suggested).replace(/\./g, '') || '');
            setMpLinkTemplate(scriptResponse);
            setShowMpLinkModal(true);
            return;
        }

        // order_confirmation_* → si el extractor detecta product+plan+total, se inserta
        // directo. Si falta algo, abrimos el modal con selector para completar.
        if (stepKey.startsWith('order_confirmation_') || stepKey === 'confirmation') {
            const ctx = extractConfirmationContext();
            if (ctx.product && ctx.plan && ctx.total) {
                if (!selectedChat.isPaused) handleToggleBot();
                setInput(buildConfirmMessage(scriptResponse, ctx));
            } else {
                setConfirmFillData({ product: ctx.product || '', plan: ctx.plan || '60', total: ctx.total || '' });
                setConfirmFillTemplate(scriptResponse);
                setShowConfirmFillModal(true);
            }
            return;
        }

        // Default: inserta el template formateado en el input.
        if (!selectedChat.isPaused) handleToggleBot();
        setInput(formatScriptMessage(scriptResponse, selectedChat));
    };

    // ─── Render ────────────────────────────────────────────────────────────

    return (
        <div className="flex-1 w-full min-h-0 flex flex-col md:flex-row animate-fade-in relative overflow-hidden bg-white dark:bg-slate-900 rounded-card border border-slate-200 dark:border-slate-700/70 shadow-card">

            {/* SIDEBAR: contactos */}
            <aside className={cn(
                'w-full md:w-60 lg:w-64 xl:w-72 md:flex-shrink-0',
                'border-r border-slate-200 dark:border-slate-800 flex-col bg-white dark:bg-slate-800 z-10',
                'min-h-0 overflow-hidden',
                selectedChat ? 'hidden md:flex' : 'flex flex-1'
            )}>
                {/* Search */}
                <div className="p-3 sm:p-4 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
                    <Input
                        leftIcon={Search}
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder="Buscar chats…"
                        aria-label="Buscar chats"
                    />
                </div>

                {/* Lista */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
                    {isSearching && (
                        <p className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400 italic">
                            Buscando en historial…
                        </p>
                    )}
                    {searchTerm.trim().length >= 2 && !isSearching && filteredChats.length === 0 && (
                        <p className="px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
                            Sin resultados para "<span className="font-semibold text-slate-700 dark:text-slate-200">{searchTerm}</span>"
                        </p>
                    )}
                    {isLoadingChats && chats.length === 0 ? (
                        Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className="p-3 mb-1 rounded-control animate-pulse bg-slate-100 dark:bg-slate-800/50 h-16 space-y-2">
                                <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-1/2" />
                                <div className="h-2 bg-slate-200 dark:bg-slate-700 rounded w-3/4" />
                            </div>
                        ))
                    ) : filteredChats.map(chat => (
                        <ChatSidebarItem
                            key={chat.id}
                            chat={chat}
                            isSelected={selectedChat?.id === chat.id}
                            hasAlert={alerts.some(a => a.userPhone === chat.id || a.userPhone === chat.id.split('@')[0])}
                            searchTerm={searchTerm}
                            onSelect={selectChat}
                        />
                    ))}
                </div>
            </aside>

            {/* MAIN CHAT */}
            <div className={cn(
                'flex-1 flex-col min-w-0 bg-slate-50 dark:bg-slate-900 relative z-0 min-h-0',
                selectedChat ? 'flex' : 'hidden md:flex'
            )}>
                {selectedChat ? (
                    <>
                        {/* HEADER */}
                        <header className="flex-shrink-0 min-h-[4.5rem] border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-3 sm:px-5 bg-white dark:bg-slate-800 z-20 gap-2 py-2">
                            <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
                                <IconButton
                                    label="Volver a contactos"
                                    icon={ChevronLeft}
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => { setSelectedChatId(null); setSelectedChatFallback(null); }}
                                    className="md:hidden"
                                />

                                <div className="w-10 h-10 rounded-control bg-accent-600 text-white flex items-center justify-center font-semibold text-sm flex-shrink-0">
                                    {(selectedChat.name || selectedChat.id?.split('@')[0] || '??').toString().substring(0, 2).toUpperCase()}
                                </div>
                                <div className="min-w-0 flex flex-col justify-center">
                                    <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500 leading-none mb-0.5 tabular-nums">
                                        +{selectedChat.id?.split('@')[0]}
                                    </span>
                                    <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 flex-wrap">
                                        <h2 className="font-semibold text-slate-900 dark:text-slate-100 text-sm sm:text-base truncate max-w-[140px] sm:max-w-xs">
                                            {selectedChat.name || 'Desconocido'}
                                        </h2>
                                        {selectedChat.assignedScript && (
                                            <Badge tone="accent" size="sm">Flow: {selectedChat.assignedScript}</Badge>
                                        )}
                                    </div>
                                    <p className="text-[11px] font-medium flex items-center gap-1.5 mt-0.5">
                                        <span className={cn(
                                            'w-1.5 h-1.5 rounded-full',
                                            selectedChat.isPaused
                                                ? 'bg-danger-500 animate-pulse'
                                                : 'bg-success-500'
                                        )} />
                                        <span className={selectedChat.isPaused
                                            ? 'text-danger-600 dark:text-danger-500'
                                            : 'text-success-600 dark:text-success-500'
                                        }>
                                            {selectedChat.isPaused ? 'Auto-bot pausado' : 'Auto-bot activo'}
                                        </span>
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
                                {selectedChat.hasBought && (
                                    <IconButton
                                        label="Registro de compras"
                                        icon={ShoppingCart}
                                        variant="accent"
                                        size="sm"
                                        onClick={() => setShowOrdersPanel(v => !v)}
                                    />
                                )}
                                <IconButton
                                    label="Reiniciar historial"
                                    icon={Trash2}
                                    variant="danger"
                                    size="sm"
                                    onClick={handleClearChat}
                                />
                                <IconButton
                                    label={selectedChat.isPaused ? 'Reactivar bot' : 'Pausar bot'}
                                    icon={(globalPause || selectedChat.isPaused) ? Play : Pause}
                                    variant="subtle"
                                    size="sm"
                                    onClick={handleToggleBot}
                                    className={
                                        globalPause || selectedChat.isPaused
                                            ? '!bg-success-50 dark:!bg-success-900/30 !text-success-600 dark:!text-success-500'
                                            : '!bg-warning-50 dark:!bg-warning-900/30 !text-warning-600 dark:!text-warning-500'
                                    }
                                />
                                <div className="relative">
                                    <IconButton
                                        label="Tamaño de letra"
                                        icon={Type}
                                        variant="ghost"
                                        size="sm"
                                        onClick={(e) => { e.stopPropagation(); setShowFontSlider(v => !v); }}
                                    />
                                    {showFontSlider && (
                                        <Card padding="md" className="absolute top-12 right-0 w-60 z-50 animate-fade-in">
                                            <div className="flex justify-between items-center mb-2">
                                                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Tamaño letra</span>
                                                <span className="text-sm font-semibold text-accent-600 dark:text-accent-400 tabular-nums">{chatFontSize}px</span>
                                            </div>
                                            <input
                                                type="range" min="12" max="28" step="1"
                                                value={chatFontSize}
                                                onChange={(e) => setChatFontSize(parseInt(e.target.value, 10))}
                                                aria-label="Tamaño de letra del chat"
                                                className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-accent-600"
                                            />
                                        </Card>
                                    )}
                                </div>
                                <IconButton
                                    label="Panel de guión"
                                    icon={FileText}
                                    variant="subtle"
                                    size="sm"
                                    onClick={() => setShowScriptPanel(v => !v)}
                                    className="!bg-accent-50 dark:!bg-accent-900/30 !text-accent-600 dark:!text-accent-400"
                                />
                                <IconButton
                                    label="Resumir conversación"
                                    icon={Bot}
                                    variant="subtle"
                                    size="sm"
                                    onClick={handleSummarize}
                                    disabled={summarizing}
                                    className="!bg-info-50 dark:!bg-info-900/30 !text-info-600 dark:!text-info-500"
                                />
                            </div>
                        </header>

                        {/* Summary banner */}
                        {summaryText && (
                            <div className="mx-3 sm:mx-5 mt-3 p-3 rounded-control bg-info-50 dark:bg-info-900/20 border border-info-100 dark:border-info-900/40 text-sm relative flex-shrink-0">
                                <IconButton
                                    label="Cerrar resumen"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setSummaryText(null)}
                                    className="absolute top-1 right-1"
                                >
                                    <span aria-hidden="true">✕</span>
                                </IconButton>
                                <h4 className="font-semibold flex items-center gap-2 mb-1.5 text-info-700 dark:text-info-500 text-xs uppercase tracking-wide">
                                    <Bot className="w-3.5 h-3.5" aria-hidden="true" />
                                    Resumen de la conversación
                                </h4>
                                <p className="whitespace-pre-wrap text-slate-700 dark:text-slate-200 text-xs leading-relaxed pr-6">
                                    {summaryText}
                                </p>
                            </div>
                        )}

                        {/* Orders drawer */}
                        {showOrdersPanel && selectedChat.hasBought && (
                            <OrdersDrawer
                                pastOrders={selectedChat.pastOrders || []}
                                onClose={() => setShowOrdersPanel(false)}
                                onCopySale={handleCopySale}
                                onTrack={handleTrackOrder}
                                isTracking={isTracking}
                                trackingData={trackingData}
                            />
                        )}

                        {/* Alert banner */}
                        <AlertBanner
                            alert={chatAlert}
                            expanded={alertExpanded}
                            onToggle={() => setAlertExpanded(v => !v)}
                            onAlertAction={onAlertAction}
                            onPickReply={(msg) => { setInput(msg); setAlertExpanded(false); }}
                        />

                        {/* Mensajes virtualizados */}
                        <ChatMessageList
                            messages={messages}
                            isLoading={isLoadingMessages}
                            chatFontSize={chatFontSize}
                            handleDeleteMessage={handleDeleteMessage}
                            handleReportMessage={handleReportMessage}
                        />

                        {/* Input area */}
                        <ChatInputArea
                            input={input}
                            setInput={setInput}
                            attachment={attachment}
                            setAttachment={setAttachment}
                            handleSend={handleSend}
                            handleSendMedia={handleSendMedia}
                            sendingMedia={sendingMedia}
                            chatId={selectedChat?.id}
                        />
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center p-8">
                        <EmptyState
                            icon={MessageCircle}
                            title="Inbox de mensajes"
                            description="Seleccioná un chat del sidebar para empezar a responder."
                        />
                    </div>
                )}
            </div>

            {/* RIGHT PANEL: scripts/IA */}
            {selectedChat && showScriptPanel && (
                <ScriptPanel
                    onClose={() => setShowScriptPanel(false)}
                    summary={{ text: summaryText, generating: summarizing }}
                    onGenerateSummary={handleSummarize}
                    onClearSummary={() => setSummaryText(null)}
                    canSummarize={messages.length > 0}
                    scriptFlow={scriptFlow}
                    assignedScript={selectedChat.assignedScript}
                    formatScriptMessage={(text) => formatScriptMessage(text, selectedChat)}
                    onPickScriptStep={handlePickScriptStep}
                    onManualComplete={handleManualCompletion}
                />
            )}

            {/* Confirm-fill modal */}
            <Modal
                open={showConfirmFillModal}
                onClose={() => setShowConfirmFillModal(false)}
                title="Completar confirmación"
                subtitle="No se detectó toda la info del pedido en la conversación"
                size="lg"
            >
                <Modal.Body>
                    <div className="space-y-4">
                        <Select
                            label="Producto"
                            value={confirmFillData.product}
                            onChange={e => setConfirmFillData(d => ({ ...d, product: e.target.value }))}
                        >
                            <option value="">— Elegir producto —</option>
                            <option value="Cápsulas de Nuez de la India">Cápsulas de Nuez de la India</option>
                            <option value="Semillas de Nuez de la India">Semillas de Nuez de la India</option>
                            <option value="Gotas de Nuez de la India">Gotas de Nuez de la India</option>
                        </Select>
                        <Select
                            label="Plan"
                            value={confirmFillData.plan}
                            onChange={e => setConfirmFillData(d => ({ ...d, plan: e.target.value }))}
                        >
                            <option value="60">60 días</option>
                            <option value="120">120 días</option>
                        </Select>
                        <Input
                            label="Total a pagar"
                            type="text"
                            value={confirmFillData.total}
                            onChange={e => setConfirmFillData(d => ({ ...d, total: e.target.value }))}
                            placeholder="46.900"
                            leftIcon={() => <span className="text-slate-400 font-medium">$</span>}
                        />

                        {(confirmFillData.product || confirmFillData.total) && (
                            <div>
                                <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Vista previa</p>
                                <pre className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-control p-3 text-[11px] text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed max-h-44 overflow-y-auto font-sans">
                                    {buildConfirmMessage(confirmFillTemplate, confirmFillData)}
                                </pre>
                            </div>
                        )}
                    </div>
                </Modal.Body>

                <Modal.Footer>
                    <Button variant="secondary" onClick={() => setShowConfirmFillModal(false)}>
                        Cancelar
                    </Button>
                    <Button
                        onClick={() => {
                            if (!confirmFillData.product) { toast.warning('Elegí el producto'); return; }
                            if (!confirmFillData.total) { toast.warning('Ingresá el total'); return; }
                            if (!selectedChat.isPaused) handleToggleBot();
                            setInput(buildConfirmMessage(confirmFillTemplate, confirmFillData));
                            setShowConfirmFillModal(false);
                        }}
                    >
                        Insertar mensaje
                    </Button>
                </Modal.Footer>
            </Modal>

            {/* Manual MP Link Modal — abre cuando hacen click en payment_mp_link.
                Pide monto, crea preferencia MP real, y sustituye {{LINK}} en el template. */}
            <ManualMpLinkModal
                isOpen={showMpLinkModal}
                onClose={() => setShowMpLinkModal(false)}
                template={mpLinkTemplate}
                suggestedAmount={mpLinkSuggestedAmount}
                formatTemplate={(text, { link }) => {
                    const filled = formatScriptMessage(text, selectedChat);
                    return filled.replace(/\(link se genera al confirmar el pago\)/g, link)
                                 .replace(/{{LINK}}/g, link);
                }}
                onLinkReady={(finalMsg) => {
                    if (selectedChat && !selectedChat.isPaused) handleToggleBot();
                    setInput(finalMsg);
                    setShowMpLinkModal(false);
                }}
            />

            {/* AI Correction Modal — su propio sub-componente */}
            <AiCorrectionModal
                isOpen={showCorrectionModal}
                onClose={() => { setShowCorrectionModal(false); setReportedMsgId(null); }}
                messages={messages}
                reportedMsgId={reportedMsgId}
                selectedChat={selectedChat}
                onDeleteMessage={async (msgId) => {
                    try {
                        setMessages(prev => prev.filter(m => m.id !== msgId));
                        await deleteMessage({ chatId: selectedChat.id, messageId: msgId });
                    } catch (e) {
                        toast.error('Error eliminando mensaje del cliente');
                        throw e;
                    }
                }}
            />

            {/* Verificación de pedido — se abre SIEMPRE al confirmar (con o sin mensaje) */}
            <ManualOrderEntryModal
                open={!!manualEntry}
                chatId={manualEntry?.chatId}
                prefill={manualEntry?.prefill}
                silent={manualEntry?.silent}
                onClose={() => !submittingManual && setManualEntry(null)}
                onSubmit={handleManualEntrySubmit}
                submitting={submittingManual}
            />
        </div>
    );
};

export default CommsView;
