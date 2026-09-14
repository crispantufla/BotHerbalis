import React, { useState, useEffect, useMemo } from 'react';
import { Search, MessageCircle } from 'lucide-react';

import api from '../../config/axios';
import { useChat } from '../../hooks/useChat';
import { useSeller } from '../../context/SellerContext';

import { Input, EmptyState, useToast, cn } from '../ui';

import ChatMessageList from './components/ChatMessageList';
import ChatInputArea from './components/ChatInputArea';
import AiCorrectionModal from './components/AiCorrectionModal';
import ManualOrderEntryModal from './components/ManualOrderEntryModal';
import ManualMpLinkModal from './components/ManualMpLinkModal';

import ChatSidebarItem from './comms/ChatSidebarItem';
import AlertBanner from './comms/AlertBanner';
import OrdersDrawer from './comms/OrdersDrawer';
import ScriptPanel from './comms/ScriptPanel';
import ChatHeader from './comms/ChatHeader';
import SummaryBanner from './comms/SummaryBanner';
import ConfirmFillModal from './comms/ConfirmFillModal';
import { useChatSearch } from './comms/useChatSearch';
import { useScriptFlow } from './comms/useScriptFlow';
import { formatScriptMessage, extractConfirmationContext, buildConfirmMessage } from './comms/scriptTemplates';
import { downloadChatHistory } from './comms/chatHistoryText';

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
    const [showScriptPanel, setShowScriptPanel] = useState(false);
    const [showOrdersPanel, setShowOrdersPanel] = useState(false);
    const [alertExpanded, setAlertExpanded] = useState(true);

    // Datos
    const [summarizing, setSummarizing] = useState(false);
    const [summaryText, setSummaryText] = useState(null);
    const [attachment, setAttachment] = useState(null);
    const [sendingMedia, setSendingMedia] = useState(false);
    const [isTracking, setIsTracking] = useState(false);
    const [trackingData, setTrackingData] = useState(null);

    const [chatFontSize, setChatFontSize] = useState(
        () => parseInt(localStorage.getItem('herbalis_chat_font_size') || '14', 10)
    );

    // Modales
    const [manualEntry, setManualEntry] = useState(null);
    const [submittingManual, setSubmittingManual] = useState(false);
    const [showCorrectionModal, setShowCorrectionModal] = useState(false);
    const [reportedMsgId, setReportedMsgId] = useState(null);
    // Modales del panel de guion: { template, data } y { template, suggestedAmount }, o null.
    const [confirmFill, setConfirmFill] = useState(null);
    const [mpLink, setMpLink] = useState(null);

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

    const { searchTerm, setSearchTerm, searchResults, isSearching, filteredChats } = useChatSearch(chats);
    const { scriptFlow, prices } = useScriptFlow();

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

    // Al cambiar de chat se borra el resumen del anterior.
    useEffect(() => {
        if (!selectedChatId) return;
        setSummaryText(null);
    }, [selectedChatId]);

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
        downloadChatHistory(messages, selectedChat);
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
            setMpLink({ template: scriptResponse, suggestedAmount: String(suggested).replace(/\./g, '') || '' });
            return;
        }

        // order_confirmation_* → si el extractor detecta product+plan+total, se inserta
        // directo. Si falta algo, abrimos el modal con selector para completar.
        if (stepKey.startsWith('order_confirmation_') || stepKey === 'confirmation') {
            const ctx = extractConfirmationContext(selectedChat, messages);
            if (ctx.product && ctx.plan && ctx.total) {
                if (!selectedChat.isPaused) handleToggleBot();
                setInput(buildConfirmMessage(scriptResponse, ctx, prices));
            } else {
                setConfirmFill({ template: scriptResponse, data: { product: ctx.product || '', plan: ctx.plan || '60', total: ctx.total || '' } });
            }
            return;
        }

        // Default: inserta el template formateado en el input.
        if (!selectedChat.isPaused) handleToggleBot();
        setInput(formatScriptMessage(scriptResponse, { chat: selectedChat, prices }));
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
                        <ChatHeader
                            chat={selectedChat}
                            globalPause={globalPause}
                            chatFontSize={chatFontSize}
                            onChatFontSizeChange={setChatFontSize}
                            summarizing={summarizing}
                            onBack={() => { setSelectedChatId(null); setSelectedChatFallback(null); }}
                            onToggleOrders={() => setShowOrdersPanel(v => !v)}
                            onClearChat={handleClearChat}
                            onToggleBot={handleToggleBot}
                            onToggleScriptPanel={() => setShowScriptPanel(v => !v)}
                            onSummarize={handleSummarize}
                        />

                        <SummaryBanner text={summaryText} onClose={() => setSummaryText(null)} />

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
                    formatScriptMessage={(text) => formatScriptMessage(text, { chat: selectedChat, prices })}
                    onPickScriptStep={handlePickScriptStep}
                    onManualComplete={handleManualCompletion}
                />
            )}

            <ConfirmFillModal
                state={confirmFill}
                prices={prices}
                onChange={(patch) => setConfirmFill(cf => ({ ...cf, data: { ...cf.data, ...patch } }))}
                onClose={() => setConfirmFill(null)}
                onInsert={(message) => {
                    if (!selectedChat.isPaused) handleToggleBot();
                    setInput(message);
                    setConfirmFill(null);
                }}
            />

            {/* Manual MP Link Modal — abre cuando hacen click en payment_mp_link.
                Pide monto, crea preferencia MP real, y sustituye {{LINK}} en el template. */}
            <ManualMpLinkModal
                isOpen={!!mpLink}
                onClose={() => setMpLink(null)}
                template={mpLink?.template}
                suggestedAmount={mpLink?.suggestedAmount}
                formatTemplate={(text, { link }) => {
                    const filled = formatScriptMessage(text, { chat: selectedChat, prices });
                    return filled.replace(/\(link se genera al confirmar el pago\)/g, link)
                                 .replace(/{{LINK}}/g, link);
                }}
                onLinkReady={(finalMsg) => {
                    if (selectedChat && !selectedChat.isPaused) handleToggleBot();
                    setInput(finalMsg);
                    setMpLink(null);
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
