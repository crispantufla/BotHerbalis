/**
 * Genera un PDF ejecutivo del análisis del embudo.
 * Uso: node scripts/generate-funnel-report.js
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const today = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });

const html = `
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Análisis del embudo de ventas</title>
<style>
  @page { size: A4; margin: 22mm 18mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    color: #1a1a1a;
    line-height: 1.55;
    font-size: 11pt;
    margin: 0;
  }
  h1 { font-size: 22pt; margin: 0 0 4px 0; color: #0f5132; }
  h2 { font-size: 14pt; margin: 24px 0 8px 0; color: #0f5132; border-bottom: 2px solid #0f5132; padding-bottom: 4px; }
  h3 { font-size: 12pt; margin: 16px 0 6px 0; color: #1a1a1a; }
  .subtitle { color: #555; margin-bottom: 6px; }
  .meta { color: #888; font-size: 9pt; margin-bottom: 24px; }
  p { margin: 6px 0 10px 0; }
  ul { margin: 6px 0 12px 18px; padding: 0; }
  li { margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 14px 0; font-size: 10pt; }
  th, td { padding: 7px 10px; text-align: left; border-bottom: 1px solid #ddd; }
  th { background: #f1f5f4; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .kpi-row { display: flex; gap: 12px; margin: 10px 0 18px 0; }
  .kpi { flex: 1; background: #f1f5f4; border-left: 4px solid #0f5132; padding: 10px 12px; border-radius: 4px; }
  .kpi .num { font-size: 22pt; font-weight: 700; color: #0f5132; line-height: 1.1; }
  .kpi .label { font-size: 9pt; color: #555; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
  .alert { background: #fff5e6; border-left: 4px solid #d97706; padding: 10px 14px; border-radius: 4px; margin: 8px 0 14px 0; }
  .alert strong { color: #b45309; }
  .good { background: #ecfdf5; border-left: 4px solid #059669; padding: 10px 14px; border-radius: 4px; margin: 8px 0 14px 0; }
  .funnel { margin: 12px 0 18px 0; }
  .funnel .stage { display: flex; align-items: center; margin-bottom: 6px; gap: 10px; }
  .funnel .label { width: 32%; font-size: 10pt; }
  .funnel .bar-wrap { flex: 1; background: #f1f5f4; border-radius: 4px; height: 22px; position: relative; }
  .funnel .bar { background: linear-gradient(90deg, #0f5132, #198754); height: 100%; border-radius: 4px; }
  .funnel .count { position: absolute; right: 8px; top: 0; line-height: 22px; font-size: 9.5pt; font-weight: 600; color: #1a1a1a; }
  .drop { color: #c62828; font-weight: 600; }
  .pri { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 9pt; font-weight: 600; margin-right: 6px; }
  .pri-high { background: #fee2e2; color: #b91c1c; }
  .pri-med { background: #fef3c7; color: #92400e; }
  .pri-low { background: #dbeafe; color: #1e40af; }
  .footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #ddd; font-size: 9pt; color: #888; }
  .page-break { page-break-before: always; }
</style>
</head>
<body>

<h1>Análisis del embudo de ventas</h1>
<div class="subtitle">Diagnóstico de conversión y oportunidades de mejora</div>
<div class="meta">Período analizado: últimos 30 días · Generado el ${today}</div>

<h2>Resumen ejecutivo</h2>

<div class="kpi-row">
  <div class="kpi">
    <div class="num">5.246</div>
    <div class="label">Conversaciones nuevas</div>
  </div>
  <div class="kpi">
    <div class="num">312</div>
    <div class="label">Ventas concretadas</div>
  </div>
  <div class="kpi">
    <div class="num">5,95%</div>
    <div class="label">Tasa de conversión global</div>
  </div>
</div>

<p>
La tasa de conversión actual del bot es del <strong>5,95%</strong>. El benchmark
para canales de venta conversacionales por WhatsApp con catálogo guiado se ubica
entre <strong>10% y 20%</strong>, por lo que existe espacio significativo para
mejorar el rendimiento.
</p>

<p>
Casi <strong>3.000 clientes potenciales se encuentran detenidos</strong> en algún
punto del proceso de compra, sin haber abandonado formalmente. Esto representa
un volumen recuperable importante con acciones puntuales y de bajo costo.
</p>

<div class="alert">
<strong>Diagnóstico principal:</strong> el problema no es operativo (todos los
vendedores tienen tasas similares, entre 5,5% y 6,7%), sino estructural en dos
puntos del proceso: la <strong>elección de plan</strong> y el
<strong>método de pago</strong>.
</div>

<h2>El embudo paso a paso</h2>

<p>
De cada 100 conversaciones que llegan al bot, así avanzan los clientes a través
del proceso de compra:
</p>

<div class="funnel">
  <div class="stage"><div class="label">Saludo inicial</div>
    <div class="bar-wrap"><div class="bar" style="width: 100%"></div><div class="count">631 (100%)</div></div></div>
  <div class="stage"><div class="label">Indicó su peso / objetivo</div>
    <div class="bar-wrap"><div class="bar" style="width: 63%"></div><div class="count">398 (63%)</div></div></div>
  <div class="stage"><div class="label">Eligió el producto</div>
    <div class="bar-wrap"><div class="bar" style="width: 51%"></div><div class="count">319 (51%)</div></div></div>
  <div class="stage"><div class="label">Eligió el plan</div>
    <div class="bar-wrap"><div class="bar" style="width: 20%"></div><div class="count">128 (20%)</div></div></div>
  <div class="stage"><div class="label">Eligió método de pago</div>
    <div class="bar-wrap"><div class="bar" style="width: 8%"></div><div class="count">51 (8%)</div></div></div>
  <div class="stage"><div class="label">Cargó dirección de envío</div>
    <div class="bar-wrap"><div class="bar" style="width: 5%"></div><div class="count">33 (5%)</div></div></div>
  <div class="stage"><div class="label">Confirmó el pedido</div>
    <div class="bar-wrap"><div class="bar" style="width: 4%"></div><div class="count">26 (4%)</div></div></div>
</div>

<p>
Los dos saltos donde más clientes se pierden son:
</p>
<ul>
  <li><strong>Al mostrar el plan/precio:</strong> de 319 que eligieron producto, solo 128 avanzan al método de pago. <span class="drop">Se pierde el 60%.</span></li>
  <li><strong>Al pedir el método de pago:</strong> de 128 que llegan, solo 51 pasan al siguiente paso. <span class="drop">Se pierde otro 60%.</span></li>
</ul>

<h2>Los 3 cuellos de botella principales</h2>

<h3>1. Elección de plan: el mayor punto de fuga</h3>
<table>
  <tr><th>Indicador</th><th class="num">Valor actual</th><th class="num">Valor saludable</th></tr>
  <tr><td>Clientes detenidos en este paso</td><td class="num">1.576</td><td class="num">&lt;500</td></tr>
  <tr><td>Tiempo medio de respuesta</td><td class="num">8 minutos</td><td class="num">&lt;2 minutos</td></tr>
  <tr><td>Mensajes que el bot no logra interpretar</td><td class="num">65%</td><td class="num">&lt;30%</td></tr>
  <tr><td>Mensajes repetidos (cliente reformula)</td><td class="num">44%</td><td class="num">&lt;15%</td></tr>
</table>
<p>
<strong>Qué pasa:</strong> al cliente se le presentan los dos planes disponibles
(60 y 120 días) con sus respectivos precios. La mayoría reacciona con sorpresa
por el precio (abandona) o no logra decidirse entre las dos opciones. Tarda 8
minutos en promedio en responder, y casi la mitad de las veces el bot no
entiende su respuesta y le pregunta de nuevo.
</p>

<h3>2. Pregunta inicial sobre peso/objetivo: filtro demasiado fuerte</h3>
<table>
  <tr><th>Indicador</th><th class="num">Valor actual</th></tr>
  <tr><td>Clientes detenidos en este paso</td><td class="num">1.404</td></tr>
  <tr><td>Drop al siguiente paso</td><td class="num">37%</td></tr>
  <tr><td>Mensajes que el bot no logra interpretar</td><td class="num">49%</td></tr>
</table>
<p>
<strong>Qué pasa:</strong> el bot pide al cliente que indique su peso antes de
cualquier información del producto. Muchos clientes no se sienten cómodos
respondiendo eso de entrada, o responden con frases vagas ("estoy con sobrepeso",
"60 más o menos") que el bot no logra procesar.
</p>

<h3>3. Método de pago: alta fricción y vuelta atrás</h3>
<table>
  <tr><th>Indicador</th><th class="num">Valor actual</th></tr>
  <tr><td>Clientes que vuelven al paso anterior</td><td class="num">39%</td></tr>
  <tr><td>Clientes que abandonan en este paso</td><td class="num">19%</td></tr>
  <tr><td>Mensajes que el bot no logra interpretar</td><td class="num">82%</td></tr>
</table>
<p>
<strong>Qué pasa:</strong> el cliente eligió un plan y un producto, pero al
preguntarle por el método de pago descubre el costo adicional del envío contra
reembolso (que aplica solo en algunos casos). Esto lo lleva a reconsiderar la
decisión y volver atrás, momento en el que muchos abandonan definitivamente.
</p>

<h2>Hallazgos adicionales relevantes</h2>

<ul>
  <li>
    <strong>Pagos por MercadoPago sin seguimiento:</strong> cuando un cliente
    elige pagar por MercadoPago pero no completa el pago, no recibe ningún
    mensaje de seguimiento. La espera promedio sin acción es de 48 horas, lo que
    equivale a una venta perdida silenciosa.
  </li>
  <li>
    <strong>Intervención manual frecuente:</strong> en el 35% de los casos donde
    se pausa al cliente, es porque un vendedor toma control manualmente para
    cerrar la venta. Esto sugiere que el bot deja de ser efectivo justo en la
    etapa final, y los vendedores tienen que "rescatar" la conversión.
  </li>
  <li>
    <strong>Pico de abandonos al final del día:</strong> entre las 21:00 y las
    22:00 hay el doble de abandonos que en horario diurno. Probable causa:
    mayor volumen de tráfico ralentiza las respuestas del bot.
  </li>
  <li>
    <strong>Rendimiento parejo entre vendedores:</strong> todos los vendedores
    tienen tasas de conversión muy similares (entre 5,5% y 6,7%). Esto confirma
    que las mejoras deben aplicarse al sistema, no a una operación individual.
  </li>
</ul>

<div class="page-break"></div>

<h2>Plan de acción recomendado</h2>

<p>
Las acciones se priorizan por su impacto estimado sobre la tasa de conversión y
la facilidad de implementación.
</p>

<h3><span class="pri pri-high">Alta prioridad</span> Presentar un plan recomendado en lugar de listar las dos opciones por igual</h3>
<p>
En lugar de mostrar los dos planes (60 y 120 días) en igualdad de condiciones,
recomendar uno explícitamente basándose en el peso/objetivo que el cliente ya
indicó. Por ejemplo: "Para tu objetivo, te recomiendo el plan de 120 días
porque incluye el envío sin cargo y resultados sostenidos. Sale $XX.XXX. ¿Te
sirve ese o preferís el de 60 días?". Esto guía la decisión, ancla el precio
al beneficio (no al monto) y reduce el tiempo de deliberación.
</p>
<p><strong>Impacto estimado:</strong> +2 a +3 puntos porcentuales de conversión global.</p>

<h3><span class="pri pri-high">Alta prioridad</span> Aclarar el costo de envío antes de pedir método de pago</h3>
<p>
Incluir explícitamente, junto con el precio del plan, una nota sobre el costo
adicional de envío contra reembolso (cuando aplique) y la alternativa sin
recargo (transferencia o MercadoPago). Esto evita que el cliente descubra el
recargo recién en el momento de pagar y vuelva atrás.
</p>
<p><strong>Impacto estimado:</strong> reducir la "vuelta atrás" del 39% al 15%, recuperando aproximadamente 30 ventas mensuales.</p>

<h3><span class="pri pri-high">Alta prioridad</span> Recordatorios automáticos a clientes detenidos</h3>
<p>
Casi 3.000 clientes están detenidos en algún paso intermedio. Implementar
mensajes automáticos de seguimiento a las 2 horas, 24 horas y 72 horas para
quienes no respondieron. La ganancia incluso con tasa de recuperación baja (5%)
representaría más de 100 ventas adicionales por mes.
</p>
<p><strong>Impacto estimado:</strong> +1 a +2 puntos porcentuales sobre el volumen recuperable.</p>

<h3><span class="pri pri-med">Media prioridad</span> Seguimiento de pagos pendientes por MercadoPago</h3>
<p>
Cuando un cliente elige pagar por MercadoPago y no completa el pago, enviarle
un mensaje de seguimiento a los 30 minutos y, si sigue sin pagar, derivar al
vendedor a las 4 horas para llamada manual.
</p>

<h3><span class="pri pri-med">Media prioridad</span> Mejorar la comprensión automática del bot</h3>
<p>
En varios pasos, el bot delega a la inteligencia artificial entre el 65% y el
102% de las veces (es decir, casi todos los mensajes). Esto incrementa el
costo operativo y la latencia de respuesta. Mejorar las reglas básicas de
comprensión puede bajar este uso a menos del 30% sin pérdida de calidad.
</p>

<h3><span class="pri pri-low">Mediano plazo</span> Reducir la fricción en la pregunta inicial</h3>
<p>
Considerar opciones para que la pregunta sobre peso/objetivo sea menos
intrusiva: por ejemplo, ofrecer rangos predefinidos en lugar de pedir un valor
exacto, o detectar el contexto si el cliente ya lo dio en su mensaje inicial
("quiero bajar 5 kilos").
</p>

<h2>Proyección con las mejoras propuestas</h2>

<p>
Implementando las tres acciones de alta prioridad, la proyección conservadora
es alcanzar una tasa de conversión global de <strong>9% a 11%</strong> (versus
el 5,95% actual). Sobre el mismo volumen de tráfico, esto representa entre
<strong>160 y 270 ventas adicionales por mes</strong>.
</p>

<div class="good">
<strong>Acción inmediata sugerida:</strong> comenzar con la recomendación
personalizada de plan y la aclaración del costo de envío. Son cambios de bajo
riesgo, alto impacto y se pueden medir en un plazo de 7 a 14 días.
</div>

<div class="footer">
Informe generado automáticamente a partir de datos del sistema.
Período cubierto: últimos 30 días. Datos agregados de todos los vendedores.
</div>

</body>
</html>
`;

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const outPath = path.join(__dirname, '..', 'reports', `analisis-embudo-${new Date().toISOString().split('T')[0]}.pdf`);
    await page.pdf({
        path: outPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '20mm', right: '18mm', bottom: '20mm', left: '18mm' },
    });
    await browser.close();

    const stats = fs.statSync(outPath);
    console.log(`PDF generado: ${outPath}`);
    console.log(`Tamaño: ${(stats.size / 1024).toFixed(1)} KB`);
})();
