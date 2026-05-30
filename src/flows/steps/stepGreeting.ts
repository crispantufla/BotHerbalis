import path from 'path';
import fs from 'fs';
import { UserState } from '../../types/state';
import { MessageMedia } from 'whatsapp-web.js';
import { _formatMessage } from '../utils/messages';
import { _setStep } from '../utils/flowHelpers';
import logger from '../../utils/logger';

interface GreetingDependencies {
    client: any;
    sendMessageWithDelay: (chatId: string, content: string) => Promise<void>;
    saveState: (userId: string) => void;
    effectiveScript?: string;
    config?: { scriptStats?: Record<string, { started: number; completed: number }>; activeScript?: string };
    aiService?: any;
}

export async function handleGreeting(
    userId: string,
    text: string,
    currentState: UserState,
    knowledge: any,
    dependencies: GreetingDependencies
): Promise<{ matched: boolean }> {
    const { client, sendMessageWithDelay, saveState } = dependencies;
    // We defer requiring processSalesFlow to prevent circular dependency issues
    const { processSalesFlow } = require('../salesFlow');

    // --- CHECK: Manual greeting already sent by admin ---
    const existingHistory = currentState.history || [];
    const hasManualGreeting = existingHistory.some(m =>
        m.role === 'bot' &&
        (m.content.includes('Buscás bajar hasta 10 kg') ||
            m.content.includes('Cuántos kilos buscás bajar') ||
            m.content.includes('cuántos kilos buscás bajar'))
    );

    if (hasManualGreeting) {
        logger.info(`[GREETING] Manual greeting detected for ${userId}, skipping to waiting_weight.`);
        _setStep(currentState, 'waiting_weight');
        saveState(userId);

        // Defer to salesFlow to avoid circular promise loops
        const fakeUserStateMap = { [userId]: currentState };
        await processSalesFlow(userId, text, fakeUserStateMap, knowledge, dependencies);
        return { matched: true };
    }

    // --- CHECK: Ad Interaction ---
    if (text.trim() === 'Hola! (Vengo de un anuncio)') {
        logger.info(`[GREETING] Ad trigger detected for ${userId}. Sending full greeting.`);
        // Fall through to the normal greeting logic below (don't return early)
    }

    // --- METRICS TRACKING ---
    const trackScript = dependencies.effectiveScript || dependencies.config?.activeScript || 'v7';
    if (dependencies.config && dependencies.config.scriptStats) {
        if (!dependencies.config.scriptStats[trackScript]) {
            dependencies.config.scriptStats[trackScript] = { started: 0, completed: 0 };
        }
        dependencies.config.scriptStats[trackScript].started++;
    }

    // --- Apertura sustantiva: el cliente arrancó con una pregunta/objeción real
    // (no un "hola" pelado). En vez de volcar el saludo enlatado ignorándola
    // (feedback off-script 2026-05-30), la IA responde la consulta + se presenta +
    // pide los kilos. Candados: (a) solo si NO es saludo simple / anuncio / peso
    // explícito; (b) si la IA falla, cae al saludo scripted de abajo. ---
    const _norm = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const _isAdTrigger = /vengo de un anuncio|quiero m[aá]s informaci[oó]n|conseguir m[aá]s informaci[oó]n/i.test(text);
    const _hasWeightInOpening = /\b\d{1,3}\s*(?:kg?s?|kilos?|kilogramos?)\b/i.test(text) || /\b(?:bajar|perder)\s+\d{1,3}/i.test(text);
    const _substantiveOpening = !_isAdTrigger && !_hasWeightInOpening && (
        /\?/.test(text) ||
        /\b(cuanto (sale|cuesta|vale|es)|que precio|el precio|precios?|estudios?|anmat|cientific|chamuyo|estafa|trucho|mentira|sirve|funciona de verdad|es seguro|seguro que|contraindicaci|hace mal|da[ñn]in|garant[ií]a|devuelven|devoluci[oó]n|reembolso|sos un bot|sos real|sos human|sos una maquina|es real esto|de donde son|donde estan|tienen local)\b/i.test(_norm)
    );
    const _ai = (dependencies as any).aiService;
    if (_substantiveOpening && _ai && typeof _ai.chat === 'function') {
        try {
            const openGoal = `El cliente ABRIÓ la conversación con una pregunta o comentario, NO un saludo simple. Su mensaje: "${text}". Sos Elena de Herbalis. (1) Respondé su consulta/comentario de forma cálida, honesta y BREVE con el knowledge — sin inventar precios, estudios ni datos que no tengas. (2) Si pregunta el PRECIO, NO tires un número suelto: decile que depende del plan (60 o 120 días) y que para recomendarte bien primero necesitás saber cuántos kilos quiere bajar. (3) Presentate en una línea como Elena de Herbalis (Nuez de la India, 100% natural) si viene al caso. (4) Cerrá con UNA sola pregunta: cuántos kilos querés bajar, ¿hasta 10 kg o más de 10 kg? 🛑 NO derives al médico bajo ninguna circunstancia.`;
            const aiOpen = await _ai.chat(text, {
                step: 'greeting',
                goal: openGoal,
                history: currentState.history,
                summary: currentState.summary,
                knowledge,
                userState: currentState,
            });
            if (aiOpen.response) {
                currentState.history.push({ role: 'bot', content: aiOpen.response, timestamp: Date.now() });
                await sendMessageWithDelay(userId, aiOpen.response);
                _setStep(currentState, knowledge.flow.greeting.nextStep);
                saveState(userId);
                logger.info(`[GREETING-AI] User ${userId} abrió con consulta sustantiva — IA respondió + encarriló a kilos.`);
                return { matched: true };
            }
        } catch (e: any) {
            logger.warn(`[GREETING-AI] falló para ${userId}: ${e.message} — caigo al saludo scripted.`);
        }
    }

    // 1. A/B variant selection — si knowledge.flow.greeting_variants existe y
    // tiene entradas, elegimos una variante deterministicamente por phone.
    // Persistimos la variante en state para que el mismo cliente no salte entre
    // variantes si reentra (consistencia + permite atribuir conversiones).
    const variants: Array<{ id: string; response: string }> = Array.isArray(knowledge.flow.greeting_variants)
        ? knowledge.flow.greeting_variants
        : [];
    let chosenGreeting = knowledge.flow.greeting;
    if (variants.length > 0) {
        let variantIdx: number;
        if ((currentState as any).greetingVariant != null) {
            // Cliente ya tenía variante asignada — buscarla en el array
            variantIdx = variants.findIndex(v => v.id === (currentState as any).greetingVariant);
            if (variantIdx === -1) variantIdx = 0;
        } else {
            // Asignar deterministicamente por phone con hash djb2.
            // El hash trivial (suma de charCodes) sesgaba la distribución para
            // teléfonos AR con prefijos comunes — djb2 distribuye mejor.
            const phoneDigits = userId.replace(/\D/g, '');
            let hash = 5381;
            for (let i = 0; i < phoneDigits.length; i++) {
                hash = ((hash << 5) + hash + phoneDigits.charCodeAt(i)) >>> 0;
            }
            variantIdx = hash % variants.length;
            (currentState as any).greetingVariant = variants[variantIdx].id;
            // Persistir inmediatamente para que el cliente no salte de variante
            // si el bot reinicia antes del próximo save debounced.
            saveState(userId);
        }
        chosenGreeting = {
            ...knowledge.flow.greeting,
            response: variants[variantIdx].response,
        };
        logger.info(`[GREETING-AB] User ${userId} → variant "${variants[variantIdx].id}" (idx ${variantIdx})`);
    }

    // 2. Send Text FIRST (Presentation part)
    const rawGreetMsg: string = _formatMessage(chosenGreeting.response, currentState);

    let greetingPart1 = rawGreetMsg;
    let greetingPart2: string | null = null;

    const splitIndex = rawGreetMsg.lastIndexOf('Para recomendarte bien:');
    if (splitIndex !== -1) {
        greetingPart1 = rawGreetMsg.substring(0, splitIndex).trim();
        greetingPart2 = rawGreetMsg.substring(splitIndex).trim();
    } else {
        const splitIndexAlt = rawGreetMsg.lastIndexOf('¿Cuántos kilos');
        if (splitIndexAlt !== -1) {
            greetingPart1 = rawGreetMsg.substring(0, splitIndexAlt).trim();
            greetingPart2 = rawGreetMsg.substring(splitIndexAlt).trim();
        }
    }

    currentState.history.push({ role: 'bot', content: greetingPart1, timestamp: Date.now() });
    await sendMessageWithDelay(userId, greetingPart1);

    // 2. Send Image SECOND (if configured)
    try {
        const greetingNode = knowledge.flow.greeting;
        if (greetingNode && greetingNode.image && greetingNode.imageEnabled) {
            let media: any;
            if (greetingNode.image.startsWith('/media/')) {
                const relativePath = greetingNode.image.replace(/^\//, '');
                const localPath = path.join(__dirname, '../../../public', relativePath);
                if (fs.existsSync(localPath)) {
                    media = MessageMedia.fromFilePath(localPath);
                } else {
                    logger.error(`[GREETING] Gallery image not found at: ${localPath}`);
                }
            } else {
                media = new MessageMedia(
                    greetingNode.imageMimetype || 'image/jpeg',
                    greetingNode.image,
                    greetingNode.imageFilename || 'welcome.jpg'
                );
            }
            if (media) {
                await client.sendMessage(userId, media, { caption: '' });
                logger.info(`[GREETING] Image sent to ${userId} from knowledge config`);
            }
        }
    } catch (e: any) {
        logger.error('[GREETING] Failed to send image:', e.message);
    }

    // 3. Atajo: si el cliente ya dio el objetivo de PESO en el primer mensaje
    // (ej: "quiero bajar 10 kilos", "tengo 20 kg de más"), evitamos repetir
    // la pregunta y procesamos su mensaje directo en waiting_weight.
    // Estricto: el número debe ir pegado a "kg|kilos|peso" para evitar falsos
    // positivos como "compré 3 kilos de fruta" (si el contexto es producto)
    // o "bajar 15 escalones".
    const hasExplicitGoal = (
        // Patrón A: "10 kg", "10 kgs", "10 k", "10 kilos", "10 kilogramos"
        // ("10 k" matcheaba antes solo si era "kg" — reporte 2026-05-28 horacio).
        /\b\d{1,3}\s*(?:kg?s?|kilos?|kilogramos?)\b/i.test(text) ||
        // Patrón B: "bajar 10" / "perder 10" con sufijo opcional de unidad.
        /\b(?:bajar|perder)\s+\d{1,3}\s*(?:kg?s?|kilos?|kilogramos?|de peso)?\b/i.test(text)
    );

    if (hasExplicitGoal) {
        logger.info(`[GREETING-SHORTCUT] User ${userId} provided weight goal in first message — skipping kilos question.`);
        _setStep(currentState, knowledge.flow.greeting.nextStep);
        saveState(userId);
        const fakeUserStateMap = { [userId]: currentState };
        await processSalesFlow(userId, text, fakeUserStateMap, knowledge, dependencies);
        return { matched: true };
    }

    // 4. Send Question Part (kilos) — only if we didn't shortcut above
    if (greetingPart2) {
        currentState.history.push({ role: 'bot', content: greetingPart2, timestamp: Date.now() });
        await sendMessageWithDelay(userId, greetingPart2);
    }

    _setStep(currentState, knowledge.flow.greeting.nextStep);
    saveState(userId);

    return { matched: true };
}
