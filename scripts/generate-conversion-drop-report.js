/**
 * Genera un PDF ejecutivo del análisis de caída de conversión.
 * Uso: node scripts/generate-conversion-drop-report.js
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const today = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });

const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Análisis de caída de conversión — Herbalis Bot</title>
<style>
  @page { size: A4; margin: 20mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    color: #1a1a1a;
    line-height: 1.5;
    font-size: 10.5pt;
    margin: 0;
  }
  h1 { font-size: 22pt; margin: 0 0 4px 0; color: #0f5132; letter-spacing: -0.5px; }
  h2 { font-size: 13pt; margin: 22px 0 8px 0; color: #0f5132; border-bottom: 2px solid #0f5132; padding-bottom: 4px; }
  h3 { font-size: 11pt; margin: 14px 0 6px 0; color: #1a1a1a; }
  .subtitle { color: #555; margin-bottom: 4px; font-size: 11pt; }
  .meta { color: #888; font-size: 8.5pt; margin-bottom: 18px; }
  p { margin: 6px 0 8px 0; }
  ul { margin: 4px 0 10px 18px; padding: 0; }
  li { margin-bottom: 3px; }
  ol { margin: 4px 0 10px 22px; padding: 0; }
  ol li { margin-bottom: 6px; }

  table { width: 100%; border-collapse: collapse; margin: 8px 0 14px 0; font-size: 9.5pt; }
  th, td { padding: 6px 9px; text-align: left; border-bottom: 1px solid #ddd; }
  th { background: #f1f5f4; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.peak { background: #ecfdf5; font-weight: 600; }
  tr.crash { background: #fef2f2; }

  .kpi-row { display: flex; gap: 10px; margin: 8px 0 16px 0; }
  .kpi { flex: 1; background: #f1f5f4; border-left: 4px solid #0f5132; padding: 9px 11px; border-radius: 3px; }
  .kpi .num { font-size: 19pt; font-weight: 700; color: #0f5132; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .kpi .label { font-size: 8pt; color: #555; text-transform: uppercase; letter-spacing: 0.4px; margin-top: 2px; }
  .kpi.bad { background: #fef2f2; border-left-color: #b91c1c; }
  .kpi.bad .num { color: #b91c1c; }
  .kpi.warn { background: #fffbeb; border-left-color: #b45309; }
  .kpi.warn .num { color: #b45309; }

  .alert { background: #fef2f2; border-left: 4px solid #b91c1c; padding: 9px 12px; border-radius: 3px; margin: 8px 0 12px 0; }
  .alert strong { color: #991b1b; }
  .warn { background: #fffbeb; border-left: 4px solid #b45309; padding: 9px 12px; border-radius: 3px; margin: 8px 0 12px 0; }
  .warn strong { color: #92400e; }
  .info { background: #eff6ff; border-left: 4px solid #1d4ed8; padding: 9px 12px; border-radius: 3px; margin: 8px 0 12px 0; }
  .info strong { color: #1e3a8a; }
  .good { background: #ecfdf5; border-left: 4px solid #059669; padding: 9px 12px; border-radius: 3px; margin: 8px 0 12px 0; }

  .commit { font-family: 'Menlo', 'Monaco', 'Courier New', monospace; font-size: 9pt; background: #f5f5f5; padding: 1px 4px; border-radius: 2px; color: #c2410c; }
  .step { font-family: 'Menlo', 'Monaco', 'Courier New', monospace; font-size: 9pt; color: #1e40af; }
  code { font-family: 'Menlo', 'Monaco', 'Courier New', monospace; font-size: 9pt; background: #f5f5f5; padding: 1px 4px; border-radius: 2px; }

  .funnel-bar {
    background: #e5e7eb;
    height: 24px;
    border-radius: 3px;
    position: relative;
    margin: 4px 0;
    overflow: hidden;
  }
  .funnel-bar .fill {
    background: linear-gradient(90deg, #059669, #10b981);
    height: 100%;
    display: flex;
    align-items: center;
    padding: 0 8px;
    color: white;
    font-weight: 600;
    font-size: 9pt;
  }
  .funnel-bar.bad .fill { background: linear-gradient(90deg, #b91c1c, #ef4444); }

  .priority { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 8.5pt; font-weight: 700; margin-right: 6px; vertical-align: middle; }
  .p-high { background: #fef2f2; color: #991b1b; }
  .p-med { background: #fffbeb; color: #92400e; }
  .p-low { background: #f1f5f4; color: #1f2937; }

  .footer-note { margin-top: 28px; padding-top: 14px; border-top: 1px solid #ddd; color: #666; font-size: 8.5pt; }
  .page-break { page-break-before: always; }
  .small { font-size: 9pt; color: #555; }
</style>
</head>
<body>

<h1>Análisis de caída de conversión</h1>
<div class="subtitle">Herbalis Bot · Mar 22-28 vs estado actual</div>
<div class="meta">Generado: ${today} · Datos: tabla Order / User / BotConfig / WhatsAppSession en producción</div>

<h2>Resumen ejecutivo</h2>

<div class="kpi-row">
  <div class="kpi">
    <div class="num">10.7%</div>
    <div class="label">Pico Mar 22-28 (★)</div>
  </div>
  <div class="kpi bad">
    <div class="num">4.4%</div>
    <div class="label">Abr 12-17 (última real)</div>
  </div>
  <div class="kpi warn">
    <div class="num">-6.3pp</div>
    <div class="label">Caída neta en 3 semanas</div>
  </div>
  <div class="kpi bad">
    <div class="num">0</div>
    <div class="label">Órdenes desde 13 abr</div>
  </div>
</div>

<p>
  La caída de conversión es <strong>real y medible</strong>: pasó de <strong>10.7% en la semana
  ★ del 22-28 marzo</strong> a <strong>4.4% en la semana del 12-17 abril</strong>. Después del
  17 de abril <strong>no hay datos</strong> porque las sesiones de WhatsApp de todos los
  vendedores principales quedaron desconectadas y nunca se rescanearon.
</p>

<div class="alert">
  <strong>Hallazgo principal:</strong> la caída empezó <em>antes</em> que V5/V6 y MP-first.
  Entre el 8 y el 11 de abril hubo un refactor multi-tenant + un cambio del flujo de pago a
  3 opciones que coincide exactamente con la pendiente descendente. V5/V6 (6 may) y MP-first
  con seña $10k (12 may) agravan lo que ya venía mal, pero no son la causa raíz.
</div>

<div class="warn">
  <strong>Estado operativo crítico:</strong> 7 de las 8 sesiones de WhatsApp están en
  <code>disconnected</code> o <code>qr_pending</code> desde el 17 de abril. Sólo
  <code>terciario</code> (24 chats en mayo) tiene actividad reciente. <em>Sin reconectar las
  sesiones, la métrica no puede mejorar — no llegan chats.</em>
</div>

<h2>1 · Conversión semanal de horacio (único vendedor en marzo)</h2>

<p class="small">
  Horacio era el único vendedor activo en marzo, así que sus datos son los más limpios
  para medir evolución. Filtramos <code>instanceId = 'horacio'</code> en todas las tablas.
</p>

<table>
  <thead>
    <tr>
      <th>Semana</th>
      <th class="num">Chats</th>
      <th class="num">Pedidos OK</th>
      <th class="num">Conv%</th>
      <th class="num">Revenue</th>
      <th class="num">AOV</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>Mar 8-14</td><td class="num">114</td><td class="num">43</td><td class="num">37.7%</td><td class="num">$2.598.700</td><td class="num">$60.435</td></tr>
    <tr><td>Mar 15-21</td><td class="num">507</td><td class="num">41</td><td class="num">8.1%</td><td class="num">$2.375.900</td><td class="num">$57.949</td></tr>
    <tr class="peak"><td>Mar 22-28 ★</td><td class="num">523</td><td class="num">56</td><td class="num">10.7%</td><td class="num">$3.199.600</td><td class="num">$57.136</td></tr>
    <tr><td>Mar 29 – Abr 4</td><td class="num">197</td><td class="num">15</td><td class="num">7.6%</td><td class="num">$885.500</td><td class="num">$59.033</td></tr>
    <tr><td>Abr 5-11</td><td class="num">333</td><td class="num">23</td><td class="num">6.9%</td><td class="num">$1.349.700</td><td class="num">$58.683</td></tr>
    <tr class="crash"><td>Abr 12-17</td><td class="num">182</td><td class="num">8</td><td class="num">4.4%</td><td class="num">$480.200</td><td class="num">$60.025</td></tr>
  </tbody>
</table>

<p class="small">
  El AOV (ticket promedio) se mantiene constante en ~$58k-$60k. <strong>El problema no es
  el precio</strong>: es que cierran menos. Mar 8-14 tiene 37.7% pero es muestra chica (114 chats)
  y probablemente leads calientes pre-existentes; lo descartamos como anomalía.
</p>

<h3>Visualización de la caída</h3>

<div class="funnel-bar"><div class="fill" style="width: 100%;">Mar 22-28 · 10.7% · 56 pedidos / 523 chats</div></div>
<div class="funnel-bar"><div class="fill" style="width: 71%;">Mar 29-Abr 4 · 7.6% · 15 / 197</div></div>
<div class="funnel-bar"><div class="fill" style="width: 64%;">Abr 5-11 · 6.9% · 23 / 333</div></div>
<div class="funnel-bar bad"><div class="fill" style="width: 41%;">Abr 12-17 · 4.4% · 8 / 182</div></div>

<h2>2 · Lo que cambió entre Mar 22 y Abr 17</h2>

<p>
  Commits ordenados por probabilidad de impacto. Ventana <code>Mar 22 → Apr 11</code>
  filtrada por cambios en <code>src/flows</code>, <code>src/services/ai.ts</code> y
  <code>src/handlers</code>.
</p>

<h3>2.1 · Refactor multi-tenant + flujo de 3 opciones de pago (8-11 abril)</h3>

<div class="alert">
  <strong>Sospechoso #1.</strong> La semana siguiente (Abr 12-17) la conversión cae a 4.4%.
</div>

<ul>
  <li><span class="commit">c5e8ece</span> · 8 abr · <strong>feat(multi-tenant): plataforma unificada multi-vendedor</strong> — refactor enorme de toda la base.</li>
  <li><span class="commit">170c874</span> · 10 abr · <strong>feat(payment): add 3-option payment flow (MP, transferencia, contrarembolso)</strong> — antes era flow más simple, ahora paradox of choice en el momento más caliente de la venta.</li>
  <li><span class="commit">a210d5e</span> · 10 abr · <strong>set rotacion as default script</strong> — cada chat rota impredeciblemente, no se puede medir un script aislado.</li>
  <li><span class="commit">8d5a24a</span> · 10 abr · scoping de queries por <code>instanceId</code> — pudo afectar lookup de historial de chat / contexto IA en chats existentes.</li>
  <li><span class="commit">a9b0835</span> · 10 abr · <strong>always offer payment method after plan selection</strong> — antes era opcional.</li>
  <li><span class="commit">d52acc0</span> · 11 abr · <em>clarify contra reembolso pays cartero cash-only</em>.</li>
</ul>

<h3>2.2 · Handler de rechazo explícito (9 abril)</h3>

<ul>
  <li><span class="commit">3f44195</span> · 9 abr · <strong>handle explicit rejection ("no quiero nada", "callate")</strong> — el bot ahora respeta el "no". Antes insistía.</li>
</ul>

<p>
  Es correcto desde lo ético, pero matemáticamente baja conversión cruda. Confirmación:
  hoy <strong>22 users de bot_secundario están con <code>pauseReason = "rechazó explícitamente"</code></strong>;
  en marzo esa categoría no existía. Antes esos chats el bot los insistía y un % terminaba comprando.
</p>

<h3>2.3 · Cambio de copy (7 abril)</h3>

<ul>
  <li><span class="commit">018faec</span> · 7 abr · <strong>replace misleading "no arriesgás nada" with credibility arguments</strong> — quita el cierre emocional clásico de venta argentina.</li>
</ul>

<p>
  Más honesto, probablemente peor de cierre. La frase "no arriesgás nada" es un trigger
  clásico de venta — reemplazarla por argumentos racionales suele bajar la tasa.
</p>

<h3>2.4 · Semantic cache de IA (11 abril)</h3>

<ul>
  <li><span class="commit">4da1e33</span> · 11 abr · <em>feat(ai): semantic cache, objection detector, rolling summary, rescue metrics</em>.</li>
</ul>

<p>
  El cache semántico puede devolver respuestas que <em>se parecen</em> pero no calzan con
  el contexto actual del chat. Si dos chats distintos comparten una respuesta cacheada,
  uno de los dos pierde matiz contextual.
</p>

<div class="page-break"></div>

<h2>3 · Cambios posteriores que agravan la situación (mayo)</h2>

<p>
  No son la causa original, pero <strong>sí</strong> deterioran lo que ya estaba mal.
  Para cuando estos cambios entraron, la conversión ya venía cayendo a 4.4%.
</p>

<h3>3.1 · MP-first + seña $10k obligatoria para COD (12 mayo)</h3>

<p>
  <span class="commit">6dea6df</span> · <em>feat(pago): MP-first policy, seña $10k para COD, archivar v3/v4</em>
</p>

<table>
  <thead><tr><th>Aspecto</th><th>V3 (marzo, alta conversión)</th><th>V5/V6 (actual)</th></tr></thead>
  <tbody>
    <tr><td>COD</td><td>100% al cartero. Adicional $6.000 sólo plan 60.</td><td><strong>$10.000 por adelantado obligatorio</strong> + saldo al cartero. Todos los planes.</td></tr>
    <tr><td>Aplica a</td><td>Plan 60 días (regalado en plan 120)</td><td>TODOS los planes, TODOS los clientes (nuevos y recurrentes)</td></tr>
    <tr><td>Fricción</td><td>Cliente paga al recibir</td><td>Cliente debe sacar tarjeta o ir al banco antes de recibir</td></tr>
  </tbody>
</table>

<div class="warn">
  El mercado argentino es muy COD-friendly. Pedir seña por adelantado a todos los clientes
  rompe la fricción más importante del comprador desconfiado: <em>"primero veo, después pago".</em>
</div>

<h3>3.2 · El bot prescribe producto en lugar de ofrecerlo (6 mayo)</h3>

<p><span class="commit">b36ad21</span> · <em>nuevo guión V5 — asesor consultivo (cápsulas + gotas)</em></p>

<table>
  <thead><tr><th>Decisión</th><th>V3 (marzo)</th><th>V5/V6 (actual)</th></tr></thead>
  <tbody>
    <tr><td>Tras kilos</td><td>Ofrece 3 opciones: cápsulas / semillas / gotas</td><td>Asigna por tier:</td></tr>
    <tr><td>Tier 1 (hasta 10 kg)</td><td>El cliente elige</td><td><strong>Gotas 60 días</strong></td></tr>
    <tr><td>Tier 2 (10-20 kg)</td><td>El cliente elige</td><td>Cápsulas 60 días</td></tr>
    <tr><td>Tier 3 (>20 kg)</td><td>El cliente elige</td><td>Cápsulas 120 días</td></tr>
  </tbody>
</table>

<div class="warn">
  Contradicción explícita con el commit <span class="commit">6ccbc0c</span> del 20 de marzo
  (<em>"refine gotas strategy to push capsulas"</em>): la estrategia ganadora del marzo
  glorioso era empujar cápsulas. V5/V6 vuelve a recomendar GOTAS para tier 1, el segmento
  más común. El producto en datos de marzo: 75% de las ventas fueron cápsulas.
</div>

<h3>3.3 · Greeting más frío y sin USPs (6 mayo)</h3>

<table>
  <thead><tr><th>V3 (marzo)</th><th>V5 (actual)</th></tr></thead>
  <tbody>
    <tr>
      <td>
        ¡Hola! 😊<br>
        Te ayudo a encontrar la opción justa para vos. <em>Antes de hablar de números, contame:</em><br>
        ¿Cuánto te gustaría bajar?<br>
        <em>Te pregunto eso primero porque el plan que te conviene depende del objetivo</em><br>
        🌿 Hace 13 años acompañamos a miles de personas con esto.<br>
        📦 Envío sin costo a todo el país.
      </td>
      <td>
        ¡Hola! 😊 Soy el asesor de Herbalis...<br>
        1️⃣ Pocos kilos<br>
        2️⃣ Bastante<br>
        3️⃣ Mucho<br>
        Mandame el número.
      </td>
    </tr>
  </tbody>
</table>

<p>
  V5 perdió: <strong>autoridad</strong> ("13 años, miles de clientes"), <strong>envío gratis</strong>
  (USP fuerte), <strong>el <em>por qué</em> de la pregunta</strong> (genera confianza) y el
  <strong>tono cálido</strong>. "Mandame el número" suena a IVR de banco.
</p>

<h2>4 · Estado operativo y problemas de tracking</h2>

<h3>4.1 · Sesiones de WhatsApp</h3>

<table>
  <thead><tr><th>Seller</th><th>Status</th><th>Último visto</th></tr></thead>
  <tbody>
    <tr class="crash"><td>pablo</td><td><code>disconnected</code></td><td>2026-04-17</td></tr>
    <tr class="crash"><td>denis</td><td><code>disconnected</code></td><td>2026-04-17</td></tr>
    <tr class="crash"><td>suzane</td><td><code>disconnected</code></td><td>2026-04-17</td></tr>
    <tr class="crash"><td>ines</td><td><code>disconnected</code></td><td>2026-04-17</td></tr>
    <tr class="crash"><td>alejandra</td><td><code>disconnected</code></td><td>2026-04-17</td></tr>
    <tr class="crash"><td>horacio</td><td><code>qr_pending</code></td><td>2026-04-18</td></tr>
    <tr><td>cristian</td><td><code>connected</code> (stale)</td><td>2026-04-09</td></tr>
  </tbody>
</table>

<p>Última <code>Order</code> en la base: <strong>2026-04-13</strong>. Última actividad en <code>ChatLog</code>: 17 abril a la mañana.</p>

<h3>4.2 · La métrica del dashboard es engañosa</h3>

<div class="info">
  <strong>scriptStats es un acumulador lifetime</strong> — cada greeting incrementa
  <code>.started</code>, cada venta exitosa incrementa <code>.completed</code>. El ratio
  baja con el tiempo porque entran chats de spam, números errados, re-entradas, mientras
  que sólo las ventas reales suman al numerador. Es una métrica estructuralmente sesgada
  a la baja.
</div>

<p>
  Existe un botón <em>"reiniciar conteo V5/V6"</em> en Settings (commit
  <span class="commit">3cfcc99</span>) — después de aplicar los cambios y reconectar las
  sesiones, conviene resetearlo para volver a medir limpio.
</p>

<h3>4.3 · Tracking de funnel roto</h3>

<ul>
  <li>Tabla <code>FunnelEvent</code> <strong>no existe</strong> en la base — el análisis fino de drop-off por step está deshabilitado.</li>
  <li>Tabla <code>DailyStats</code> se cortó el 11 de abril — el scheduler dejó de generar snapshots.</li>
</ul>

<div class="page-break"></div>

<h2>5 · Plan de acción</h2>

<ol>
  <li>
    <span class="priority p-high">URGENTE</span>
    <strong>Reconectar las sesiones de WhatsApp.</strong> Sin tráfico no hay nada que
    medir. Validar que las 5 sesiones de los vendedores principales escaneen QR y queden
    en <code>connected</code>.
  </li>

  <li>
    <span class="priority p-high">ALTA</span>
    <strong>Revertir o A/B-testear el flujo de 3 opciones de pago.</strong> Sospechoso #1
    de la caída. Probar el flujo simple de marzo contra el de 3 opciones con un % del
    tráfico durante 2 semanas. Métrica: pedidos OK / chats que llegaron a <span class="step">waiting_payment_method</span>.
  </li>

  <li>
    <span class="priority p-high">ALTA</span>
    <strong>Quitar la seña $10k obligatoria de COD.</strong> O al menos:
    <ul>
      <li>Volver al modelo de marzo (COD 100% al cartero, adicional $6k sólo plan 60).</li>
      <li>O reducir la seña a un monto simbólico ($3-5k).</li>
      <li>O hacerla opcional / sólo a tickets > X.</li>
    </ul>
  </li>

  <li>
    <span class="priority p-med">MEDIA</span>
    <strong>Sacar <code>rotacion</code> como default script.</strong> Fijar V5 o V6 para
    poder medir limpio. Mientras esté en rotación no hay manera de comparar.
  </li>

  <li>
    <span class="priority p-med">MEDIA</span>
    <strong>Revisar el handler de rechazo explícito.</strong> ¿Es demasiado sensible?
    Algunos "no me interesa" en realidad son objeciones recuperables. Revisar los 22 casos
    de <code>bot_secundario</code> con esa razón y ver cuántos eran rescatables.
  </li>

  <li>
    <span class="priority p-med">MEDIA</span>
    <strong>Restaurar la frase emocional</strong> o algo equivalente al <em>"no arriesgás
    nada"</em>. El copy ultra-honesto suele bajar cierre.
  </li>

  <li>
    <span class="priority p-med">MEDIA</span>
    <strong>Revisar el tier 1 de V5/V6.</strong> Hoy recomienda gotas; en marzo cápsulas
    convertía mejor (75% del producto vendido). Volver a empujar cápsulas para tier 1.
  </li>

  <li>
    <span class="priority p-low">BAJA</span>
    <strong>Restaurar la tabla <code>FunnelEvent</code></strong> y arreglar el scheduler
    de <code>DailyStats</code>. Sin estos no se puede medir drop-off por step en futuras
    iteraciones.
  </li>

  <li>
    <span class="priority p-low">BAJA</span>
    <strong>Resetear <code>scriptStats</code></strong> después de implementar lo anterior
    para que la métrica del dashboard tenga sentido.
  </li>

  <li>
    <span class="priority p-low">BAJA</span>
    <strong>Recuperar tono cálido + USPs en greeting de V5.</strong> V6 va por ahí, pero
    es 30% más largo. Buscar punto medio.
  </li>
</ol>

<h2>6 · Cómo medir el progreso</h2>

<p>
  Re-correr semanalmente <code>scripts/investigate-horacio.ts</code> después de cada
  cambio para ver la evolución de la conversión por semana, sólo del seller con más
  volumen. La métrica del dashboard agregado es ruidosa — la métrica por seller en
  ventanas semanales es la que se puede comparar contra el baseline de Mar 22-28.
</p>

<p class="small">
  Scripts utilizados en este análisis:<br>
  <code>scripts/investigate-conversion-drop.ts</code> · ventanas multi-período<br>
  <code>scripts/investigate-horacio.ts</code> · evolución semanal por seller<br>
  <code>scripts/investigate-active-now.ts</code> · estado actual de sellers<br>
  <code>scripts/check-data-presence.ts</code> · sanity check de la base<br>
  <code>scripts/debug-orders.ts</code>, <code>debug-orders2.ts</code>, <code>debug-orders3.ts</code> · inspección de tablas
</p>

<div class="footer-note">
  Generado automáticamente a partir de queries a la base de producción y análisis de git
  log/diff entre Mar 8 y May 15 de 2026. Las cifras de ventana se obtienen con
  <code>SELECT COUNT(*) FROM "User"/"Order" WHERE "instanceId"='horacio' AND "createdAt" BETWEEN ... AND ...</code>.
</div>

</body>
</html>`;

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const outPath = path.join(__dirname, '..', 'reports', `caida-conversion-${new Date().toISOString().split('T')[0]}.pdf`);
    await page.pdf({
        path: outPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '18mm', right: '14mm', bottom: '18mm', left: '14mm' },
    });
    await browser.close();

    const stats = fs.statSync(outPath);
    console.log(`PDF generado: ${outPath}`);
    console.log(`Tamaño: ${(stats.size / 1024).toFixed(1)} KB`);
})();
