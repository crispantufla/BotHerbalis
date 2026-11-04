/**
 * club-probe.ts — prueba el prompt de Club Herbys contra Claude real con
 * mensajes típicos y muestra la decisión de cada uno. Cuesta centavos.
 *
 *   ANTHROPIC_API_KEY=... npx tsx scripts/club-probe.ts
 */
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM, CLUB_AI_MODEL, OFFER_TEXT, parseDecision, isSafeReply } from '../src/flows/clubHerbys';

const CASES: Array<[string, string[]]> = [
    ['acepta', ['Si, lo quiero!']],
    ['acepta', ['dale']],
    ['responder', ['Hola como es eso?']],
    ['responder', ['cuanto es en total?']],
    ['responder', ['que producto es?']],
    ['derivar', ['llegan a Casilda?']],
    ['responder', ['sirve para bajar de peso?']],
    ['responder', ['cuantos kilos voy a bajar?']],
    ['responder', ['como se toma?']],
    ['responder', ['que tiene? es natural?']],
    ['derivar', ['estoy embarazada, puedo tomarlo?']],
    ['derivar', ['tomo pastillas para la presion, hay problema?']],
    ['responder', ['quiero bajar 25 kilos, me sirve?']],
    ['derivar', ['quiero hablar con alguien']],
    ['no', ['no gracias']],
    ['baja', ['no me escriban mas, esto es spam']],
    ['responder', ['tengo que tener tarjeta?']],
    ['acepta', ['bueno si pero cuando me lo traen?']],
];

(async () => {
    const client = new Anthropic();
    for (const [want, msgs] of CASES) {
        const messages = [{ role: 'user' as const, content: msgs.join('\n') }];
        const res: any = await client.messages.create({
            model: CLUB_AI_MODEL, max_tokens: 2000,
            system: [{ type: 'text', text: SYSTEM }],
            messages: [{ role: 'user', content: '(se le mandó la oferta)' }, { role: 'assistant', content: OFFER_TEXT }, ...messages],
        } as any);
        const text = (res.content || []).find((b: any) => b.type === 'text')?.text || '';
        const d = parseDecision(text);
        const safe = d.decision !== 'responder' || isSafeReply(d.respuesta);
        console.log(`${d.decision === want ? '✓' : '·'} [${want} → ${d.decision}${safe ? '' : ' (BLOQUEADA)'}] ${msgs.join(' / ')}${d.respuesta ? `\n      ${d.respuesta.replace(/\n/g, ' ')}` : ''}`);
    }
})().catch((e) => { console.error(e.message); process.exit(1); });
