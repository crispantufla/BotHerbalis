/**
 * Informe ejecutivo de caída de conversión — versión para dirección/jefe.
 * Sin tecnicismos. Lenguaje de negocio.
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
<title>Informe — Caída en las ventas del bot</title>
<style>
  @page { size: A4; margin: 22mm 18mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    color: #1a1a1a;
    line-height: 1.6;
    font-size: 11pt;
    margin: 0;
  }
  h1 { font-size: 24pt; margin: 0 0 6px 0; color: #0f5132; letter-spacing: -0.5px; }
  h2 { font-size: 15pt; margin: 28px 0 10px 0; color: #0f5132; border-bottom: 2px solid #0f5132; padding-bottom: 5px; }
  h3 { font-size: 12pt; margin: 18px 0 8px 0; color: #1a1a1a; }
  .subtitle { color: #555; margin-bottom: 6px; font-size: 12pt; }
  .meta { color: #888; font-size: 9pt; margin-bottom: 24px; }
  p { margin: 8px 0 12px 0; }
  ul { margin: 6px 0 14px 22px; padding: 0; }
  li { margin-bottom: 6px; }
  ol { margin: 6px 0 14px 26px; padding: 0; }
  ol li { margin-bottom: 10px; }
  strong { color: #0f5132; }

  table { width: 100%; border-collapse: collapse; margin: 12px 0 18px 0; font-size: 10.5pt; }
  th, td { padding: 9px 11px; text-align: left; border-bottom: 1px solid #ddd; }
  th { background: #f1f5f4; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.peak { background: #ecfdf5; }
  tr.peak td { font-weight: 600; }
  tr.crash { background: #fef2f2; }

  .kpi-row { display: flex; gap: 12px; margin: 14px 0 22px 0; }
  .kpi { flex: 1; background: #f1f5f4; border-left: 4px solid #0f5132; padding: 12px 14px; border-radius: 4px; }
  .kpi .num { font-size: 24pt; font-weight: 700; color: #0f5132; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .kpi .label { font-size: 9pt; color: #555; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
  .kpi.bad { background: #fef2f2; border-left-color: #b91c1c; }
  .kpi.bad .num { color: #b91c1c; }
  .kpi.warn { background: #fffbeb; border-left-color: #b45309; }
  .kpi.warn .num { color: #b45309; }

  .alert { background: #fef2f2; border-left: 4px solid #b91c1c; padding: 12px 16px; border-radius: 4px; margin: 10px 0 16px 0; }
  .alert strong { color: #991b1b; }
  .warn { background: #fffbeb; border-left: 4px solid #b45309; padding: 12px 16px; border-radius: 4px; margin: 10px 0 16px 0; }
  .warn strong { color: #92400e; }
  .info { background: #eff6ff; border-left: 4px solid #1d4ed8; padding: 12px 16px; border-radius: 4px; margin: 10px 0 16px 0; }
  .info strong { color: #1e3a8a; }
  .good { background: #ecfdf5; border-left: 4px solid #059669; padding: 12px 16px; border-radius: 4px; margin: 10px 0 16px 0; }

  .funnel-bar {
    background: #e5e7eb;
    height: 30px;
    border-radius: 4px;
    position: relative;
    margin: 6px 0;
    overflow: hidden;
  }
  .funnel-bar .fill {
    background: linear-gradient(90deg, #059669, #10b981);
    height: 100%;
    display: flex;
    align-items: center;
    padding: 0 12px;
    color: white;
    font-weight: 600;
    font-size: 10pt;
    white-space: nowrap;
  }
  .funnel-bar.bad .fill { background: linear-gradient(90deg, #b91c1c, #ef4444); }

  .priority { display: inline-block; padding: 3px 10px; border-radius: 14px; font-size: 9pt; font-weight: 700; margin-right: 8px; vertical-align: middle; }
  .p-high { background: #fef2f2; color: #991b1b; }
  .p-med { background: #fffbeb; color: #92400e; }
  .p-low { background: #f1f5f4; color: #1f2937; }

  .footer-note { margin-top: 32px; padding-top: 16px; border-top: 1px solid #ddd; color: #666; font-size: 9pt; }
  .page-break { page-break-before: always; }
  .small { font-size: 9.5pt; color: #555; font-style: italic; }
  blockquote { margin: 8px 0 12px 0; padding: 8px 14px; border-left: 3px solid #ccc; color: #555; font-style: italic; }
</style>
</head>
<body>

<h1>Informe — Por qué bajaron las ventas</h1>
<div class="subtitle">Análisis del bot de Herbalis · Comparación marzo vs hoy</div>
<div class="meta">${today}</div>

<h2>En una frase</h2>

<p>
  En la última semana de marzo el bot vendía a <strong>1 de cada 10</strong> personas que le
  escribían. Para mediados de abril <strong>vendía a 1 de cada 23</strong> — menos de la mitad.
  Después del 17 de abril <strong>directamente dejó de funcionar</strong> porque los teléfonos
  de los vendedores se desconectaron del bot y nadie volvió a vincularlos.
</p>

<div class="kpi-row">
  <div class="kpi">
    <div class="num">10,7%</div>
    <div class="label">Mejor semana (mar 22-28)</div>
  </div>
  <div class="kpi bad">
    <div class="num">4,4%</div>
    <div class="label">Última semana real (abr 12-17)</div>
  </div>
  <div class="kpi warn">
    <div class="num">−59%</div>
    <div class="label">Caída en 3 semanas</div>
  </div>
  <div class="kpi bad">
    <div class="num">0</div>
    <div class="label">Ventas desde 13 de abril</div>
  </div>
</div>

<div class="alert">
  <strong>Lo más urgente:</strong> el bot prácticamente no está vendiendo desde mediados
  de abril porque los teléfonos de los vendedores quedaron desvinculados. Hay que volver a
  conectarlos antes que cualquier otra cosa, o nada de lo demás importa.
</div>

<h2>1 · Cómo bajaron las ventas, semana a semana</h2>

<p>
  Tomamos los datos de <strong>Horacio</strong> porque en marzo era el único vendedor activo y
  por eso sus números son los más limpios para comparar. La conversión es <em>cuántas personas
  de las que escribieron al bot terminaron comprando</em>.
</p>

<table>
  <thead>
    <tr>
      <th>Semana</th>
      <th class="num">Personas que escribieron</th>
      <th class="num">Ventas confirmadas</th>
      <th class="num">% que compró</th>
      <th class="num">Facturación</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>Mar 15-21</td><td class="num">507</td><td class="num">41</td><td class="num">8,1%</td><td class="num">$2.375.900</td></tr>
    <tr class="peak"><td>Mar 22-28 ★ (la mejor)</td><td class="num">523</td><td class="num">56</td><td class="num">10,7%</td><td class="num">$3.199.600</td></tr>
    <tr><td>Mar 29 – Abr 4</td><td class="num">197</td><td class="num">15</td><td class="num">7,6%</td><td class="num">$885.500</td></tr>
    <tr><td>Abr 5-11</td><td class="num">333</td><td class="num">23</td><td class="num">6,9%</td><td class="num">$1.349.700</td></tr>
    <tr class="crash"><td>Abr 12-17 (última real)</td><td class="num">182</td><td class="num">8</td><td class="num">4,4%</td><td class="num">$480.200</td></tr>
    <tr><td>Abr 18 en adelante</td><td class="num" colspan="4" style="text-align:center; color:#991b1b;">Bot desconectado — sin datos</td></tr>
  </tbody>
</table>

<div class="info">
  <strong>Dato clave:</strong> el ticket promedio se mantuvo en ~$58.000 todo el período.
  <em>El precio no es el problema</em> — el problema es que cierran menos personas.
</div>

<h3>La caída en imágenes</h3>

<div class="funnel-bar"><div class="fill" style="width: 100%;">Mar 22-28 — 56 ventas / 523 chats — 10,7%</div></div>
<div class="funnel-bar"><div class="fill" style="width: 71%;">Mar 29 - Abr 4 — 15 / 197 — 7,6%</div></div>
<div class="funnel-bar"><div class="fill" style="width: 64%;">Abr 5-11 — 23 / 333 — 6,9%</div></div>
<div class="funnel-bar bad"><div class="fill" style="width: 41%;">Abr 12-17 — 8 / 182 — 4,4%</div></div>

<h2>2 · Por qué bajaron las ventas</h2>

<p>
  Identificamos <strong>cuatro cambios</strong> introducidos en abril que coinciden con la caída.
  En orden de mayor a menor impacto:
</p>

<h3>2.1 · El bot empezó a ofrecer 3 formas de pago en vez de una sola</h3>

<p>
  Antes, cuando el cliente confirmaba el pedido, el bot iba directo a tomar los datos.
  Desde el 10 de abril el bot le pregunta al cliente: <em>"¿querés pagar con tarjeta, transferencia,
  o contra reembolso?"</em>.
</p>

<p>
  En ventas existe el concepto de <strong>"parálisis por elección"</strong>: cuando le dan
  demasiadas opciones a una persona que estaba a punto de comprar, una parte se traba y no
  sigue. Esto coincide exactamente con la semana en que la conversión bajó a 4,4%.
</p>

<h3>2.2 · El bot empezó a respetar el "no me interesa" de manera más estricta</h3>

<p>
  Antes, cuando un cliente respondía "no quiero", "no me interesa", "no tengo plata", el bot
  insistía un poco con argumentos de venta. Desde el 9 de abril, cuando detecta esas frases
  el bot directamente se va y pausa el chat.
</p>

<p>
  Es una decisión correcta éticamente — no insistir a quien no quiere — pero en la realidad
  una parte de esos "no" son objeciones recuperables ("no tengo plata ahora" suele convertirse
  en venta postdatada). Hoy hay <strong>22 chats marcados como "rechazó explícitamente"</strong>
  que antes el bot habría intentado recuperar.
</p>

<h3>2.3 · El bot cambió frases emocionales por argumentos racionales</h3>

<p>
  El 7 de abril se reemplazaron frases como <em>"no arriesgás nada"</em> por argumentos
  más serios de credibilidad. Más honesto en lo formal, pero en ventas argentinas las frases
  emocionales clásicas suelen cerrar más que las racionales.
</p>

<h3>2.4 · Cambios técnicos profundos del 8 al 11 de abril</h3>

<p>
  Esa semana se reorganizó toda la base del sistema para soportar varios vendedores a la vez.
  Es un cambio grande que pudo afectar cómo el bot recuerda conversaciones anteriores o
  cómo entiende el contexto del cliente. La conversión cayó justo la semana siguiente.
</p>

<h2>3 · Cambios de mayo que agravan el problema</h2>

<p>
  Entre el 6 y el 14 de mayo se hicieron más cambios. Para entonces la conversión ya venía
  cayendo, así que estos no son la causa original, pero <strong>profundizan</strong> el problema:
</p>

<h3>3.1 · Pedir seña de $10.000 para pago contra reembolso</h3>

<div class="warn">
  <strong>El cambio más sensible para Argentina.</strong>
</div>

<table>
  <thead><tr><th>Aspecto</th><th>Antes (marzo)</th><th>Ahora (mayo)</th></tr></thead>
  <tbody>
    <tr><td>Pago contra entrega</td><td>100% al recibir el paquete</td><td>$10.000 por adelantado + saldo al cartero</td></tr>
    <tr><td>Aplica a</td><td>Sólo plan 60 días (gratis en plan 120)</td><td>TODOS los planes y TODOS los clientes</td></tr>
  </tbody>
</table>

<p>
  El mercado argentino es muy desconfiado con los pagos por adelantado. El contra reembolso
  100% al recibir el paquete es <em>la principal razón por la que muchos clientes se animan
  a comprar online</em>. Pedirles que paguen $10.000 antes — incluso si después pagan el resto
  al cartero — rompe esa confianza.
</p>

<h3>3.2 · El bot ahora elige el producto en vez de ofrecerle al cliente</h3>

<table>
  <thead><tr><th>Cantidad de kilos a bajar</th><th>Antes (marzo)</th><th>Ahora (mayo)</th></tr></thead>
  <tbody>
    <tr><td>Hasta 10 kg</td><td>El cliente elegía: cápsulas, gotas o semillas</td><td>Bot impone: <strong>gotas</strong></td></tr>
    <tr><td>Entre 10 y 20 kg</td><td>El cliente elegía</td><td>Bot impone: cápsulas 60 días</td></tr>
    <tr><td>Más de 20 kg</td><td>El cliente elegía</td><td>Bot impone: cápsulas 120 días</td></tr>
  </tbody>
</table>

<div class="warn">
  En marzo el 75% de las ventas fueron de <strong>cápsulas</strong>. El cambio actual
  recomienda gotas a los clientes que quieren bajar pocos kilos — que es el grupo más
  numeroso. Esto contradice la estrategia ganadora de marzo, donde se había detectado que
  cápsulas convertía mucho mejor.
</div>

<h3>3.3 · El saludo inicial se volvió frío</h3>

<table>
  <thead><tr><th>Saludo de marzo (10,7% conversión)</th><th>Saludo de mayo</th></tr></thead>
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
  El saludo nuevo perdió tres cosas importantes:
</p>

<ul>
  <li><strong>Autoridad:</strong> "Hace 13 años acompañamos a miles de personas" — generaba confianza.</li>
  <li><strong>Beneficio:</strong> "Envío sin costo a todo el país" — uno de los principales argumentos de venta.</li>
  <li><strong>Calidez:</strong> "Mandame el número" suena a una máquina del banco, no a un asesor.</li>
</ul>

<div class="page-break"></div>

<h2>4 · Estado actual de los vendedores</h2>

<p>
  Hoy, sólo <strong>uno</strong> de los teléfonos vinculados al bot está funcionando, y casi
  no tiene tráfico. El resto está desconectado desde mediados de abril:
</p>

<table>
  <thead><tr><th>Vendedor</th><th>Estado del teléfono</th><th>Último mensaje atendido</th></tr></thead>
  <tbody>
    <tr class="crash"><td>Pablo</td><td>Desconectado</td><td>17 de abril</td></tr>
    <tr class="crash"><td>Denis</td><td>Desconectado</td><td>17 de abril</td></tr>
    <tr class="crash"><td>Suzane</td><td>Desconectado</td><td>17 de abril</td></tr>
    <tr class="crash"><td>Inés</td><td>Desconectado</td><td>17 de abril</td></tr>
    <tr class="crash"><td>Alejandra</td><td>Desconectado</td><td>17 de abril</td></tr>
    <tr class="crash"><td>Horacio</td><td>Esperando que escaneen el QR</td><td>17 de abril</td></tr>
  </tbody>
</table>

<p>
  La última venta confirmada en el sistema es del <strong>13 de abril</strong>. La métrica
  de conversión que muestra el panel hoy es un <strong>promedio histórico</strong> que mezcla
  los buenos meses con las semanas en cero — por eso parece que "cada vez baja más", pero en
  realidad lo que pasa es que no hay ventas nuevas que mejoren el promedio.
</p>

<h2>5 · Qué hacer, en orden de prioridad</h2>

<ol>
  <li>
    <span class="priority p-high">URGENTE — hoy</span><br>
    <strong>Volver a conectar los teléfonos al bot.</strong> Que cada vendedor escanee de nuevo
    el código QR. Sin esto, no llega ningún mensaje y nada del resto sirve.
  </li>

  <li>
    <span class="priority p-high">ALTA — esta semana</span><br>
    <strong>Volver al flujo de pago de marzo</strong> (o probar las dos versiones en paralelo).
    Sacar la pregunta de las 3 opciones y dejar que el bot vaya directo a tomar los datos
    como hacía cuando vendíamos 10,7%.
  </li>

  <li>
    <span class="priority p-high">ALTA — esta semana</span><br>
    <strong>Eliminar la seña de $10.000 para contra reembolso</strong>, o al menos reducirla
    a un monto bajo (3-5 mil) o hacerla opcional. Volver al modelo donde el cliente paga todo
    al cartero.
  </li>

  <li>
    <span class="priority p-med">MEDIA — próximas dos semanas</span><br>
    <strong>Revisar los 22 chats marcados como "rechazó explícitamente"</strong>. Si una buena
    parte eran clientes recuperables, ajustar el bot para que no se rinda tan rápido ante un
    "no" inicial.
  </li>

  <li>
    <span class="priority p-med">MEDIA</span><br>
    <strong>Restaurar frases emocionales en el cierre.</strong> Algo equivalente al
    "no arriesgás nada" que se quitó el 7 de abril.
  </li>

  <li>
    <span class="priority p-med">MEDIA</span><br>
    <strong>Cambiar la recomendación para el tier de pocos kilos:</strong> volver a empujar
    cápsulas (que es lo que mejor vendía en marzo) en lugar de gotas.
  </li>

  <li>
    <span class="priority p-low">BAJA</span><br>
    <strong>Recuperar el tono cálido del saludo</strong>: agregar "13 años acompañando a
    miles de personas" y "envío sin costo a todo el país" al mensaje inicial.
  </li>

  <li>
    <span class="priority p-low">BAJA</span><br>
    <strong>Reiniciar el contador de conversión</strong> del panel después de aplicar los
    cambios, para que la métrica refleje el resultado real de la nueva versión y no el
    promedio mezclado de los meses malos.
  </li>
</ol>

<h2>6 · Qué esperar</h2>

<p>
  Si reconectamos los teléfonos hoy y revertimos los cambios del flujo de pago y la seña
  de contra reembolso esta semana, la <strong>expectativa razonable</strong> es:
</p>

<ul>
  <li>Recuperar entre <strong>7% y 9% de conversión</strong> en 2-3 semanas (el rango que
    teníamos justo antes de los cambios problemáticos).</li>
  <li>Volver al pico de <strong>10%+</strong> requiere también revertir o suavizar los
    cambios secundarios (rechazo explícito, copy, recomendación por tier).</li>
</ul>

<p>
  Con un ticket promedio de <strong>$58.000</strong>, recuperar 5 puntos de conversión sobre
  ~500 chats/semana significa <strong>~25 ventas adicionales por semana</strong> — del orden
  de <strong>$1,4 millones de facturación semanal</strong> por vendedor en los rangos que
  manejaba Horacio en marzo.
</p>

<div class="good">
  <strong>La buena noticia:</strong> los cambios que rompieron la conversión son
  <em>reversibles</em>. No hay un problema estructural del bot ni de los productos. Las
  ventas se recuperan revirtiendo los cambios de abril y mayo en el orden de la lista.
</div>

<div class="footer-note">
  Informe preparado a partir del análisis de la base de datos del bot entre el 8 de marzo
  y el 15 de mayo de 2026. Los porcentajes y cifras de facturación corresponden a
  operaciones reales registradas en el sistema.
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

    const outPath = path.join(__dirname, '..', 'reports', `informe-ventas-${new Date().toISOString().split('T')[0]}.pdf`);
    await page.pdf({
        path: outPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '20mm', right: '16mm', bottom: '20mm', left: '16mm' },
    });
    await browser.close();

    const stats = fs.statSync(outPath);
    console.log(`PDF generado: ${outPath}`);
    console.log(`Tamaño: ${(stats.size / 1024).toFixed(1)} KB`);
})();
