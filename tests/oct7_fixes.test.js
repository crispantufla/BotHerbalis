/**
 * Arreglos del 7-oct-2026 tras revisar 221 conversaciones de 48 h (ver el
 * commit). Acá van las piezas puras; el handler de salientes (saludo manual,
 * imágenes en base64) se prueba en manual_chat.test.js con su harness.
 */
require('dotenv').config();

const knowledge = require('../knowledge_v7.json');
const { _isScriptGreeting, _buildPriceTableWithWeightAsk } = require('../src/flows/utils/messages');
const { _hasPersonalContext } = require('../src/services/semanticCache');

describe('_isScriptGreeting — el saludo del guion mandado a mano', () => {
    const tpl = knowledge.flow.greeting.response;

    test('el texto exacto del guion', () => {
        expect(_isScriptGreeting(tpl, knowledge)).toBe(true);
    });

    test('tolera espacios, saltos de línea y emojis distintos (copiado del panel o respuesta rápida)', () => {
        const copiado = tpl.replace(/\n+/g, ' ').replace(/😊/g, '').replace(/\s+/g, '  ');
        expect(_isScriptGreeting(copiado, knowledge)).toBe(true);
    });

    test('lo que el vendedor escribe de verdad no cuenta', () => {
        expect(_isScriptGreeting('Hola! Te escribo yo, soy Horacio. Te paso el precio del de 120', knowledge)).toBe(false);
        expect(_isScriptGreeting('¡Hola! 😊 Soy Elena', knowledge)).toBe(false); // demasiado corto para afirmar
        expect(_isScriptGreeting('', knowledge)).toBe(false);
        expect(_isScriptGreeting(tpl, {})).toBe(false);
    });
});

describe('_buildPriceTableWithWeightAsk — precio pedido antes de los kilos', () => {
    test('trae las 3 presentaciones con precio y termina pidiendo los kilos, sin la pregunta de producto', () => {
        const msg = _buildPriceTableWithWeightAsk(knowledge, {});
        expect(msg).toMatch(/Cápsulas/);
        expect(msg).toMatch(/Gotas/);
        expect(msg).toMatch(/Semillas/);
        expect(msg).toMatch(/\$\d{2}\.\d{3}/);          // precios reales, no placeholders
        expect(msg).not.toMatch(/\{\{/);
        expect(msg).not.toMatch(/¿Con cuál/);
        expect(msg).toMatch(/1️⃣ Hasta 10 kg\n2️⃣ Más de 10 kg$/);
    });

    test('sin tabla en el guion devuelve null (cae a la IA)', () => {
        expect(_buildPriceTableWithWeightAsk({ flow: {} }, {})).toBeNull();
    });
});

describe('_hasPersonalContext — lo que el cache semántico no puede guardar ni servir', () => {
    test('salud, edad y medicación del cliente', () => {
        expect(_hasPersonalContext('Considerando tu gastritis y colon irritable, te dejo afuera las semillas')).toBe(true);
        expect(_hasPersonalContext('Estoy en la menopausia y no logro bajar con nada')).toBe(true);
        expect(_hasPersonalContext('Con hipotiroidismo podés tomarlo sin problema')).toBe(true);
        expect(_hasPersonalContext('tengo 68 años, puedo tomarlo?')).toBe(true);
        expect(_hasPersonalContext('tomo medicación para la presión')).toBe(true);
    });

    test('la trayectoria de la marca y las preguntas genéricas sí se cachean', () => {
        expect(_hasPersonalContext('Somos Herbalis, 13 años acompañando y casi 70.000 clientes 😊')).toBe(false);
        expect(_hasPersonalContext('Las tres funcionan igual de bien para bajar de peso 😊 ¿Cuántos kilos querés bajar?')).toBe(false);
        expect(_hasPersonalContext('De dónde son ustedes?')).toBe(false);
    });
});
