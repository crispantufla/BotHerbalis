import React, { useState, useEffect, useRef } from 'react';
import api from '../../config/axios';
import { useToast } from '../ui/Toast';
import { useChat } from '../../hooks/useChat';
import { useSeller } from '../../context/SellerContext';
import ChatMessageList from './components/ChatMessageList';
import ChatInputArea from './components/ChatInputArea';
import AiCorrectionModal from './components/AiCorrectionModal';
import ManualOrderEntryModal from './components/ManualOrderEntryModal';

import { Search, Bot, Play, Pause, Trash2 as Trash, FileText as ScriptIcon, ChevronDown, ChevronUp, Send, Paperclip, ShoppingCart, ArrowLeft, Type, X, Zap, AlertTriangle, Package } from 'lucide-react';

const CommsView = ({ initialChatId, onChatSelected, initialSearch = '', alerts = [], onAlertAction }) => {
    const { toast } = useToast();
    const { selectedSellerId } = useSeller();
    const [selectedChat, setSelectedChat] = useState(null);

    // Reset selected chat when admin switches seller
    useEffect(() => {
        setSelectedChat(null);
    }, [selectedSellerId]);
    const [input, setInput] = useState('');
    const [searchTerm, setSearchTerm] = useState(initialSearch);
    const [showScriptPanel, setShowScriptPanel] = useState(false);
    const [showOrdersPanel, setShowOrdersPanel] = useState(false);
    const [scriptFlow, setScriptFlow] = useState({});
    const [summarizing, setSummarizing] = useState(false);
    const [summaryText, setSummaryText] = useState(null);
    const [attachment, setAttachment] = useState(null);
    const [sendingMedia, setSendingMedia] = useState(false);
    const [isTracking, setIsTracking] = useState(false);
    const [trackingData, setTrackingData] = useState(null);
    const [prices, setPrices] = useState(null);

    const [chatFontSize, setChatFontSize] = useState(() => parseInt(localStorage.getItem('herbalis_chat_font_size') || '14', 10));
    const [showFontSlider, setShowFontSlider] = useState(false);
    const [searchResults, setSearchResults] = useState(null); // null = no hay query activa, [] = sin resultados
    const [isSearching, setIsSearching] = useState(false);
    const [manualEntry, setManualEntry] = useState(null); // { chatId, silent, prefill } o null
    const [submittingManual, setSubmittingManual] = useState(false);

    const [alertExpanded, setAlertExpanded] = useState(true);
    const [showCorrectionModal, setShowCorrectionModal] = useState(false);
    const [reportedMsgId, setReportedMsgId] = useState(null);
    const [showConfirmFillModal, setShowConfirmFillModal] = useState(false);
    const [confirmFillTemplate, setConfirmFillTemplate] = useState('');
    const [confirmFillData, setConfirmFillData] = useState({ product: '', plan: '60', total: '' });

    const {
        chats,
        messages,
        setMessages,
        isLoadingChats,
        isLoadingMessages,
        globalPause,
        instanceId,
        sendMessage,
        sendMedia,
        deleteMessage,
        toggleBot,
        clearChat
    } = useChat(selectedChat?.id);

    useEffect(() => {
        localStorage.setItem('herbalis_chat_font_size', chatFontSize);
    }, [chatFontSize]);

    // Búsqueda debounced contra el backend para encontrar conversaciones por
    // contenido de mensaje, número o nombre — incluso si el chat no está cargado
    // en memoria de whatsapp-web.js. Mientras el usuario tipea, mostramos el
    // filtro client-side (instantáneo) sobre los chats ya cargados; el resultado
    // del backend reemplaza la lista cuando llega.
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

    // Lista a mostrar:
    //   - sin búsqueda activa → chats normales (en memoria)
    //   - mientras espera el backend → filter client-side instantáneo
    //   - cuando llegan resultados → merge: backend + chats en memoria que
    //     matcheen por número/nombre. Esto cubre clientes manejados manualmente
    //     por el vendedor (que nunca pasaron por el bot, no tienen User en DB,
    //     pero sí están en la lista de chats de WhatsApp Web).
    const filteredChats = (() => {
        const term = searchTerm.trim();
        if (!term) return chats;

        // Filtro instantáneo de chats en memoria (WhatsApp Web), aplica siempre
        // para que el usuario nunca vea "no hay nada" si en realidad existe el chat.
        const lower = term.toLowerCase();
        const digits = term.replace(/\D/g, '');
        const inMemMatches = chats.filter(c => {
            const nameMatch = c.name?.toLowerCase().includes(lower);
            const phoneMatch = digits.length >= 4 && c.id?.replace(/\D/g, '').includes(digits);
            const messageMatch = typeof c.lastMessage?.body === 'string' && c.lastMessage.body.toLowerCase().includes(lower);
            return nameMatch || phoneMatch || messageMatch;
        });

        if (searchResults === null) return inMemMatches;

        // Merge: backend results primero (con snippet), luego chats en memoria
        // que matchearon pero no aparecieron en el backend (clientes que nunca
        // pasaron por el bot pero el vendedor les respondió a mano).
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

    // Auto-abrir el chat cuando la búsqueda devuelve exactamente 1 resultado.
    // Solo dispara después de que el backend respondió (searchResults !== null)
    // para no saltar prematuramente mientras todavía se está filtrando.
    const autoSelectId = (searchTerm.trim() && searchResults !== null && filteredChats.length === 1)
        ? filteredChats[0].id
        : null;
    useEffect(() => {
        if (!autoSelectId) return;
        if (selectedChat?.id === autoSelectId) return;
        const target = filteredChats.find(c => c.id === autoSelectId);
        if (target) setSelectedChat(target);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoSelectId]);

    // Computed property: find an active alert for the selected chat
    const chatAlert = selectedChat ? alerts.find(a => a.userPhone === selectedChat.id || a.userPhone === selectedChat.id.split('@')[0]) : null;

    useEffect(() => {
        if (initialChatId && chats.length > 0) {
            const chatToSelect = chats.find(c => c.id === initialChatId);
            setSelectedChat(chatToSelect || { id: initialChatId, name: initialChatId });
            if (onChatSelected) onChatSelected();
        }
    }, [initialChatId, chats, onChatSelected]);

    const [availableScripts, setAvailableScripts] = useState({ v3: {}, v4: {} });

    useEffect(() => {
        const fetchScriptAndPrices = async () => {
            try {
                const [scriptV3, scriptV4, pricesRes] = await Promise.all([
                    api.get('/api/script/v3'),
                    api.get('/api/script/v4'),
                    api.get('/api/prices')
                ]);

                const scripts = {
                    v3: scriptV3.data?.flow || {},
                    v4: scriptV4.data?.flow || {}
                };
                setAvailableScripts(scripts);
                // Fallback initial flow
                setScriptFlow(scripts.v3);

                if (pricesRes.data) setPrices(pricesRes.data);
            } catch (e) { console.error('Error fetching scripts:', e); }
        };
        fetchScriptAndPrices();
    }, []);

    useEffect(() => {
        if (!selectedChat) return;
        // Dynamically switch script flow based on user's assigned script
        const targetVersion = selectedChat.assignedScript || 'v3';
        if (availableScripts[targetVersion]) {
            setScriptFlow(availableScripts[targetVersion]);
        }
    }, [selectedChat, availableScripts]);

    useEffect(() => {
        if (!selectedChat) return;
        setSummaryText(null);
    }, [selectedChat?.id]);

    const formatScriptMessage = (text, chat = null) => {
        if (!text) return text;
        let result = text;
        if (prices) {
            let p = prices;
            result = result.replace(/{{PRICE_CAPSULAS_60}}/g, p['Cápsulas']?.['60'] || '46.900')
                .replace(/{{PRICE_CAPSULAS_120}}/g, p['Cápsulas']?.['120'] || '66.900')
                .replace(/{{PRICE_SEMILLAS_60}}/g, p['Semillas']?.['60'] || '36.900')
                .replace(/{{PRICE_SEMILLAS_120}}/g, p['Semillas']?.['120'] || '49.900')
                .replace(/{{PRICE_GOTAS_60}}/g, p['Gotas']?.['60'] || '48.900')
                .replace(/{{PRICE_GOTAS_120}}/g, p['Gotas']?.['120'] || '68.900')
                .replace(/{{ADICIONAL_MAX}}/g, p.adicionalMAX || '6.000')
                .replace(/{{COSTO_LOGISTICO}}/g, p.costoLogistico || '18.000');
        }
        // Resolve order-specific placeholders from the user's sales state
        const ctx = chat || selectedChat;
        if (ctx) {
            const product = ctx.selectedProduct || ctx.cart?.[0]?.product || 'Producto';
            const plan = ctx.selectedPlan || ctx.cart?.[0]?.plan || '60';
            let total = ctx.totalPrice || '';
            if (!total && ctx.cart?.length > 0) {
                total = ctx.cart.reduce((s, i) => s + parseInt((i.price || '0').toString().replace(/\D/g, '')), 0).toLocaleString('es-AR');
            }
            result = result.replace(/{{PRODUCT}}/g, product)
                .replace(/{{PLAN}}/g, plan)
                .replace(/{{TOTAL}}/g, total ? `$${total}` : '$0');
        }
        return result;
    };

    // Extract product/plan/total from chat state first, then fallback to scanning messages.
    // Plan is only trusted if the USER explicitly said 60 or 120 (not from the bot's price list).
    // Total is only trusted if the bot mentioned exactly one price (not a multi-option list).
    const extractConfirmationContext = () => {
        let product = selectedChat?.selectedProduct || selectedChat?.cart?.[0]?.product || null;
        let plan = selectedChat?.selectedPlan || selectedChat?.cart?.[0]?.plan || null;
        let total = selectedChat?.totalPrice || null;

        if (!product || !plan || !total) {
            const userText = messages.filter(m => !m.fromMe).map(m => m.body || '').join('\n');
            const botText  = messages.filter(m =>  m.fromMe).map(m => m.body || '').join('\n');
            const allText  = messages.map(m => m.body || '').join('\n');

            // Product: any message (bot usually echoes the choice)
            if (!product) {
                if (/c[áa]psulas?/i.test(allText)) product = 'Cápsulas de Nuez de la India';
                else if (/semillas?/i.test(allText)) product = 'Semillas de Nuez de la India';
                else if (/gotas?/i.test(allText))    product = 'Gotas de Nuez de la India';
            }

            // Plan: only from USER messages — bot shows both 60 & 120, so scanning all text gives false positives
            if (!plan) {
                if (/\b120\b/.test(userText)) plan = '120';
                else if (/\b60\b/.test(userText)) plan = '60';
            }

            // Total: only if the bot mentioned exactly ONE distinct price (not a price list)
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
        const costoLog = prices?.costoLogistico || '18.000';
        const totalStr = total ? (total.startsWith('$') ? total : `$${total}`) : '$0';
        return template
            .replace(/{{PRODUCT}}/g, product || 'Producto')
            .replace(/{{PLAN}}/g, plan || '60')
            .replace(/{{TOTAL}}/g, totalStr)
            .replace(/{{COSTO_LOGISTICO}}/g, costoLog)
            .replace(/{{ADICIONAL_MAX}}/g, prices?.adicionalMAX || '6.000');
    };

    const handleSummarize = async () => {
        if (!selectedChat) return;
        setSummarizing(true);
        try {
            const res = await api.get(`/api/summarize/${selectedChat.id}`);
            setSummaryText(res.data.summary || res.data.message);
        } catch (e) { toast.error('Error generando resumen'); }
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
                    // Formato: [10:56, 26/2/2026]
                    dateStr = `[${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })}, ${d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}] `;
                }
            } catch (e) { }

            const sender = msg.fromMe ? 'Herbalis' : (selectedChat.name || selectedChat.id).split('@')[0];
            let body = msg.body || '';

            // Clean up media placeholders if any
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
        catch (e) { toast.error('Error al enviar mensaje'); }
    };

    const handleSendScriptStep = (stepKey) => {
        const step = scriptFlow[stepKey];
        if (step?.response) setInput(formatScriptMessage(step.response, selectedChat));
    };

    // Manual order completion — admin clicks the final step button
    const handleManualCompletion = async (silent = false) => {
        if (!selectedChat) return;
        try {
            await api.post('/api/orders/manual-complete', { chatId: selectedChat.id, silent });
            toast.success(silent ? 'Venta registrada sin enviar confirmación ✅' : 'Pedido ingresado y confirmación enviada ✅');
            setInput('');
        } catch (e) {
            // Si el backend no pudo extraer datos, abrimos el modal de entrada manual
            if (e.response?.status === 422 && e.response?.data?.needsManualEntry) {
                setManualEntry({
                    chatId: selectedChat.id,
                    silent,
                    prefill: e.response.data.extracted || {}
                });
                return;
            }
            toast.error('Error al registrar pedido: ' + (e.response?.data?.error || e.message));
        }
    };

    // Submit del modal de entrada manual — re-llama a manual-complete con manualAddr.
    const handleManualEntrySubmit = async (manualAddr) => {
        if (!manualEntry) return;
        setSubmittingManual(true);
        try {
            await api.post('/api/orders/manual-complete', {
                chatId: manualEntry.chatId,
                silent: manualEntry.silent,
                manualAddr
            });
            toast.success(manualEntry.silent ? 'Venta registrada con datos manuales ✅' : 'Pedido ingresado con datos manuales ✅');
            setManualEntry(null);
            setInput('');
        } catch (e) {
            toast.error('Error al registrar pedido: ' + (e.response?.data?.error || e.message));
        } finally {
            setSubmittingManual(false);
        }
    };

    // Delete Message Action
    const handleDeleteMessage = async (msgId) => {
        if (!selectedChat || !msgId) return;
        if (!window.confirm('¿Eliminar este mensaje para todos?')) return;
        try {
            setMessages(prev => prev.filter(m => m.id !== msgId));
            await deleteMessage({ chatId: selectedChat.id, messageId: msgId });
            toast.success('Mensaje eliminado');
        } catch (e) {
            toast.error('Error eliminando mensaje');
        }
    };

    const handleToggleBot = async () => {
        const newStatus = !selectedChat.isPaused;
        try {
            await toggleBot({ chatId: selectedChat.id, paused: newStatus });
            setSelectedChat(prev => ({ ...prev, isPaused: newStatus }));
            toast.success(newStatus ? 'Bot pausado' : 'Bot reactivado');
        } catch (e) { toast.error('Error cambiando estado del bot'); }
    };

    const handleClearChat = async () => {
        if (window.confirm("¿Reiniciar historial de este usuario?")) {
            try {
                await clearChat(selectedChat.id);
                setMessages([]);
                toast.success('Chat reiniciado');
            } catch (e) {
                console.error("Error al reiniciar chat:", e);
                toast.error('Error: ' + (e.message));
            }
        }
    };

    const handleReportMessage = (msgId) => {
        if (!selectedChat) return;
        // Abrir el modal SINCRÓNICAMENTE antes de cualquier await — si abrimos
        // después del await el reconciler de React rompe con NotFoundError
        // ('insertBefore' on Node) y deja la pantalla en blanco.
        setReportedMsgId(msgId);
        setShowCorrectionModal(true);

        // Auto-pause bot en background — si falla no rompe el flujo del modal.
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
        } catch (e) {
            toast.error("Error al consultar seguimiento.");
        } finally {
            setIsTracking(false);
        }
    };

    const handleCopySale = (order) => {
        const rawPhone = selectedChat?.id?.split('@')[0] || '';
        const phoneDisplay = rawPhone.length > 13 ? `Oculto por Anuncio Meta (${rawPhone})` : rawPhone || 'Desconocido';

        const priceFormatted = order.precio || '0';
        const textToCopy = `Nombre: ${selectedChat?.name || order.nombre || 'Cliente'}
Dirección: ${order.calle}, ${order.ciudad} (CP: ${order.cp})
Producto: ${order.producto}
Plan: ${order.plan || '120'} Días
A pagar: $${priceFormatted}
Teléfono: ${phoneDisplay}`;

        navigator.clipboard.writeText(textToCopy)
            .then(() => toast.success('Venta copiada al portapapeles'))
            .catch(() => toast.error('Error al copiar venta'));
    };

    const handleSendMedia = async () => {
        setSendingMedia(true);
        const isPdf = attachment.mimetype === 'application/pdf';
        try {
            await sendMedia({
                chatId: selectedChat.id, base64: attachment.base64, mimetype: attachment.mimetype, filename: attachment.file.name, caption: input.trim()
            });
            const caption = input.trim();
            const label = isPdf ? `📎 PDF enviado (${attachment.file.name})` : '📷 Imagen enviada';
            const body = caption ? `${label}: ${caption}` : label;
            setMessages(prev => [...prev, { id: `temp-media-${Date.now()}`, fromMe: true, body, type: 'chat', timestamp: Date.now(), pending: true }]);
            setAttachment(null);
            setInput('');
        } catch (e) { toast.error(isPdf ? 'Error al enviar PDF' : 'Error al enviar imagen'); }
        setSendingMedia(false);
    };

    return (
        <div className="flex-1 w-full min-h-0 flex flex-col md:flex-row animate-fade-in relative overflow-hidden bg-slate-50 dark:bg-slate-900 rounded-[1.5rem] sm:rounded-[2rem] border border-slate-200 dark:border-slate-700/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
            {/* Ambient Background Glow */}
            <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-400/10 blur-[100px] rounded-full pointer-events-none"></div>
            <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-indigo-400/10 blur-[100px] rounded-full pointer-events-none"></div>

            {/* SIDEBAR: Contacts */}
            <div className={`w-full md:w-72 lg:w-[300px] xl:w-[340px] 2xl:w-[400px] md:flex-shrink-0 border-r border-slate-200 dark:border-slate-800 flex-col bg-white dark:bg-slate-800 z-10 ${selectedChat ? 'hidden md:flex' : 'flex flex-1'} min-h-0 overflow-hidden`}>
                {/* Search Header */}
                <div className="p-3 sm:p-5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800">
                    <div className="relative group">
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="Buscar chats..."
                            className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl pl-12 pr-4 py-3 text-sm focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-300 transition-all text-slate-800 dark:text-slate-100 shadow-inner font-medium placeholder:text-slate-400"
                        />
                        <span className="absolute left-4 top-3 text-slate-400 group-focus-within:text-indigo-500 transition-colors"><Search className="w-5 h-5" /></span>
                    </div>
                </div>

                {/* Contact List */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
                    {isSearching && (
                        <div className="px-4 py-2 text-xs text-slate-400 dark:text-slate-500 italic">Buscando en historial...</div>
                    )}
                    {searchTerm.trim().length >= 2 && !isSearching && filteredChats.length === 0 && (
                        <div className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                            Sin resultados para <span className="font-semibold text-slate-600 dark:text-slate-300">"{searchTerm}"</span>
                        </div>
                    )}
                    {isLoadingChats && chats.length === 0 ? (
                        Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className="p-4 mb-2 rounded-2xl animate-pulse bg-slate-100 dark:bg-slate-800/50 flex gap-3 h-[72px]">
                                <div className="flex-1 space-y-2">
                                    <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-1/2"></div>
                                    <div className="h-2 bg-slate-200 dark:bg-slate-700 rounded w-3/4"></div>
                                </div>
                            </div>
                        ))
                    ) : filteredChats.map(chat => (
                        <div key={chat.id} onClick={() => setSelectedChat(chat)} className={`p-4 mb-2 rounded-2xl flex cursor-pointer transition-all duration-300 ${selectedChat?.id === chat.id ? 'bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30 transform scale-[1.02]' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}>
                            <div className="flex-1 min-w-0">
                                <div className="flex justify-between items-start mb-1 gap-2">
                                    <div className="flex flex-col min-w-0">
                                        <div className="flex items-center gap-1.5 mb-0.5">
                                            <h3 className={`font-bold text-sm tracking-tight ${selectedChat?.id === chat.id ? 'text-white' : 'text-slate-800 dark:text-slate-100'}`}>
                                                +{(() => {
                                                    const rawId = chat.id?.split('@')[0] || '';
                                                    const cleanName = (chat.name || '').replace(/\D/g, '');
                                                    // Si el ID es un LID/Proxy (>13 chars) y el nombre parece un teléfono AR
                                                    if (rawId.length > 13 && cleanName.length >= 10 && cleanName.length <= 13) return cleanName;
                                                    // Si ambos son largos/ocultos
                                                    if (rawId.length > 13) return 'Anuncio (Oculto)';
                                                    return rawId;
                                                })()}
                                            </h3>
                                            {alerts.some(a => a.userPhone === chat.id || a.userPhone === chat.id.split('@')[0]) ? (
                                                <span className="w-2.5 h-2.5 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(243,24,66,0.8)] animate-pulse flex items-center justify-center" title="Atención Requerida">
                                                    <span className="text-[6px] text-white">⚡</span>
                                                </span>
                                            ) : chat.isPaused && (
                                                <span className="w-2 h-2 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)] animate-pulse" title="Bot Pausado"></span>
                                            )}
                                            {chat.hasBought && <span title="Cliente Recurrente" className="inline-flex items-center text-[9px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-md font-extrabold shadow-sm"><ShoppingCart className="w-2.5 h-2.5 mr-0.5" /> Cliente</span>}
                                        </div>
                                        <span className={`text-xs truncate ${selectedChat?.id === chat.id ? 'text-indigo-100/90' : 'text-slate-500 dark:text-slate-400'}`}>
                                            {(() => {
                                                const rawId = chat.id?.split('@')[0] || '';
                                                const rawName = chat.name || '';
                                                const cleanName = rawName.replace(/\D/g, '');

                                                // Si el nombre es el proxy/LID o un numero gigante
                                                if (rawName.includes('+47') || cleanName.length > 13) return 'Contacto de Anuncio';

                                                // Si el nombre es en realidad el telefono bueno (porque el ID era proxy)
                                                if (rawId.length > 13 && cleanName.length >= 10 && cleanName.length <= 13 && rawName.includes('+')) return 'Contacto de Anuncio';

                                                return rawName || 'Desconocido';
                                            })()}
                                        </span>
                                    </div>
                                    <span className={`text-xs font-bold font-mono mt-0.5 flex-shrink-0 ${selectedChat?.id === chat.id ? 'text-indigo-100' : 'text-slate-500 dark:text-slate-400'}`}>{chat.time}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    {chat.searchSnippet ? (
                                        <p className={`text-[13px] truncate font-medium flex-1 ${selectedChat?.id === chat.id ? 'text-indigo-100' : 'text-slate-500 dark:text-slate-300'}`} title={chat.searchSnippet}>
                                            <span className="text-[10px] uppercase font-bold mr-1 opacity-70">{chat.searchSnippetRole === 'user' ? 'cliente' : chat.searchSnippetRole === 'bot' ? 'bot' : ''}</span>
                                            {(() => {
                                                const term = searchTerm.trim();
                                                const text = chat.searchSnippet;
                                                const i = text.toLowerCase().indexOf(term.toLowerCase());
                                                if (i < 0) return text;
                                                const start = Math.max(0, i - 20);
                                                const end = Math.min(text.length, i + term.length + 40);
                                                const before = (start > 0 ? '…' : '') + text.slice(start, i);
                                                const match = text.slice(i, i + term.length);
                                                const after = text.slice(i + term.length, end) + (end < text.length ? '…' : '');
                                                return (<>
                                                    {before}
                                                    <mark className={selectedChat?.id === chat.id ? 'bg-yellow-300/50 text-white rounded px-0.5' : 'bg-yellow-200 dark:bg-yellow-700/60 text-slate-900 dark:text-yellow-100 rounded px-0.5'}>{match}</mark>
                                                    {after}
                                                </>);
                                            })()}
                                        </p>
                                    ) : (
                                        <p className={`text-[13px] truncate font-medium flex-1 ${selectedChat?.id === chat.id ? 'text-indigo-100' : 'text-slate-500 dark:text-slate-300'}`}>{chat.lastMessage?.body || 'Sin mensajes'}</p>
                                    )}
                                    {chat.unread > 0 && selectedChat?.id !== chat.id && (
                                        <span className="w-5 h-5 bg-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center shadow-md">
                                            {chat.unread}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* MAIN CHAT AREA */}
            <div className={`flex-1 flex-col min-w-0 bg-transparent relative z-0 ${selectedChat ? 'flex' : 'hidden md:flex'} min-h-0`}>
                {selectedChat ? (
                    <>
                        {/* Header */}
                        <div className="flex-shrink-0 min-h-[5rem] border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-3 sm:px-8 bg-white dark:bg-slate-800 shadow-[0_2px_10px_rgba(0,0,0,0.02)] z-20 overflow-hidden py-2 gap-2">
                            <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
                                {/* Back Button (Mobile Only) */}
                                <button
                                    onClick={() => setSelectedChat(null)}
                                    className="md:hidden p-2 -ml-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 shadow-sm transition-all"
                                    title="Volver a Contactos"
                                >
                                    <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 19l-7-7 7-7" /></svg>
                                </button>

                                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white flex items-center justify-center font-bold text-base sm:text-lg shadow-md shadow-indigo-500/20 flex-shrink-0">
                                    {(selectedChat.name || selectedChat.id?.split('@')[0] || '??').toString().substring(0, 2).toUpperCase()}
                                </div>
                                <div className="min-w-0 pr-2 flex flex-col justify-center">
                                    <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500 tracking-tight leading-none mb-0.5">
                                        +{selectedChat.id?.split('@')[0]}
                                    </span>
                                    <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 flex-wrap">
                                        <h2 className="font-extrabold text-slate-800 dark:text-slate-100 text-[14px] sm:text-lg tracking-tight truncate max-w-[130px] sm:max-w-xs">{selectedChat.name || 'Desconocido'}</h2>
                                        {selectedChat.assignedScript && (
                                            <span className="self-start sm:self-auto mt-0.5 sm:mt-0 px-2 sm:px-3 py-0.5 sm:py-1 rounded-full bg-indigo-100 text-[9px] sm:text-[10px] font-bold text-indigo-700 uppercase tracking-widest border border-indigo-200">
                                                Flow: {selectedChat.assignedScript}
                                            </span>
                                        )}
                                    </div>
                                    <p className={`text-[9px] sm:text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 mt-0.5 ${selectedChat.isPaused ? 'text-rose-500' : 'text-emerald-500'}`}>
                                        <span className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${selectedChat.isPaused ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'}`}></span>
                                        {selectedChat.isPaused ? 'Auto-Bot Pausado' : 'Auto-Bot Activo'}
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-center justify-end gap-1 sm:gap-3 flex-shrink-0">
                                {selectedChat.hasBought && (
                                    <button onClick={() => setShowOrdersPanel(!showOrdersPanel)} className="p-2 sm:p-3 flex-shrink-0 rounded-xl bg-indigo-100/80 text-indigo-700 hover:bg-indigo-200 hover:shadow-md transition-all" title="Registro de Compras">
                                        <ShoppingCart className="w-4 h-4 sm:w-5 sm:h-5" />
                                    </button>
                                )}

                                <button onClick={handleClearChat} className="p-2 sm:p-3 flex-shrink-0 rounded-xl bg-rose-100/80 text-rose-600 hover:bg-rose-200 hover:shadow-md transition-all" title="Reiniciar Memoria e Historial">
                                    <Trash className="w-4 h-4 sm:w-5 sm:h-5" />
                                </button>
                                <button onClick={handleToggleBot} className={`p-2 sm:p-3 flex-shrink-0 rounded-xl text-white shadow-md transition-all hover:brightness-110 hover:-translate-y-0.5 ${globalPause || selectedChat.isPaused ? 'bg-gradient-to-r from-emerald-500 to-teal-500' : 'bg-gradient-to-r from-amber-500 to-orange-500'}`} title={globalPause ? 'Bot Pausado Globalmente' : (selectedChat.isPaused ? 'Reactivar Auto-Bot' : 'Pausar Auto-Bot')}>
                                    {globalPause || selectedChat.isPaused ? <Play className="w-4 h-4 sm:w-5 sm:h-5" /> : <Pause className="w-4 h-4 sm:w-5 sm:h-5" />}
                                </button>
                                <div className="relative">
                                    <button onClick={(e) => { e.stopPropagation(); setShowFontSlider(!showFontSlider); }} className="p-2 sm:p-3 flex-shrink-0 rounded-xl bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-indigo-50 hover:text-indigo-600 transition-all shadow-sm" title="Tamaño de Letra">
                                        <Type className="w-4 h-4 sm:w-5 sm:h-5" />
                                    </button>
                                    {showFontSlider && (
                                        <div className="fixed top-[4.5rem] right-4 sm:right-16 md:right-32 lg:right-64 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl shadow-xl w-64 z-[9999] animate-fade-in flex flex-col gap-3">
                                            <div className="flex justify-between items-center">
                                                <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">Tamaño Letra</span>
                                                <span className="text-sm font-bold text-indigo-600">{chatFontSize}px</span>
                                            </div>
                                            <input
                                                type="range" min="12" max="28" step="1"
                                                value={chatFontSize}
                                                onChange={(e) => setChatFontSize(parseInt(e.target.value, 10))}
                                                className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                                            />
                                        </div>
                                    )}
                                </div>
                                <button onClick={() => setShowScriptPanel(!showScriptPanel)} className="p-2.5 sm:p-3 flex-shrink-0 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-md shadow-indigo-500/30 hover:shadow-lg hover:shadow-indigo-500/40 hover:-translate-y-0.5 transition-all active:scale-95" title="Guión">
                                    <ScriptIcon className="w-5 h-5" />
                                </button>
                                <button onClick={handleSummarize} disabled={summarizing} className="p-2.5 sm:p-3 flex-shrink-0 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-500 text-white shadow-md hover:-translate-y-0.5 transition-all disabled:opacity-50" title="Resumen Inteligente">
                                    {summarizing ? <div className="w-4 h-4 border-2 border-white/50 border-t-white rounded-full animate-spin mx-0.5"></div> : <Bot className="w-5 h-5" />}
                                </button>
                            </div>
                        </div>

                        {/* Summary Modal/Banner */}
                        {summaryText && (
                            <div className="mx-4 sm:mx-8 mt-4 p-4 rounded-xl bg-blue-50/90 dark:bg-blue-900/40 border border-blue-200 dark:border-blue-800 text-slate-800 dark:text-blue-100/90 relative shadow-sm text-sm">
                                <button onClick={() => setSummaryText(null)} className="absolute top-2 right-2 p-1.5 text-blue-400 hover:text-rose-500 transition-colors">✕</button>
                                <h4 className="font-bold flex items-center gap-2 mb-2"><Bot className="w-4 h-4 text-blue-600" /> Resumen de la Conversación</h4>
                                <div className="whitespace-pre-wrap">{summaryText}</div>
                            </div>
                        )}

                        {/* Orders Panel */}
                        {showOrdersPanel && selectedChat.hasBought && (
                            <div className="border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 sm:p-5 z-10 animate-fade-in shadow-sm relative overflow-hidden shrink-0">
                                <div className="absolute -top-10 -right-10 w-24 h-24 bg-indigo-400/20 blur-[40px] rounded-full pointer-events-none"></div>
                                <div className="absolute -bottom-10 -left-10 w-24 h-24 bg-purple-400/20 blur-[40px] rounded-full pointer-events-none"></div>

                                <div className="flex justify-between items-center mb-5 relative z-10">
                                    <div className="flex items-center gap-2">
                                        <div className="w-8 h-8 rounded-xl bg-indigo-100/80 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shadow-sm">
                                            <ShoppingCart className="w-4 h-4" />
                                        </div>
                                        <h3 className="font-extrabold text-slate-800 dark:text-slate-100 tracking-tight text-sm">Registro de Pedidos</h3>
                                        <span className="bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 text-[10px] font-bold px-2 py-0.5 rounded-full">{selectedChat.pastOrders?.length || 0}</span>
                                    </div>
                                    <button onClick={() => setShowOrdersPanel(false)} className="w-8 h-8 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-rose-500 bg-slate-50 dark:bg-slate-700/50 hover:bg-rose-50 dark:hover:bg-rose-900/30 rounded-xl transition-all border border-transparent shadow-sm hover:border-rose-100 dark:hover:border-rose-800/50">✕</button>
                                </div>

                                <div className="flex flex-col gap-5 max-h-[60vh] overflow-y-auto custom-scrollbar relative z-10 pr-1 pb-4">
                                    {selectedChat.pastOrders?.map((order, i) => (
                                        <div key={i} className="bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 p-4 sm:p-5 rounded-2xl flex flex-col shadow-sm hover:shadow-md transition-shadow relative overflow-hidden">

                                            {/* Header de Tarjeta */}
                                            <div className="flex justify-between items-center mb-4 pb-3 border-b border-slate-100 dark:border-slate-700">
                                                <div className="flex items-center gap-3">
                                                    <span className="px-3 py-1 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 text-[10px] font-black uppercase tracking-widest rounded-lg border border-indigo-100 dark:border-indigo-800/50">{order.status || 'Completado'}</span>
                                                    <span className="text-[11px] font-bold text-slate-400 dark:text-slate-500 font-mono">{order.createdAt || 'Fecha desconocida'}</span>
                                                </div>
                                                <button onClick={() => handleCopySale(order)} className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white text-[10px] font-bold uppercase tracking-wider rounded-lg transition-colors shadow-md shadow-indigo-500/30">
                                                    <ScriptIcon className="w-3 h-3" /> Copiar Venta
                                                </button>
                                            </div>

                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                                {/* Columna 1: Destino y Logística */}
                                                <div>
                                                    <h4 className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">Destino de Entrega</h4>
                                                    <div className="space-y-3">
                                                        <div className="grid grid-cols-2 gap-2 text-[12px]">
                                                            <div>
                                                                <span className="text-slate-500 dark:text-slate-400 font-medium">Ubicación:</span>
                                                                <p className="font-bold text-slate-800 dark:text-slate-200">{order.ciudad}</p>
                                                            </div>
                                                            <div>
                                                                <span className="text-slate-500 dark:text-slate-400 font-medium">C. Postal:</span>
                                                                <p className="font-bold text-slate-800 dark:text-slate-200">{order.cp || '-'}</p>
                                                            </div>
                                                            <div className="col-span-2">
                                                                <span className="text-slate-500 dark:text-slate-400 font-medium">Domicilio:</span>
                                                                <p className="font-bold text-slate-800 dark:text-slate-200">{order.calle || '-'}</p>
                                                            </div>
                                                        </div>

                                                        {order.tracking && (
                                                            <div className="pt-3 mt-3 border-t border-slate-100 dark:border-slate-700 flex flex-col gap-2">
                                                                <div className="flex items-center justify-between">
                                                                    <div>
                                                                        <span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-0.5">Tracking TCA</span>
                                                                        <span className="font-mono text-xs font-bold text-slate-700 dark:text-slate-200">{order.tracking}</span>
                                                                    </div>
                                                                    <button onClick={() => handleTrackOrder(order.tracking)} disabled={isTracking} className="bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-600 dark:text-blue-400 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors border border-blue-200 dark:border-blue-800/50 flex items-center gap-1.5 disabled:opacity-50">
                                                                        {isTracking ? 'Consultando...' : '🔍 Rastrear'}
                                                                    </button>
                                                                </div>

                                                                {/* Historial Tracking */}
                                                                {trackingData && (
                                                                    <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 rounded-lg p-2 max-h-40 overflow-y-auto custom-scrollbar mt-2 shadow-inner">
                                                                        {trackingData.success ? (
                                                                            trackingData.events && trackingData.events.length > 0 ? (
                                                                                <div className="space-y-2">
                                                                                    {trackingData.events.map((ev, i) => (
                                                                                        <div key={i} className="bg-white dark:bg-slate-800 p-2 rounded flex flex-col shadow-sm text-[10px] border border-slate-100 dark:border-slate-700">
                                                                                            <span className="font-bold text-slate-700 dark:text-slate-200">{ev.fecha} - <span className="text-blue-500 dark:text-blue-400">{ev.planta}</span></span>
                                                                                            <span className="text-slate-500 dark:text-slate-400 line-clamp-2">{ev.historia}</span>
                                                                                        </div>
                                                                                    ))}
                                                                                </div>
                                                                            ) : <p className="text-xs text-slate-500 dark:text-slate-400 italic">Aún no hay movimientos</p>
                                                                        ) : <p className="text-xs text-rose-500 dark:text-rose-400 font-bold">Tracking Inválido</p>}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* Columna 2: Mercadería */}
                                                <div className="md:border-l md:border-slate-100 dark:md:border-slate-700 md:pl-6">
                                                    <h4 className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">Mercadería Adquirida</h4>
                                                    <div className="space-y-3">
                                                        <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-3 border border-slate-100 dark:border-slate-700">
                                                            <p className="text-slate-800 dark:text-slate-100 font-extrabold text-sm mb-1">{order.producto}</p>
                                                            <p className="text-indigo-600 dark:text-indigo-400 font-bold text-[11px]">Tratamiento de {order.plan} días</p>
                                                        </div>

                                                        <div className="flex justify-between items-end pt-2">
                                                            <span className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">A Pagar</span>
                                                            <span className="text-emerald-600 dark:text-emerald-400 font-black text-xl">${order.precio || '0'}</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                        </div>
                                    ))}
                                    {(!selectedChat.pastOrders || selectedChat.pastOrders.length === 0) && (
                                        <div className="text-center p-8 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-700 border-dashed">
                                            <p className="text-slate-400 dark:text-slate-500 font-medium text-sm">No hay registros de compras anteriores.</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Inline Alert Banner */}
                        {chatAlert && (
                            <div className="border-b border-rose-200 dark:border-rose-800 shrink-0 z-10 relative overflow-hidden bg-gradient-to-r from-rose-50 dark:from-rose-900/30 via-pink-50 dark:via-pink-900/20 to-orange-50 dark:to-orange-900/30">
                                {/* Header — always visible */}
                                <div className="flex items-center justify-between gap-2 p-3 sm:p-4 cursor-pointer" onClick={() => setAlertExpanded(v => !v)}>
                                    <div className="flex items-center gap-3 min-w-0 flex-1">
                                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 shadow-md shadow-rose-500/30 flex items-center justify-center shrink-0">
                                            <AlertTriangle className="w-4 h-4 text-white" />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2 mb-0.5">
                                                <span className="bg-rose-500 text-white text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md shrink-0">Atención</span>
                                                <h4 className="font-extrabold text-slate-800 dark:text-rose-100 text-sm truncate">{chatAlert.reason || 'Notificación del Sistema'}</h4>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {chatAlert?.reason?.includes('Pedido') && onAlertAction && (
                                            <button onClick={(e) => { e.stopPropagation(); onAlertAction(chatAlert.userPhone, 'confirmar'); }} className="px-3 py-1.5 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white text-[10px] font-black uppercase tracking-wider rounded-lg shadow-sm transition-all">
                                                Aprobar
                                            </button>
                                        )}
                                        {onAlertAction && (
                                            <button onClick={(e) => { e.stopPropagation(); onAlertAction(chatAlert.userPhone, 'descartar'); }} className="p-1.5 rounded-lg text-rose-400 hover:text-white hover:bg-rose-500 transition-all" title="Descartar alerta">
                                                <Trash className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                        {alertExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                                    </div>
                                </div>

                                {/* Expanded content — details + suggestions */}
                                {alertExpanded && (
                                    <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-3">
                                        {/* Product/Plan status card */}
                                        {chatAlert.orderData && (chatAlert.orderData.product || chatAlert.orderData.step) && (
                                            <div className="flex flex-wrap items-center gap-2 bg-indigo-50 dark:bg-indigo-900/20 rounded-xl p-3 border border-indigo-100 dark:border-indigo-900/40">
                                                <p className="text-[10px] font-bold text-indigo-500 dark:text-indigo-400 uppercase tracking-widest w-full mb-1">Pedido actual</p>
                                                {chatAlert.orderData.product && (
                                                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-100 dark:bg-indigo-800/40 text-xs font-bold text-indigo-700 dark:text-indigo-300">
                                                        <Package className="w-3 h-3" /> {chatAlert.orderData.product}
                                                    </span>
                                                )}
                                                {chatAlert.orderData.plan && (
                                                    <span className="inline-flex items-center px-2 py-1 rounded-lg bg-violet-100 dark:bg-violet-800/40 text-xs font-bold text-violet-700 dark:text-violet-300">
                                                        {chatAlert.orderData.plan} días
                                                    </span>
                                                )}
                                                {chatAlert.orderData.price && (
                                                    <span className="inline-flex items-center px-2 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-800/40 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                                                        ${chatAlert.orderData.price}
                                                    </span>
                                                )}
                                                {chatAlert.orderData.step && (
                                                    <span className="inline-flex items-center px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700/40 text-xs font-medium text-slate-600 dark:text-slate-300">
                                                        Paso: {chatAlert.orderData.step.replace('waiting_', '').replace(/_/g, ' ')}
                                                    </span>
                                                )}
                                            </div>
                                        )}

                                        {/* Alert details */}
                                        {chatAlert.details && (
                                            <div className="bg-white/60 dark:bg-slate-800/60 rounded-xl p-3 border border-rose-100 dark:border-rose-900/40">
                                                <p className="text-[10px] font-bold text-rose-500 dark:text-rose-400 uppercase tracking-widest mb-1.5">Detalles de la alerta</p>
                                                <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-wrap">{chatAlert.details}</p>
                                            </div>
                                        )}

                                        {/* Quick reply suggestion buttons */}
                                        {chatAlert.quickReplies && chatAlert.quickReplies.length > 0 && (
                                            <div>
                                                <p className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                                                    <Zap className="w-3 h-3" /> Sugerencias
                                                </p>
                                                <div className="flex flex-col gap-1.5">
                                                    {chatAlert.quickReplies.map((qr, i) => (
                                                        <button
                                                            key={i}
                                                            onClick={() => { setInput(qr.message); setAlertExpanded(false); }}
                                                            className="text-left w-full px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-indigo-300 dark:hover:border-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all group"
                                                        >
                                                            <span className="text-[10px] font-bold text-indigo-500 dark:text-indigo-400 uppercase tracking-wider">{qr.label}</span>
                                                            <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5 leading-snug">{qr.message}</p>
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Messages Area (Virtualized) */}
                        <ChatMessageList
                            messages={messages}
                            isLoading={isLoadingMessages}
                            chatFontSize={chatFontSize}
                            handleDeleteMessage={handleDeleteMessage}
                            handleReportMessage={handleReportMessage}
                        />

                        {/* Input Area */}
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
                    <div className="flex-1 flex items-center justify-center p-12">
                        <div className="text-center">
                            <div className="w-24 h-24 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-6 shadow-sm border border-slate-200 dark:border-slate-700">
                                <span className="text-4xl">👋</span>
                            </div>
                            <h2 className="text-2xl font-extrabold text-slate-800 dark:text-slate-100 mb-2">Inbox de Mensajes V2</h2>
                            <p className="text-slate-500 dark:text-slate-400 font-medium">Seleccioná un chat del sidebar para iniciar a responder</p>
                        </div>
                    </div>
                )}
            </div>

            {/* RIGHT PANEL - AI & Scripts Context Drawer (V3 Ported to V2) */}
            {selectedChat && showScriptPanel && (
                <div className="w-full md:w-[350px] shrink-0 border-l border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex flex-col z-30 md:relative absolute right-0 top-0 bottom-0 overflow-y-auto animate-fade-in shadow-[-10px_0_30px_rgba(0,0,0,0.05)] h-full">

                    <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-white dark:bg-slate-800 shadow-sm z-10 sticky top-0">
                        <h3 className="font-extrabold text-slate-800 dark:text-slate-100 text-[15px] flex items-center gap-2">
                            <Bot className="w-5 h-5" /> Asistente IA
                        </h3>
                        <button onClick={() => setShowScriptPanel(false)} className="p-1.5 text-slate-400 dark:text-slate-500 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-xl transition-all">
                            ✕
                        </button>
                    </div>

                    <div className="p-5 flex-1 flex flex-col gap-6 custom-scrollbar overflow-y-auto">

                        {/* Summary Block */}
                        <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 shadow-sm border border-slate-200 dark:border-slate-700 relative group">
                            <div className="flex justify-between items-center mb-3">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">Contexto IA</h4>
                                <button onClick={handleSummarize} disabled={summarizing || messages.length === 0} className="text-[10px] font-bold text-indigo-700 bg-indigo-100/80 px-2.5 py-1 rounded-lg hover:bg-indigo-200 transition-colors disabled:opacity-50">
                                    {summarizing ? 'Generando...' : 'Resumir Chat'}
                                </button>
                            </div>
                            <div className="min-h-[80px]">
                                {summaryText ? (
                                    <div className="text-xs font-medium text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">
                                        {summaryText}
                                        <button onClick={() => setSummaryText(null)} className="absolute top-2 right-2 text-slate-400 hover:text-rose-500 bg-slate-100 dark:bg-slate-700 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"><Trash className="w-5 h-5" /></button>
                                    </div>
                                ) : (
                                    <span className="text-slate-400 italic text-xs flex items-center h-full justify-center text-center">Analiza la intención de compra y sentimientos del cliente.</span>
                                )}
                            </div>
                        </div>

                        {/* Script Injection Area */}
                        <div className="flex-1 pb-6">
                            <div className="flex items-center justify-between mb-3 px-1">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">Guión Sugerido</h4>
                                <span className="bg-white dark:bg-slate-800 shadow-sm border border-slate-200 dark:border-slate-700 text-indigo-600 dark:text-indigo-400 text-[9px] px-2 py-0.5 rounded-md font-bold uppercase tracking-wider">{selectedChat.assignedScript || 'V3'}</span>
                            </div>

                            {Object.keys(scriptFlow).length > 0 ? (
                                <div className="space-y-2.5">
                                    {Object.keys(scriptFlow).map((stepKey) => {
                                        const step = scriptFlow[stepKey];
                                        if (!step?.response) return null;
                                        return (
                                            <button
                                                key={stepKey}
                                                onClick={() => {
                                                    if (stepKey === 'confirmation') {
                                                        const ctx = extractConfirmationContext();
                                                        if (ctx.product && ctx.plan && ctx.total) {
                                                            if (!selectedChat.isPaused) handleToggleBot();
                                                            setInput(buildConfirmMessage(step.response, ctx));
                                                        } else {
                                                            setConfirmFillData({ product: ctx.product || '', plan: ctx.plan || '60', total: ctx.total || '' });
                                                            setConfirmFillTemplate(step.response);
                                                            setShowConfirmFillModal(true);
                                                        }
                                                    } else {
                                                        if (!selectedChat.isPaused) handleToggleBot();
                                                        setInput(formatScriptMessage(step.response, selectedChat));
                                                    }
                                                }}
                                                className="w-full text-left p-3.5 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-indigo-300 transition-all shadow-sm hover:shadow-md group cursor-pointer relative overflow-hidden"
                                            >
                                                <div className="absolute top-0 right-0 w-12 h-12 bg-indigo-50 dark:bg-indigo-900/30 rounded-bl-full -mr-6 -mt-6 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                                                <div className="flex items-center justify-between mb-2 text-[10px] font-black text-slate-400 dark:text-slate-300 uppercase tracking-widest group-hover:text-indigo-600 dark:group-hover:text-indigo-400 relative z-10 transition-colors">
                                                    <span>{stepKey.replace(/_/g, ' ')}</span>
                                                    <span className="opacity-0 group-hover:opacity-100 transform translate-x-2 group-hover:translate-x-0 transition-all duration-300">Insertar +</span>
                                                </div>
                                                <p className="text-[11.5px] text-slate-700 dark:text-slate-200 font-medium line-clamp-3 leading-relaxed relative z-10">
                                                    {formatScriptMessage(step.response, selectedChat)}
                                                </p>
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : (
                                <p className="text-xs text-slate-400 italic text-center mt-6 bg-slate-50 dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700">No hay módulos de guión en este flow.</p>
                            )}
                        </div>

                        {/* Manual Completion Buttons */}
                        <div className="px-1 pb-6 flex flex-col gap-2">
                            <button
                                onClick={() => {
                                    if (!selectedChat.isPaused) handleToggleBot();
                                    handleManualCompletion(false);
                                }}
                                className="w-full text-left p-4 rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/60 hover:bg-emerald-100 hover:border-emerald-400 transition-all shadow-sm hover:shadow-md group cursor-pointer relative overflow-hidden"
                            >
                                <div className="flex items-center justify-between mb-2 text-[10px] font-black text-emerald-600 uppercase tracking-widest relative z-10">
                                    <span>🚀 Pedido Ingresado</span>
                                    <span className="opacity-0 group-hover:opacity-100 transform translate-x-2 group-hover:translate-x-0 transition-all duration-300">Confirmar Venta</span>
                                </div>
                                <p className="text-[11.5px] text-emerald-700 font-medium leading-relaxed relative z-10 line-clamp-2">
                                    Envía la confirmación final y registra el pedido en Ventas automáticamente.
                                </p>
                            </button>
                            <button
                                onClick={() => {
                                    if (!selectedChat.isPaused) handleToggleBot();
                                    handleManualCompletion(true);
                                }}
                                className="w-full text-left p-4 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/60 hover:bg-slate-100 hover:border-slate-400 transition-all shadow-sm hover:shadow-md group cursor-pointer"
                            >
                                <div className="flex items-center justify-between mb-2 text-[10px] font-black text-slate-500 uppercase tracking-widest">
                                    <span>📋 Solo Registrar</span>
                                    <span className="opacity-0 group-hover:opacity-100 transform translate-x-2 group-hover:translate-x-0 transition-all duration-300">Sin mensaje</span>
                                </div>
                                <p className="text-[11.5px] text-slate-500 font-medium leading-relaxed line-clamp-2">
                                    Registra la venta sin enviar confirmación al cliente.
                                </p>
                            </button>
                        </div>

                    </div>
                </div>
            )}

            {/* Confirmation Fill Modal */}
            {showConfirmFillModal && (
                <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setShowConfirmFillModal(false)} />
                    <div className="relative z-10 w-full max-w-lg bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                        {/* Header */}
                        <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-indigo-50 dark:bg-indigo-900/20">
                            <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 flex items-center justify-center">
                                    <ShoppingCart className="w-4 h-4" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-extrabold text-slate-800 dark:text-slate-100">Completar confirmación</h2>
                                    <p className="text-xs text-slate-500 font-medium">No se detectó toda la info del pedido en la conversación</p>
                                </div>
                            </div>
                            <button onClick={() => setShowConfirmFillModal(false)} className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        {/* Fields */}
                        <div className="p-5 space-y-4 overflow-y-auto custom-scrollbar">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1.5">Producto</label>
                                <select
                                    value={confirmFillData.product}
                                    onChange={e => setConfirmFillData(d => ({ ...d, product: e.target.value }))}
                                    className="w-full bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400 text-slate-800 dark:text-slate-100"
                                >
                                    <option value="">— Elegir producto —</option>
                                    <option value="Cápsulas de Nuez de la India">Cápsulas de Nuez de la India</option>
                                    <option value="Semillas de Nuez de la India">Semillas de Nuez de la India</option>
                                    <option value="Gotas de Nuez de la India">Gotas de Nuez de la India</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1.5">Plan</label>
                                <select
                                    value={confirmFillData.plan}
                                    onChange={e => setConfirmFillData(d => ({ ...d, plan: e.target.value }))}
                                    className="w-full bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400 text-slate-800 dark:text-slate-100"
                                >
                                    <option value="60">60 días</option>
                                    <option value="120">120 días</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1.5">Total a pagar</label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">$</span>
                                    <input
                                        type="text"
                                        value={confirmFillData.total}
                                        onChange={e => setConfirmFillData(d => ({ ...d, total: e.target.value }))}
                                        placeholder="46.900"
                                        className="w-full bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl pl-7 pr-3 py-2.5 text-sm focus:outline-none focus:border-indigo-400 text-slate-800 dark:text-slate-100"
                                    />
                                </div>
                            </div>
                            {/* Live preview */}
                            {(confirmFillData.product || confirmFillData.total) && (
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1.5">Vista previa</label>
                                    <pre className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-3 text-[11px] text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed max-h-44 overflow-y-auto font-sans">
                                        {buildConfirmMessage(confirmFillTemplate, confirmFillData)}
                                    </pre>
                                </div>
                            )}
                        </div>
                        {/* Footer */}
                        <div className="p-5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex justify-end gap-3">
                            <button onClick={() => setShowConfirmFillModal(false)} className="px-5 py-2.5 rounded-xl font-bold text-slate-600 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors">
                                Cancelar
                            </button>
                            <button
                                onClick={() => {
                                    if (!confirmFillData.product) { toast.warning('Elegí el producto'); return; }
                                    if (!confirmFillData.total) { toast.warning('Ingresá el total'); return; }
                                    if (!selectedChat.isPaused) handleToggleBot();
                                    setInput(buildConfirmMessage(confirmFillTemplate, confirmFillData));
                                    setShowConfirmFillModal(false);
                                }}
                                className="px-6 py-2.5 rounded-xl font-bold text-white bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 shadow-md transition-all"
                            >
                                Insertar mensaje
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* AI Correction Modal */}
            <AiCorrectionModal
                isOpen={showCorrectionModal}
                onClose={() => {
                    setShowCorrectionModal(false);
                    setReportedMsgId(null);
                }}
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

            {/* Manual Order Entry Modal — abierto cuando el backend devuelve 422 */}
            <ManualOrderEntryModal
                open={!!manualEntry}
                chatId={manualEntry?.chatId}
                prefill={manualEntry?.prefill}
                onClose={() => !submittingManual && setManualEntry(null)}
                onSubmit={handleManualEntrySubmit}
                submitting={submittingManual}
            />
        </div>
    );
};

export default CommsView;
