/**
 * Genera 3 PDFs ejecutivos sobre los guiones de venta del bot:
 *   - guion-v3.pdf — versión "Profesional + Contra Reembolso MAX"
 *   - guion-v4.pdf — versión "Psicología de Ventas (Agresivo)"
 *   - guion-comparativo.pdf — comparación side-by-side de ambos
 *
 * Estilo: Herbalis verde, lenguaje no técnico, scaneable en pocos minutos.
 * Uso: node scripts/generate-guion-pdfs.js
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
    line-height: 1.45;
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
  .compare-col.v3 { border-color: #0f5132; }
  .compare-col.v4 { border-color: #d97706; }
  .compare-col-header {
    font-size: 8.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid #eee;
  }
  .compare-col.v3 .compare-col-header { color: #0f5132; }
  .compare-col.v4 .compare-col-header { color: #d97706; }

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

// ─── Bubble del bot — convierte el texto del knowledge en HTML legible ──────
const PRICE_VARS = {
    PRICE_CAPSULAS_60: '46.900',
    PRICE_CAPSULAS_120: '66.900',
    PRICE_SEMILLAS_60: '36.900',
    PRICE_SEMILLAS_120: '49.900',
    PRICE_GOTAS_60: '48.900',
    PRICE_GOTAS_120: '68.900',
    PRICE_PER_DAY_CAPSULAS_120: '558',
    PRICE_PER_DAY_SEMILLAS_120: '416',
    PRICE_PER_DAY_GOTAS_120: '574',
    ADICIONAL_MAX: '6.000',
    COSTO_LOGISTICO: '18.000',
};

function renderText(text) {
    let r = String(text || '');
    Object.entries(PRICE_VARS).forEach(([k, v]) => {
        r = r.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    });
    // Bold *text*
    r = r.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    // Italic _text_
    r = r.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    // HTML escape leftovers
    return r;
}

function botBubble(text, label = 'Bot Herbalis') {
    return `<div class="bot-bubble"><span class="label">${label}</span>${renderText(text)}</div>`;
}

function userBubble(text) {
    return `<div class="user-bubble">${text}</div>`;
}

// ─── Walkthrough — pasos de la conversación ya unificados v3/v4 ─────────────
function buildWalkthrough(knowledge) {
    const f = knowledge.flow;
    const steps = [];

    steps.push({
        title: 'Saludo inicial',
        customer: 'Cliente: "Hola, info de la nuez de la india"',
        bot: f.greeting?.response,
    });

    steps.push({
        title: 'Cliente dice cuántos kilos quiere bajar',
        customer: 'Cliente: "Quiero bajar 15 kilos"',
        bot: f.recommendation?.response,
    });

    steps.push({
        title: 'Cliente elige producto (ej: cápsulas)',
        customer: 'Cliente: "Cápsulas"',
        bot: f.preference_capsulas?.response,
    });

    steps.push({
        title: 'Cliente elige plan (ej: 120 días)',
        customer: 'Cliente: "120 días"',
        bot: f.closing?.response,
    });

    steps.push({
        title: 'Cliente da datos de envío — confirmación',
        customer: 'Cliente envía nombre, dirección, código postal',
        bot: f.confirmation?.response,
    });

    return steps;
}

// ─── Variantes adicionales para comparativa por producto ────────────────────
function buildProductExamples(knowledge) {
    const f = knowledge.flow;
    return {
        capsulas: f.preference_capsulas?.response,
        semillas: f.preference_semillas?.response,
        gotas: f.preference_gotas?.response,
    };
}

// ─── FAQs destacadas (las que más muestran la "personalidad") ───────────────
const HIGHLIGHT_FAQ_KEYWORDS = [
    ['muy caro', 'es mucho'],
    ['estafa', 'trucho'],
    ['no tengo', 'no me alcanza'],
    ['cual me conviene', 'cual es mejor'],
];

function findFaq(faq, keywordSet) {
    return faq.find(entry =>
        entry.keywords.some(kw => keywordSet.includes(kw))
    );
}

function buildHighlightFaqs(knowledge) {
    const out = [];
    HIGHLIGHT_FAQ_KEYWORDS.forEach(keywords => {
        const found = findFaq(knowledge.faq, keywords);
        if (found) {
            out.push({
                trigger: keywords[0],
                example: keywordsToExampleQuestion(keywords[0]),
                response: found.response,
            });
        }
    });
    return out;
}

function keywordsToExampleQuestion(kw) {
    const map = {
        'muy caro': 'Ejemplo de objeción del cliente: "Es muy caro, no puedo gastar tanto"',
        'estafa': 'Ejemplo de objeción del cliente: "¿Esto no es una estafa?"',
        'no tengo': 'Ejemplo del cliente: "Ahora no tengo plata"',
        'cual me conviene': 'Ejemplo del cliente: "¿Cuál me conviene, cápsulas o semillas?"',
    };
    return map[kw] || `Cliente menciona: "${kw}"`;
}

// ─── HTML por guión individual ──────────────────────────────────────────────
function buildSingleGuionHtml(knowledge, options = {}) {
    const { isV3 } = options;
    const meta = knowledge.meta;
    const walkthrough = buildWalkthrough(knowledge);
    const productExamples = buildProductExamples(knowledge);
    const highlightFaqs = buildHighlightFaqs(knowledge);

    const personality = isV3
        ? {
            tone: 'Profesional, claro, consultivo',
            angle: 'Empuja primero los kilos del cliente antes de hablar de números. Tono cordial y directo, sin presionar.',
            tags: ['Profesional', 'Consultivo', 'Claro'],
        }
        : {
            tone: 'Cercano, persuasivo, con autoridad',
            angle: 'Usa autoridad ("13 años, +15.000 personas"), tutea más, suma referencias sociales, e incluye respuestas más detalladas a objeciones de plata y desconfianza.',
            tags: ['Cercano', 'Autoridad', 'Persuasivo'],
        };

    const totalSteps = Object.keys(knowledge.flow).filter(k => k !== 'greeting_variants').length;
    const totalFaqs = knowledge.faq.length;

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
<div style="margin-top: 8px;">
${personality.tags.map(t => `<span class="tag tag-green">${t}</span>`).join('')}
</div>
</div>

<div class="stats-row">
  <div class="stat"><div class="num">${totalSteps}</div><div class="lbl">Etapas del flujo</div></div>
  <div class="stat"><div class="num">${totalFaqs}</div><div class="lbl">Respuestas automáticas</div></div>
  <div class="stat"><div class="num">3</div><div class="lbl">Productos disponibles</div></div>
  <div class="stat"><div class="num">2</div><div class="lbl">Planes (60 / 120 días)</div></div>
</div>

<h2>Cómo conversa el bot, paso a paso</h2>
<p style="font-size: 9.5pt; color: #555; margin-bottom: 10px;">
Esta es la conversación tipo de un cliente que arranca preguntando, elige
producto, plan, y termina dando los datos. Los textos en verde son
exactamente lo que el bot le dice al cliente.
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

<h2>Cómo presenta cada producto</h2>
<p style="font-size: 9.5pt; color: #555;">
El bot tiene tres respuestas distintas según qué producto eligió el cliente.
Cada una arranca con un tono propio y termina con la pregunta de cierre del plan.
</p>

<h3>💊 Cápsulas</h3>
${botBubble(productExamples.capsulas)}

<h3>🌿 Semillas</h3>
${botBubble(productExamples.semillas)}

<h3>💧 Gotas</h3>
${botBubble(productExamples.gotas)}

<div class="page-break"></div>

<h2>Cómo responde a las objeciones más comunes</h2>
<p style="font-size: 9.5pt; color: #555; margin-bottom: 12px;">
Estas son 4 situaciones que reflejan la "personalidad" del guión: cómo trata
las dudas de plata, las desconfianzas, y las decisiones difíciles del cliente.
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

// ─── HTML comparativo v3 vs v4 ───────────────────────────────────────────────
function buildComparativeHtml(v3, v4) {
    const v3Walk = buildWalkthrough(v3);
    const v4Walk = buildWalkthrough(v4);

    const stepDiffs = [
        {
            title: '1. Saludo inicial',
            customer: 'Cliente: "Hola, info"',
            v3Idx: 0,
            v4Idx: 0,
            diff: 'Ambos guiones evitan tirar precio antes de saber el objetivo del cliente. <strong>V4 es más cálido y suma autoridad</strong> ("Somos Herbalis, especialistas hace 13 años, más de 15.000 personas..."). V3 es más sobrio y consultivo.',
        },
        {
            title: '2. Pide los kilos a bajar',
            customer: 'Cliente: "Quiero bajar 15 kilos"',
            v3Idx: 1,
            v4Idx: 1,
            diff: 'Texto idéntico en ambos. Es el momento donde el cliente elige producto, no el momento de diferenciar tono.',
        },
        {
            title: '3. Cliente elige cápsulas',
            customer: 'Cliente: "Cápsulas"',
            v3Idx: 2,
            v4Idx: 2,
            diff: '<strong>V4 cambia "Genial 👍 Excelente elección" por "Dale, excelente elección"</strong> — más argentino, más cercano. La pregunta final también: V3 dice "¿Avanzamos con 120 o 60 días?" y V4 dice "¿Te reservo el de 120 o arrancamos con 60?" — V4 da por hecha la venta.',
        },
        {
            title: '4. Cliente confirma plan',
            customer: 'Cliente: "120 días"',
            v3Idx: 3,
            v4Idx: 3,
            diff: '<strong>V4 sube la urgencia.</strong> V3 dice "Tomamos los datos para armar la etiqueta de envío". V4 dice "Pasame estos datos exactos para armar la etiqueta de envío YA MISMO". El "ya mismo" empuja al cliente a actuar sin pensar demasiado.',
        },
        {
            title: '5. Confirmación final',
            customer: 'Cliente envía dirección completa',
            v3Idx: 4,
            v4Idx: 4,
            diff: 'Mensaje similar en ambos. <strong>V4 cierra pidiendo un "SÍ" o "DALE"</strong> ("Confirmame con un SÍ o un DALE para despachar YA mismo"), V3 pregunta de forma más calmada si confirma.',
        },
    ];

    const v3CapsulasFaq = findFaq(v3.faq, ['muy caro']);
    const v4CapsulasFaq = findFaq(v4.faq, ['muy caro']);
    const v3EstafaFaq = findFaq(v3.faq, ['estafa']);
    const v4EstafaFaq = findFaq(v4.faq, ['estafa']);
    const v3CualFaq = findFaq(v3.faq, ['cual me conviene']);
    const v4CualFaq = findFaq(v4.faq, ['cual me conviene']);

    return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>Comparativo V3 vs V4</title>
<style>${SHARED_STYLES}</style>
</head><body>

<h1>Comparativo de guiones — V3 vs V4</h1>
<div class="subtitle">Cómo cambia la conversación según qué guión use el bot</div>
<div class="meta">Documento ejecutivo · Bot Herbalis · ${today}</div>

<div class="intro">
<p style="margin: 0 0 8px 0;">
El bot puede correr con dos guiones distintos. Los dos venden el mismo
producto, ofrecen los mismos planes y dan la misma información — pero el
<strong>tono y la presión cambian bastante</strong>. Este documento muestra
las diferencias paso a paso.
</p>
<p>
<strong>V3</strong> es la versión <em>profesional y consultiva</em>: sobria,
cordial, cero presión. Da la sensación de un asesor que te escucha.<br>
<strong>V4</strong> es la versión <em>persuasiva con psicología de venta</em>:
más cálida y argentina ("dale", "le metemos", "ya mismo"), suma autoridad
("+15.000 personas") y empuja al cierre de forma más activa.
</p>
</div>

<div class="stats-row">
  <div class="stat"><div class="num">5</div><div class="lbl">Pasos de la conversación</div></div>
  <div class="stat"><div class="num">${v3.faq.length}</div><div class="lbl">FAQs en V3</div></div>
  <div class="stat"><div class="num">${v4.faq.length}</div><div class="lbl">FAQs en V4</div></div>
  <div class="stat"><div class="num">+${v4.faq.length - v3.faq.length}</div><div class="lbl">V4 cubre más casos</div></div>
</div>

<h2>Diferencias paso a paso</h2>

${stepDiffs.map(step => {
        const v3Step = v3Walk[step.v3Idx];
        const v4Step = v4Walk[step.v4Idx];
        return `
<div class="compare-step">
  <div class="compare-step-title">${step.title}</div>
  <div class="compare-step-customer">${step.customer}</div>
  <div class="compare-row">
    <div class="compare-col v3">
      <div class="compare-col-header">V3 · Profesional</div>
      ${botBubble(v3Step.bot, 'Bot dice')}
    </div>
    <div class="compare-col v4">
      <div class="compare-col-header">V4 · Persuasivo</div>
      ${botBubble(v4Step.bot, 'Bot dice')}
    </div>
  </div>
  <div class="diff-summary"><strong>Lo que cambia:</strong> ${step.diff}</div>
</div>
`;
    }).join('')}

<div class="page-break"></div>

<h2>Cómo cada guión maneja las objeciones</h2>
<p style="font-size: 9.5pt; color: #555;">
Acá es donde la diferencia entre los dos guiones se hace más obvia. Mismas
preguntas del cliente, respuestas con tono y enfoque distintos.
</p>

<div class="compare-step">
  <div class="compare-step-title">Cliente dice "es muy caro"</div>
  <div class="compare-row">
    <div class="compare-col v3">
      <div class="compare-col-header">V3 — respuesta breve, redirige al plan</div>
      ${botBubble(v3CapsulasFaq.response, 'Bot dice')}
    </div>
    <div class="compare-col v4">
      <div class="compare-col-header">V4 — empatiza primero, ofrece alternativa más barata</div>
      ${botBubble(v4CapsulasFaq.response, 'Bot dice')}
    </div>
  </div>
  <div class="diff-summary"><strong>Lo que cambia:</strong> V3 minimiza la objeción y vuelve al cierre. V4 valida la emoción ("La plata hoy cuesta ganarla") antes de ofrecer una opción más accesible (plan 60 días o semillas). V4 baja la barrera psicológica.</div>
</div>

<div class="compare-step">
  <div class="compare-step-title">Cliente sospecha que es estafa</div>
  <div class="compare-row">
    <div class="compare-col v3">
      <div class="compare-col-header">V3 — corta y directa</div>
      ${botBubble(v3EstafaFaq.response, 'Bot dice')}
    </div>
    <div class="compare-col v4">
      <div class="compare-col-header">V4 — explica con detalle por qué no hay riesgo</div>
      ${botBubble(v4EstafaFaq.response, 'Bot dice')}
    </div>
  </div>
  <div class="diff-summary"><strong>Lo que cambia:</strong> V3 da una respuesta de 2 líneas. V4 lo explica con calor humano ("Es normal desconfiar hoy en día por internet"), aclara cómo funciona el contra reembolso, y pone el énfasis en "Riesgo cero para vos".</div>
</div>

<div class="compare-step">
  <div class="compare-step-title">Cliente pregunta "¿cuál me conviene?"</div>
  <div class="compare-row">
    <div class="compare-col v3">
      <div class="compare-col-header">V3</div>
      ${botBubble(v3CualFaq.response, 'Bot dice')}
    </div>
    <div class="compare-col v4">
      <div class="compare-col-header">V4</div>
      ${botBubble(v4CualFaq.response, 'Bot dice')}
    </div>
  </div>
  <div class="diff-summary"><strong>Lo que cambia:</strong> V3 dice "cortesía comercial". V4 dice "cortesía oficial". Diferencia mínima — el resto es prácticamente idéntico. El bono de las semillas de regalo aparece en ambos.</div>
</div>

<div class="page-break"></div>

<h2>Comparativa rápida</h2>

<div style="margin: 14px 0;">
<table style="width: 100%; border-collapse: collapse; font-size: 9pt;">
  <tr style="background: #0f5132; color: white;">
    <td style="padding: 8px 10px; font-weight: 700; width: 28%;">Aspecto</td>
    <td style="padding: 8px 10px; font-weight: 700; width: 36%;">V3 — Profesional</td>
    <td style="padding: 8px 10px; font-weight: 700; width: 36%;">V4 — Persuasivo</td>
  </tr>
  <tr style="background: #f8fafc;">
    <td style="padding: 8px 10px; font-weight: 600;">Tono general</td>
    <td style="padding: 8px 10px;">Sobrio, claro, sin presión</td>
    <td style="padding: 8px 10px;">Cálido, argentino, da por hecho el cierre</td>
  </tr>
  <tr>
    <td style="padding: 8px 10px; font-weight: 600;">Frases típicas</td>
    <td style="padding: 8px 10px;"><em>"Genial. ¿Avanzamos con 120 o 60 días?"</em></td>
    <td style="padding: 8px 10px;"><em>"Dale. ¿Te reservo el de 120 o arrancamos con 60?"</em></td>
  </tr>
  <tr style="background: #f8fafc;">
    <td style="padding: 8px 10px; font-weight: 600;">Autoridad inicial</td>
    <td style="padding: 8px 10px;">Lo menciona pero no insiste</td>
    <td style="padding: 8px 10px;">Lo destaca: "13 años, +15.000 personas"</td>
  </tr>
  <tr>
    <td style="padding: 8px 10px; font-weight: 600;">Urgencia al cerrar</td>
    <td style="padding: 8px 10px;">Calmada, sin apuro</td>
    <td style="padding: 8px 10px;">Activa: "ya mismo", "para despachar YA"</td>
  </tr>
  <tr style="background: #f8fafc;">
    <td style="padding: 8px 10px; font-weight: 600;">Manejo de objeción de plata</td>
    <td style="padding: 8px 10px;">Minimiza y redirige</td>
    <td style="padding: 8px 10px;">Empatiza y ofrece alternativa más barata</td>
  </tr>
  <tr>
    <td style="padding: 8px 10px; font-weight: 600;">Manejo de desconfianza</td>
    <td style="padding: 8px 10px;">Respuesta corta de 1 línea</td>
    <td style="padding: 8px 10px;">Explicación detallada con foco en "riesgo cero"</td>
  </tr>
  <tr style="background: #f8fafc;">
    <td style="padding: 8px 10px; font-weight: 600;">Casos cubiertos en FAQs</td>
    <td style="padding: 8px 10px;">${v3.faq.length} situaciones</td>
    <td style="padding: 8px 10px;">${v4.faq.length} situaciones (más casos médicos, instrucciones detalladas, garantías)</td>
  </tr>
  <tr>
    <td style="padding: 8px 10px; font-weight: 600;">Mejor para...</td>
    <td style="padding: 8px 10px;">Clientes que prefieren ser asesorados sin presión</td>
    <td style="padding: 8px 10px;">Clientes indecisos que necesitan empuje al cierre</td>
  </tr>
</table>
</div>

<h2>Recomendación</h2>

<div class="highlight">
<p style="margin: 0 0 8px 0;">
<strong>Para usar V3:</strong> público que valora ser tratado como adulto y
no se siente cómodo con la presión de venta argentina típica. Conversaciones
más cortas, menos roce, pero también <em>menos cierres asistidos</em>.
</p>
<p style="margin: 0;">
<strong>Para usar V4:</strong> público mass-market que necesita acompañamiento
fuerte para tomar la decisión. Más conversión por cierre activo, mayor manejo
de objeciones de plata y desconfianza. <em>Es la elección por defecto si el
objetivo es maximizar ventas mes a mes.</em>
</p>
</div>

<p style="font-size: 9.5pt; color: #555; margin-top: 16px;">
La forma de saber cuál anda mejor para Herbalis es <strong>medirlo en
producción</strong>: dejar correr V3 a la mitad de los clientes y V4 a la otra
mitad por una semana, y comparar tasa de cierre. Hoy tenemos los reportes
automáticos de embudo que ya capturarían esa diferencia.
</p>

<div class="footer">
Comparativo V3 vs V4 · Documento generado el ${today} · Bot Herbalis
</div>

</body></html>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
    const v3 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v3.json'), 'utf8'));
    const v4 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v4.json'), 'utf8'));

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const reportsDir = path.join(__dirname, '..', 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    const dateSlug = new Date().toISOString().split('T')[0];

    const targets = [
        { name: 'guion-v3', html: buildSingleGuionHtml(v3, { isV3: true }) },
        { name: 'guion-v4', html: buildSingleGuionHtml(v4, { isV3: false }) },
        { name: 'guion-comparativo', html: buildComparativeHtml(v3, v4) },
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
