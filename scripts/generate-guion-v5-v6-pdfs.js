/**
 * Genera 3 PDFs ejecutivos sobre los nuevos guiones consultivos:
 *   - guion-v5.pdf — versión "Asesor consultivo (cápsulas + gotas)"
 *   - guion-v6.pdf — versión "Marta charla (humano + argentino)"
 *   - guion-v5-vs-v6.pdf — comparativo lado a lado
 *
 * Uso: node scripts/generate-guion-v5-v6-pdfs.js
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const today = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });

// ─── Estilos compartidos ─────────────────────────────────────────────────────
const SHARED_STYLES = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    color: #1a1a1a;
    line-height: 1.5;
    font-size: 10.5pt;
    margin: 0;
  }
  h1 { font-size: 22pt; margin: 0 0 4px 0; color: #0f5132; line-height: 1.15; }
  h2 { font-size: 13pt; margin: 22px 0 10px 0; color: #0f5132; border-bottom: 2px solid #0f5132; padding-bottom: 4px; }
  h3 { font-size: 11pt; margin: 14px 0 6px 0; color: #1a1a1a; }
  p { margin: 6px 0 8px 0; }
  ul { margin: 6px 0 10px 18px; padding: 0; }
  li { margin-bottom: 3px; }
  .subtitle { color: #555; margin-bottom: 4px; font-size: 11pt; }
  .meta { color: #888; font-size: 8.5pt; margin-bottom: 18px; }

  .intro {
    background: #f1f5f4;
    border-left: 4px solid #0f5132;
    padding: 12px 14px;
    border-radius: 4px;
    margin-bottom: 16px;
  }
  .intro p { margin: 0 0 6px 0; }
  .intro p:last-child { margin: 0; }

  .step-card {
    border: 1px solid #ddd;
    border-radius: 6px;
    padding: 12px 14px;
    margin: 10px 0 12px 0;
    page-break-inside: avoid;
    background: #fff;
  }
  .step-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid #eee;
  }
  .step-num {
    background: #0f5132;
    color: #fff;
    width: 24px; height: 24px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 10pt;
    flex-shrink: 0;
  }
  .step-title { font-size: 10.5pt; font-weight: 600; color: #1a1a1a; }
  .step-customer { font-size: 8.5pt; color: #888; font-style: italic; margin-bottom: 6px; }

  .bot-bubble {
    background: #ecfdf5;
    border-radius: 14px;
    padding: 10px 14px;
    font-size: 9.5pt;
    color: #064e3b;
    margin: 6px 0;
    white-space: pre-line;
    border: 1px solid #d1fae5;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    line-height: 1.5;
  }
  .bot-bubble .label {
    font-size: 7.5pt;
    text-transform: uppercase;
    color: #065f46;
    font-weight: 700;
    letter-spacing: 0.6px;
    margin-bottom: 4px;
    display: block;
  }

  .user-bubble {
    background: #f8fafc;
    border-radius: 14px;
    padding: 8px 12px;
    font-size: 9pt;
    color: #475569;
    margin: 6px 0;
    border: 1px solid #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-style: italic;
  }

  .highlight {
    background: #ecfdf5;
    border-left: 4px solid #059669;
    padding: 10px 14px;
    border-radius: 4px;
    margin: 14px 0;
  }
  .highlight strong { color: #065f46; }

  .tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 8pt;
    font-weight: 600;
    margin-right: 4px;
  }
  .tag-green { background: #d1fae5; color: #065f46; }
  .tag-amber { background: #fef3c7; color: #92400e; }
  .tag-blue { background: #dbeafe; color: #1e40af; }
  .tag-rose { background: #fee2e2; color: #991b1b; }

  .compare-row {
    display: flex;
    gap: 12px;
    margin: 10px 0 16px 0;
    page-break-inside: avoid;
  }
  .compare-col {
    flex: 1;
    padding: 12px 14px;
    border-radius: 6px;
    border: 1px solid #ddd;
  }
  .compare-col.v5 { border-color: #0f5132; }
  .compare-col.v6 { border-color: #d97706; }
  .compare-col-header {
    font-size: 8.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid #eee;
  }
  .compare-col.v5 .compare-col-header { color: #0f5132; }
  .compare-col.v6 .compare-col-header { color: #d97706; }

  .compare-step {
    margin: 0 0 14px 0;
    page-break-inside: avoid;
  }
  .compare-step-title {
    font-size: 11pt;
    font-weight: 700;
    color: #0f5132;
    margin: 16px 0 4px 0;
    padding: 6px 10px;
    background: #f1f5f4;
    border-radius: 4px;
  }
  .compare-step-customer {
    font-size: 8.5pt;
    color: #666;
    font-style: italic;
    margin: 0 0 8px 0;
    padding-left: 10px;
  }
  .diff-summary {
    background: #fffbeb;
    border-left: 3px solid #d97706;
    padding: 8px 12px;
    margin-top: 6px;
    font-size: 9pt;
    color: #78350f;
    border-radius: 3px;
  }
  .diff-summary strong { color: #78350f; }

  .footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 8pt; color: #888; }
  .page-break { page-break-before: always; }

  .stats-row { display: flex; gap: 10px; margin: 12px 0 18px 0; }
  .stat {
    flex: 1;
    background: #fff;
    border: 1px solid #d4e5dc;
    border-radius: 6px;
    padding: 8px 10px;
    text-align: center;
  }
  .stat .num { font-size: 16pt; font-weight: 700; color: #0f5132; line-height: 1.1; }
  .stat .lbl { font-size: 7.5pt; color: #555; text-transform: uppercase; letter-spacing: 0.4px; margin-top: 3px; }
`;

// ─── Render del texto del knowledge a HTML legible ──────────────────────────
const PRICE_VARS = {
    PRICE_CAPSULAS_60: '46.900',
    PRICE_CAPSULAS_120: '66.900',
    PRICE_SEMILLAS_60: '36.900',
    PRICE_SEMILLAS_120: '49.900',
    PRICE_GOTAS_60: '48.900',
    PRICE_GOTAS_120: '68.900',
    PRICE_TOTAL_CAPSULAS_60: '46.900',
    PRICE_TOTAL_GOTAS_60: '48.900',
    PRICE_TOTAL_SEMILLAS_60: '36.900',
    PRICE_PER_DAY_CAPSULAS_120: '558',
    PRICE_PER_DAY_SEMILLAS_120: '416',
    PRICE_PER_DAY_GOTAS_120: '574',
    ADICIONAL_MAX: '0',
    COSTO_LOGISTICO: '18.000',
    PRODUCT: 'Cápsulas',
    PLAN: '120',
    TOTAL: '$66.900',
};

function renderText(text) {
    let r = String(text || '');
    Object.entries(PRICE_VARS).forEach(([k, v]) => {
        r = r.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    });
    r = r.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    r = r.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    return r;
}

function botBubble(text, label = 'Bot Herbalis') {
    return `<div class="bot-bubble"><span class="label">${label}</span>${renderText(text)}</div>`;
}

function userBubble(text) {
    return `<div class="user-bubble">${text}</div>`;
}

// ─── Walkthrough — 5 pasos del flujo consultivo ─────────────────────────────
function buildWalkthrough(knowledge) {
    const f = knowledge.flow;
    const steps = [];

    steps.push({
        title: 'Saludo inicial — pide kilos directo',
        customer: 'Cliente: "Hola, info"',
        bot: f.greeting?.response,
    });

    steps.push({
        title: 'Cliente con objetivo de hasta 10 kg → Gotas',
        customer: 'Cliente: "1" o "Hasta 10 kilos"',
        bot: f.recommendation_1?.response,
    });

    steps.push({
        title: 'Cliente con objetivo de 10 a 20 kg → Cápsulas 2 meses',
        customer: 'Cliente: "2" o "Entre 10 y 20"',
        bot: f.recommendation_2?.response,
    });

    steps.push({
        title: 'Cliente con +20 kg → Cápsulas 4 meses (recomendado)',
        customer: 'Cliente: "3" o "Más de 20"',
        bot: f.recommendation_3?.response,
    });

    steps.push({
        title: 'Cliente confirma → Cierre con datos de envío',
        customer: 'Cliente: "Sí, te lo envío"',
        bot: f.closing?.response,
    });

    return steps;
}

// ─── FAQs destacadas ─────────────────────────────────────────────────────────
const HIGHLIGHT_FAQ_KEYWORDS = [
    { kw: ['funciona de verdad', 'funciona'], example: 'Cliente pregunta: "¿Esto funciona de verdad?"' },
    { kw: ['es seguro'], example: 'Cliente pregunta: "¿Es seguro?"' },
    { kw: ['contraindicaciones', 'contraindicacion'], example: 'Cliente pregunta: "¿Tiene contraindicaciones?"' },
    { kw: ['como lo recibo', 'como llega'], example: 'Cliente pregunta: "¿Cómo lo recibo y cuánto tarda?"' },
    { kw: ['muy caro', 'es mucho', 'no me alcanza'], example: 'Cliente: "Es muy caro, no me alcanza"' },
    { kw: ['estafa', 'trucho'], example: 'Cliente: "¿No será una estafa?"' },
];

function findFaq(faq, kwSet) {
    return faq.find(entry =>
        entry.keywords.some(k => kwSet.includes(k))
    );
}

function buildHighlightFaqs(knowledge) {
    return HIGHLIGHT_FAQ_KEYWORDS
        .map(({ kw, example }) => {
            const found = findFaq(knowledge.faq, kw);
            return found ? { example, response: found.response } : null;
        })
        .filter(Boolean);
}

// ─── HTML por guión individual ──────────────────────────────────────────────
function buildSingleGuionHtml(knowledge, options = {}) {
    const { isV5 } = options;
    const meta = knowledge.meta;
    const walkthrough = buildWalkthrough(knowledge);
    const highlightFaqs = buildHighlightFaqs(knowledge);

    const personality = isV5
        ? {
            tone: 'Profesional, directo, eficiente',
            angle: 'Estructura clara, listas con bullets, mensajes prolijos. El cliente recibe info ordenada y compacta.',
            tags: ['Profesional', 'Directo', 'Estructurado'],
            ideal: 'Clientes que valoran información clara, sin vueltas. Ideal para quien tiene poca paciencia o quiere decidir rápido.',
        }
        : {
            tone: 'Cálido, conversacional, argentino',
            angle: 'Persona "Marta" charlando como una amiga que vende. Anécdotas, "te cuento", "mirá", "dale". Mensajes más extensos pero más humanos.',
            tags: ['Cálido', 'Argentino', 'Conversacional'],
            ideal: 'Clientes indecisos, que buscan confianza humana antes de comprar. Ideal para venta consultiva y casos donde el "feeling" pesa.',
        };

    const totalSteps = Object.keys(knowledge.flow).filter(k => !k.startsWith('_')).length;
    const totalFaqs = knowledge.faq.length;
    const tier1Product = knowledge.flow.recommendation_1?.response?.includes('gotas') ? 'Gotas 60d' : 'desconocido';
    const tier3Product = knowledge.flow.recommendation_3?.response?.includes('4 meses') ? 'Cápsulas 120d' : 'desconocido';

    return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>${meta.name}</title>
<style>${SHARED_STYLES}</style>
</head><body>

<h1>${meta.name}</h1>
<div class="subtitle">Cómo le habla el bot a un cliente, paso por paso</div>
<div class="meta">Documento ejecutivo · Bot Herbalis · ${today}</div>

<div class="intro">
<p><strong>Resumen del guión.</strong> ${meta.description}</p>
<p style="margin-top: 8px;"><strong>Tono:</strong> ${personality.tone}</p>
<p><strong>Cómo se siente la conversación:</strong> ${personality.angle}</p>
<p><strong>Mejor para:</strong> ${personality.ideal}</p>
<div style="margin-top: 8px;">
${personality.tags.map(t => `<span class="tag tag-green">${t}</span>`).join('')}
</div>
</div>

<div class="stats-row">
  <div class="stat"><div class="num">2</div><div class="lbl">Productos en oferta (cápsulas + gotas)</div></div>
  <div class="stat"><div class="num">3</div><div class="lbl">Tiers de objetivo (kilos)</div></div>
  <div class="stat"><div class="num">${totalFaqs}</div><div class="lbl">Respuestas automáticas</div></div>
  <div class="stat"><div class="num">18-80</div><div class="lbl">Edad permitida</div></div>
</div>

<h2>Cómo conversa el bot, paso a paso</h2>
<p style="font-size: 9.5pt; color: #555; margin-bottom: 10px;">
Esta es la conversación tipo. El cliente arranca preguntando por info,
elige cuántos kilos quiere bajar (1, 2 o 3) y el bot le recomienda
producto + plan. Los textos en verde son exactamente lo que el bot le dice.
</p>

${walkthrough.map((step, idx) => `
<div class="step-card">
  <div class="step-header">
    <div class="step-num">${idx + 1}</div>
    <div class="step-title">${step.title}</div>
  </div>
  <div class="step-customer">${step.customer}</div>
  ${botBubble(step.bot)}
</div>
`).join('')}

<div class="page-break"></div>

<h2>Cómo responde a las objeciones</h2>
<p style="font-size: 9.5pt; color: #555; margin-bottom: 12px;">
Estas son las situaciones más frecuentes — dudas de funcionamiento, seguridad,
contraindicaciones, envío, precio y desconfianza. Reflejan la "personalidad"
del guión.
</p>

${highlightFaqs.map(faq => `
<div class="step-card">
  <div class="step-customer">${faq.example}</div>
  ${botBubble(faq.response)}
</div>
`).join('')}

<div class="footer">
${meta.name} · Documento generado el ${today} · Bot Herbalis
</div>

</body></html>`;
}

// ─── HTML comparativo V5 vs V6 ───────────────────────────────────────────────
function buildComparativeHtml(v5, v6) {
    const v5Walk = buildWalkthrough(v5);
    const v6Walk = buildWalkthrough(v6);

    const stepDiffs = [
        {
            title: '1. Saludo inicial',
            customer: 'Cliente: "Hola"',
            v5Idx: 0, v6Idx: 0,
            diff: '<strong>V5</strong> arranca con "Soy el asesor de Herbalis" — formal, directo. <strong>V6</strong> usa "Acá Marta, de Herbalis" — más personal, da nombre humano. V6 ofrece responder con número o "en tus palabras", V5 pide específicamente el número.',
        },
        {
            title: '2. Recomendación tier 1 (hasta 10 kg → Gotas)',
            customer: 'Cliente: "1"',
            v5Idx: 1, v6Idx: 1,
            diff: '<strong>V5</strong> usa bullets y lista clara. <strong>V6</strong> arma un párrafo con anécdota ("Una clienta el mes pasado..."), explica más conversacional. V6 dice "una manito" en lugar de listar opciones de pago — suena menos a script.',
        },
        {
            title: '3. Recomendación tier 2 (10-20 kg → Cápsulas 60d con upsell)',
            customer: 'Cliente: "2"',
            v5Idx: 2, v6Idx: 2,
            diff: 'Mismo contenido, distinto envoltorio. <strong>V5</strong> presenta los planes 60 y 120 con bullets. <strong>V6</strong> los introduce con justificación conversacional ("si querés ir al tratamiento completo y asegurarte que no rebote").',
        },
        {
            title: '4. Recomendación tier 3 (+20 kg → Cápsulas 120d)',
            customer: 'Cliente: "3"',
            v5Idx: 3, v6Idx: 3,
            diff: '<strong>V5</strong> dice "ideal el plan 4 meses, sin rebote". <strong>V6</strong> explica el porqué: "El cuerpo necesita el tiempo para bajar de forma sostenida — la gente que va al de 2 meses muchas veces vuelve a comprar el segundo, así que te conviene de una". Razón humana que justifica.',
        },
        {
            title: '5. Cierre — confirma envío',
            customer: 'Cliente: "Sí, mandalo"',
            v5Idx: 4, v6Idx: 4,
            diff: 'Ambos piden los mismos datos. <strong>V5</strong> usa formato seco. <strong>V6</strong> agrega contexto: "Importante: la dirección tiene que ser exacta. Si no, el correo no entrega" — explica el porqué del pedido.',
        },
    ];

    const v5Funciona = findFaq(v5.faq, ['funciona de verdad', 'funciona']);
    const v6Funciona = findFaq(v6.faq, ['funciona de verdad', 'funciona']);
    const v5Caro = findFaq(v5.faq, ['muy caro', 'es mucho']);
    const v6Caro = findFaq(v6.faq, ['muy caro', 'es mucho']);
    const v5Estafa = findFaq(v5.faq, ['estafa', 'trucho']);
    const v6Estafa = findFaq(v6.faq, ['estafa', 'trucho']);

    return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>Comparativo V5 vs V6</title>
<style>${SHARED_STYLES}</style>
</head><body>

<h1>Comparativo de guiones consultivos — V5 vs V6</h1>
<div class="subtitle">Mismo flujo, diferente tono</div>
<div class="meta">Documento ejecutivo · Bot Herbalis · ${today}</div>

<div class="intro">
<p style="margin: 0 0 8px 0;">
Los dos guiones consultivos son <strong>idénticos en estructura</strong>:
preguntan kilos primero, recomiendan según el objetivo, ofrecen incentivo
de prepago, manejan objeciones. Lo que cambia es el <strong>tono</strong>
con el que el bot habla.
</p>
<p style="margin: 0;">
<strong>V5 (Asesor consultivo):</strong> profesional, estructurado, con bullets
claros. Da la sensación de un asesor eficiente.<br>
<strong>V6 (Marta charla):</strong> cálido, conversacional, argentino. Da la
sensación de una persona real charlando, no un bot.
</p>
</div>

<div class="stats-row">
  <div class="stat"><div class="num">5</div><div class="lbl">Pasos del flujo</div></div>
  <div class="stat"><div class="num">${v5.faq.length}</div><div class="lbl">FAQs en V5</div></div>
  <div class="stat"><div class="num">${v6.faq.length}</div><div class="lbl">FAQs en V6</div></div>
  <div class="stat"><div class="num">2</div><div class="lbl">Productos (cápsulas + gotas)</div></div>
</div>

<h2>Diferencias paso a paso</h2>

${stepDiffs.map(step => {
        const v5Step = v5Walk[step.v5Idx];
        const v6Step = v6Walk[step.v6Idx];
        return `
<div class="compare-step">
  <div class="compare-step-title">${step.title}</div>
  <div class="compare-step-customer">${step.customer}</div>
  <div class="compare-row">
    <div class="compare-col v5">
      <div class="compare-col-header">V5 · Profesional</div>
      ${botBubble(v5Step.bot, 'Bot dice')}
    </div>
    <div class="compare-col v6">
      <div class="compare-col-header">V6 · Marta charla</div>
      ${botBubble(v6Step.bot, 'Bot dice')}
    </div>
  </div>
  <div class="diff-summary"><strong>Lo que cambia:</strong> ${step.diff}</div>
</div>
`;
    }).join('')}

<div class="page-break"></div>

<h2>Cómo cada guión maneja las objeciones</h2>
<p style="font-size: 9.5pt; color: #555;">
Misma pregunta del cliente, distinta forma de responder. Acá se nota más la
diferencia entre "asesor profesional" y "Marta charlando".
</p>

<div class="compare-step">
  <div class="compare-step-title">Cliente pregunta: "¿Funciona de verdad?"</div>
  <div class="compare-row">
    <div class="compare-col v5">
      <div class="compare-col-header">V5 — afirmación directa, datos duros</div>
      ${botBubble(v5Funciona.response, 'Bot dice')}
    </div>
    <div class="compare-col v6">
      <div class="compare-col-header">V6 — honestidad humana, sin falsas promesas</div>
      ${botBubble(v6Funciona.response, 'Bot dice')}
    </div>
  </div>
  <div class="diff-summary"><strong>Lo que cambia:</strong> V5 da una afirmación rotunda con números. V6 admite primero que "cada cuerpo responde a su ritmo" antes de avalar — gana confianza al no sobre-prometer.</div>
</div>

<div class="compare-step">
  <div class="compare-step-title">Cliente: "Es muy caro, no me alcanza"</div>
  <div class="compare-row">
    <div class="compare-col v5">
      <div class="compare-col-header">V5</div>
      ${botBubble(v5Caro.response, 'Bot dice')}
    </div>
    <div class="compare-col v6">
      <div class="compare-col-header">V6</div>
      ${botBubble(v6Caro.response, 'Bot dice')}
    </div>
  </div>
  <div class="diff-summary"><strong>Lo que cambia:</strong> V5 valida la objeción y ofrece el postdatado. V6 hace lo mismo pero arma una mini-narrativa de "yo te acompaño durante los meses" — mete la persona Marta como valor agregado.</div>
</div>

<div class="compare-step">
  <div class="compare-step-title">Cliente sospecha: "¿No será una estafa?"</div>
  <div class="compare-row">
    <div class="compare-col v5">
      <div class="compare-col-header">V5 — explicación racional</div>
      ${botBubble(v5Estafa.response, 'Bot dice')}
    </div>
    <div class="compare-col v6">
      <div class="compare-col-header">V6 — empatía + explicación</div>
      ${botBubble(v6Estafa.response, 'Bot dice')}
    </div>
  </div>
  <div class="diff-summary"><strong>Lo que cambia:</strong> V5 va directo al argumento del contra reembolso. V6 valida primero ("hoy en día se ven cosas raras por internet") antes de explicar. Los clientes desconfiados responden mejor a la validación previa.</div>
</div>

<div class="page-break"></div>

<h2>Comparativa rápida</h2>

<div style="margin: 14px 0;">
<table style="width: 100%; border-collapse: collapse; font-size: 9pt;">
  <tr style="background: #0f5132; color: white;">
    <td style="padding: 8px 10px; font-weight: 700; width: 28%;">Aspecto</td>
    <td style="padding: 8px 10px; font-weight: 700; width: 36%;">V5 — Profesional</td>
    <td style="padding: 8px 10px; font-weight: 700; width: 36%;">V6 — Marta charla</td>
  </tr>
  <tr style="background: #f8fafc;">
    <td style="padding: 8px 10px; font-weight: 600;">Persona del bot</td>
    <td style="padding: 8px 10px;">"Soy el asesor de Herbalis"</td>
    <td style="padding: 8px 10px;">"Acá Marta, de Herbalis"</td>
  </tr>
  <tr>
    <td style="padding: 8px 10px; font-weight: 600;">Frases típicas</td>
    <td style="padding: 8px 10px;"><em>"Genial. ¿Te lo envío?"</em></td>
    <td style="padding: 8px 10px;"><em>"Buenísimo. ¿Te lo despacho? Cualquier duda contame, charlamos lo que haga falta 😊"</em></td>
  </tr>
  <tr style="background: #f8fafc;">
    <td style="padding: 8px 10px; font-weight: 600;">Estructura del mensaje</td>
    <td style="padding: 8px 10px;">Bullets, numerado, prolijo</td>
    <td style="padding: 8px 10px;">Párrafo conversacional con anécdotas</td>
  </tr>
  <tr>
    <td style="padding: 8px 10px; font-weight: 600;">Largo promedio</td>
    <td style="padding: 8px 10px;">Más corto y compacto</td>
    <td style="padding: 8px 10px;">~30% más largo, justifica con narrativa</td>
  </tr>
  <tr style="background: #f8fafc;">
    <td style="padding: 8px 10px; font-weight: 600;">Manejo de "muy caro"</td>
    <td style="padding: 8px 10px;">Empatiza brevemente y ofrece postdatado</td>
    <td style="padding: 8px 10px;">Empatiza + agrega valor del acompañamiento + postdatado</td>
  </tr>
  <tr>
    <td style="padding: 8px 10px; font-weight: 600;">Manejo de desconfianza</td>
    <td style="padding: 8px 10px;">Va directo al argumento "contra reembolso"</td>
    <td style="padding: 8px 10px;">Valida primero ("se ven cosas raras"), después explica</td>
  </tr>
  <tr style="background: #f8fafc;">
    <td style="padding: 8px 10px; font-weight: 600;">Asesoramiento nutricional</td>
    <td style="padding: 8px 10px;">"Te acompañamos por WhatsApp"</td>
    <td style="padding: 8px 10px;">"Yo a tu disposición por WhatsApp, vamos viendo juntas/os"</td>
  </tr>
  <tr>
    <td style="padding: 8px 10px; font-weight: 600;">Uso de modismos AR</td>
    <td style="padding: 8px 10px;">Moderado ("dale", "buenísimo")</td>
    <td style="padding: 8px 10px;">Alto ("che", "una manito", "tirarte un número", "no hay drama")</td>
  </tr>
  <tr style="background: #f8fafc;">
    <td style="padding: 8px 10px; font-weight: 600;">Mejor para</td>
    <td style="padding: 8px 10px;">Clientes que valoran info clara, sin vueltas</td>
    <td style="padding: 8px 10px;">Clientes que necesitan confianza humana antes de comprar</td>
  </tr>
</table>
</div>

<h2>Recomendación</h2>

<div class="highlight">
<p style="margin: 0 0 8px 0;">
<strong>V5 va a convertir mejor en:</strong> clientes ya decididos, que valoran
eficiencia. Tasa de cierre típicamente más alta entre quienes ya conocen el
producto o vienen recomendados.
</p>
<p style="margin: 0 0 8px 0;">
<strong>V6 va a convertir mejor en:</strong> clientes nuevos, indecisos, que
buscan sentir que están hablando con una persona real. Reduce la sensación
"esto es un bot" y aumenta confianza para clientes mass-market.
</p>
<p style="margin: 0;">
<strong>La forma de saberlo es medirlo</strong>: dejar correr V5 a la mitad
de los clientes y V6 a la otra mitad por una semana, y comparar tasa de
cierre. El sistema de funnel automático ya capturaría esa diferencia.
</p>
</div>

<p style="font-size: 9.5pt; color: #555; margin-top: 16px;">
Ambos guiones <strong>preservan los safety nets</strong> actuales (detección
de menores, embarazo, horarios específicos de envío, etc.) — esos son
globales y no dependen del guión activo.
</p>

<div class="footer">
Comparativo V5 vs V6 · Documento generado el ${today} · Bot Herbalis
</div>

</body></html>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
    const v5 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v5.json'), 'utf8'));
    const v6 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v6.json'), 'utf8'));

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const reportsDir = path.join(__dirname, '..', 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    const dateSlug = new Date().toISOString().split('T')[0];

    const targets = [
        { name: 'guion-v5', html: buildSingleGuionHtml(v5, { isV5: true }) },
        { name: 'guion-v6', html: buildSingleGuionHtml(v6, { isV5: false }) },
        { name: 'guion-v5-vs-v6', html: buildComparativeHtml(v5, v6) },
    ];

    for (const t of targets) {
        const page = await browser.newPage();
        await page.setContent(t.html, { waitUntil: 'networkidle0' });
        const outPath = path.join(reportsDir, `${t.name}-${dateSlug}.pdf`);
        await page.pdf({
            path: outPath,
            format: 'A4',
            printBackground: true,
            margin: { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' },
        });
        const stats = fs.statSync(outPath);
        console.log(`✓ ${outPath}  (${(stats.size / 1024).toFixed(1)} KB)`);
        await page.close();
    }

    await browser.close();
})();
