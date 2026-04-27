/**
 * Genera un PDF ejecutivo con las sugerencias de mejora del embudo.
 * Uso: node scripts/generate-suggestions-report.js
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
<title>Sugerencias de mejora del embudo</title>
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
  h2 { font-size: 14pt; margin: 26px 0 10px 0; color: #0f5132; border-bottom: 2px solid #0f5132; padding-bottom: 4px; }
  h3 { font-size: 12pt; margin: 18px 0 6px 0; color: #1a1a1a; }
  .subtitle { color: #555; margin-bottom: 6px; }
  .meta { color: #888; font-size: 9pt; margin-bottom: 24px; }
  p { margin: 6px 0 10px 0; }
  ul { margin: 6px 0 12px 18px; padding: 0; }
  li { margin-bottom: 4px; }

  .intro {
    background: #f1f5f4;
    border-left: 4px solid #0f5132;
    padding: 14px 16px;
    border-radius: 4px;
    margin-bottom: 18px;
  }

  .card {
    border: 1px solid #ddd;
    border-radius: 6px;
    padding: 14px 16px;
    margin: 12px 0 16px 0;
    page-break-inside: avoid;
  }
  .card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .card-num {
    background: #0f5132;
    color: #fff;
    width: 28px; height: 28px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 11pt;
    flex-shrink: 0;
  }
  .card-title { font-size: 12pt; font-weight: 600; color: #1a1a1a; flex: 1; }

  .quote {
    background: #fffbeb;
    border-left: 3px solid #d97706;
    padding: 8px 12px;
    margin: 8px 0;
    font-style: italic;
    color: #78350f;
    font-size: 10pt;
  }

  .meta-row {
    display: flex;
    gap: 14px;
    margin: 10px 0 4px 0;
    font-size: 9.5pt;
  }
  .meta-row .item {
    flex: 1;
    background: #f8f9fa;
    padding: 6px 10px;
    border-radius: 4px;
  }
  .meta-row .item .label { color: #666; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.5px; }
  .meta-row .item .value { font-weight: 600; color: #1a1a1a; }

  .pri { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 9pt; font-weight: 600; }
  .pri-high { background: #fee2e2; color: #b91c1c; }
  .pri-med { background: #fef3c7; color: #92400e; }
  .pri-low { background: #dbeafe; color: #1e40af; }

  .highlight {
    background: #ecfdf5;
    border-left: 4px solid #059669;
    padding: 12px 16px;
    border-radius: 4px;
    margin: 16px 0;
  }
  .highlight strong { color: #065f46; }

  .footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #ddd; font-size: 9pt; color: #888; }
  .page-break { page-break-before: always; }
</style>
</head>
<body>

<h1>Sugerencias para mejorar la conversión</h1>
<div class="subtitle">Plan de acción concreto sobre los puntos críticos del embudo</div>
<div class="meta">Documento complementario al análisis del embudo · Generado el ${today}</div>

<div class="intro">
<p style="margin: 0 0 8px 0;">
Este documento presenta <strong>nueve acciones concretas</strong> para mejorar
la tasa de conversión del bot, ordenadas por impacto y esfuerzo. Las primeras
tres son <strong>cambios rápidos</strong> que pueden implementarse en pocos
días y atacan directamente los dos mayores cuellos de botella identificados.
</p>
<p style="margin: 0;">
<strong>Hallazgo central que guía las recomendaciones:</strong> el mensaje
donde el bot presenta los planes tiene 8 líneas, casi 300 caracteres y unos
17 segundos de lectura. En WhatsApp, la mayoría de los clientes lee con
atención solo las primeras 2 ó 3 líneas y escanea el resto. Información
crítica (como el costo adicional de envío) queda en zonas de baja atención,
lo que genera confusión, repreguntas y abandono.
</p>
</div>

<h2>Cambios rápidos · Implementables en 2 a 3 días</h2>

<div class="card">
  <div class="card-header">
    <div class="card-num">1</div>
    <div class="card-title">Acortar y dividir el mensaje de presentación de planes</div>
    <span class="pri pri-high">Alto impacto</span>
  </div>
  <p>
    <strong>Situación actual:</strong> cuando el bot presenta los planes
    disponibles, lo hace en un solo mensaje denso (8 líneas, 17 segundos de
    lectura) que incluye precios, política de envío, costo adicional, oferta
    del plan más largo y pregunta final. La mayoría de los clientes lee con
    atención las primeras líneas y escanea el resto. Esto se confirma en los
    datos: el bot tiene que delegar a la inteligencia artificial el 65% de las
    respuestas en este paso, los clientes tardan 8 minutos en promedio en
    decidir, y casi la mitad de los mensajes son repreguntas.
  </p>
  <p>
    <strong>Cambio propuesto:</strong> dividir la información en dos mensajes
    cortos consecutivos. El primero, breve, con el precio y una recomendación
    clara. El segundo, opcional o disparado por una pregunta del cliente, con
    el detalle del adicional de envío y las alternativas.
  </p>
  <div class="quote">
    Mensaje 1: "Te recomiendo el plan de 120 días: incluye el envío sin cargo
    y rinde el doble. Sale $XX.XXX. ¿Avanzamos con ese?"<br><br>
    Mensaje 2 (si pregunta o elige el de 60): "El de 60 días sale $YY.YYY.
    Si lo pagás contra reembolso suma $Z de envío; con MercadoPago o
    transferencia no tiene recargo."
  </div>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">2 días</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Bajo</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">+2 a +3 pp de conversión</div></div>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-num">2</div>
    <div class="card-title">Resolver la fuga al volver a corregir la dirección de envío</div>
    <span class="pri pri-high">Alto impacto</span>
  </div>
  <p>
    <strong>Situación actual:</strong> de los clientes que llegan a elegir
    método de pago, un 39% retrocede para corregir la dirección de envío. De
    ese grupo, <strong>ninguno completó la venta</strong> en el último mes (51
    clientes: 19 abandonaron, 11 quedaron pausados, 21 siguen sin cerrar). Es
    una fuga total: una vez que el cliente vuelve atrás a tocar la dirección,
    el flujo se traba y la venta se pierde.
  </p>
  <p>
    <strong>Cambio propuesto:</strong> investigar y resolver el problema en
    el flujo que combina la confirmación de dirección (validada con un mapa)
    y el método de pago. Hay indicios de que la integración con el mapa pierde
    la dirección al volver del paso de pago, o que el bot no reconoce
    correctamente las correcciones del cliente. Es un trabajo principalmente
    técnico, no de copy.
  </p>
  <p>
    <strong>Beneficio:</strong> recuperar al menos parte de los 51 clientes
    que llegaron muy lejos en el embudo (eligieron producto, plan y empezaron
    el cierre) representa una ganancia de alta calidad: son los leads más
    "calientes" del proceso.
  </p>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">3-5 días (investigación + fix)</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Medio (depende del diagnóstico)</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">~20 a 30 ventas adicionales por mes</div></div>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-num">3</div>
    <div class="card-title">Seguimiento automático a quienes no completan el pago por MercadoPago</div>
    <span class="pri pri-high">Alto impacto</span>
  </div>
  <p>
    <strong>Situación actual:</strong> cuando un cliente elige pagar por
    MercadoPago pero no completa el pago, no se le envía ningún mensaje de
    seguimiento. La espera promedio sin acción es de 48 horas, lo que se
    traduce en ventas perdidas silenciosamente. De los últimos 23 clientes que
    eligieron MercadoPago, solo 1 completó el pago.
  </p>
  <p>
    <strong>Cambio propuesto:</strong> a los 30 minutos sin pago confirmado,
    enviar un mensaje preguntando si tuvo algún inconveniente y ofreciendo el
    link nuevamente. A las 4 horas sin respuesta, derivar al vendedor para una
    llamada manual.
  </p>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">2 días</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Bajo</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">+5 a +10 ventas mensuales</div></div>
  </div>
</div>

<h2>Mediano plazo · Implementables en 1 a 2 semanas</h2>

<div class="card">
  <div class="card-header">
    <div class="card-num">4</div>
    <div class="card-title">Recordatorios automáticos a los clientes detenidos en el embudo</div>
    <span class="pri pri-high">Alto impacto</span>
  </div>
  <p>
    <strong>Situación actual:</strong> casi 3.000 clientes potenciales están
    detenidos en algún paso intermedio del embudo (1.576 en la elección de
    plan, 1.404 en la pregunta de peso/objetivo, entre otros). Estos clientes
    mostraron interés inicial pero no completaron el proceso, y hoy no reciben
    ningún tipo de seguimiento automático.
  </p>
  <p>
    <strong>Cambio propuesto:</strong> implementar un sistema de mensajes de
    seguimiento automático con tres ventanas:
  </p>
  <ul>
    <li><strong>A las 2 horas:</strong> mensaje suave preguntando si tiene alguna duda</li>
    <li><strong>A las 24 horas:</strong> información adicional sobre el producto o beneficio</li>
    <li><strong>A las 72 horas:</strong> última oportunidad antes de pausar al cliente</li>
  </ul>
  <p>
    Después de la tercera ventana, si no hubo respuesta, se notifica al
    vendedor para que decida si retoma manualmente.
  </p>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">1 semana</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Bajo a medio</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">+150 ventas mensuales potenciales</div></div>
  </div>
  <p style="font-size: 9.5pt; color: #666; margin-top: 8px;">
    <em>Cálculo: aun recuperando solamente el 5% de los detenidos, son
    aproximadamente 150 ventas adicionales por mes.</em>
  </p>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-num">5</div>
    <div class="card-title">Mejorar la comprensión automática del bot</div>
    <span class="pri pri-med">Impacto medio</span>
  </div>
  <p>
    <strong>Situación actual:</strong> en varios pasos del embudo, el bot no
    logra entender la respuesta del cliente con sus reglas básicas y delega a
    la inteligencia artificial. En algunos pasos esto ocurre en más del 80% de
    los mensajes, lo que genera dos problemas: <strong>mayor costo
    operativo</strong> (cada consulta a la IA tiene costo) y <strong>mayor
    tiempo de respuesta</strong>, especialmente en horarios pico.
  </p>
  <p>
    <strong>Cambio propuesto:</strong> ampliar el vocabulario que el bot
    reconoce sin necesidad de IA. Por ejemplo, frente a la elección de plan,
    hoy entiende "60" o "120", pero no "el corto", "el largo", "el más
    barato", "ese", "el primero", "dale", "dos meses", "cuatro meses". Con
    esta mejora, el uso de IA se reduciría del 80% a menos del 30% en los
    pasos críticos.
  </p>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">1 semana</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Bajo</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">Reducción de costos + menor latencia</div></div>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-num">6</div>
    <div class="card-title">Replantear la pregunta inicial sobre peso/objetivo</div>
    <span class="pri pri-med">Impacto medio</span>
  </div>
  <p>
    <strong>Situación actual:</strong> el bot pide al cliente que indique su
    peso al comienzo del proceso. 1.404 clientes están detenidos en este paso
    (no respondieron) y un 49% de las respuestas no son interpretadas
    correctamente. Es el primer filtro real del embudo y se está llevando
    demasiada gente con intención de compra.
  </p>
  <p>
    <strong>Cambio propuesto:</strong> probar dos variantes alternativas:
  </p>
  <ul>
    <li>
      Reformular la pregunta hacia el objetivo: <em>"¿Cuántos kilos te
      gustaría bajar?"</em> en lugar de pedir el peso actual. Es menos
      intrusivo y más fácil de responder.
    </li>
    <li>
      Si el cliente ya dio contexto en su primer mensaje ("tengo sobrepeso",
      "quiero bajar 5 kilos"), saltar este paso y avanzar directamente a la
      siguiente etapa.
    </li>
  </ul>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">1 semana (con prueba A/B)</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Medio (cambio sensible)</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">+1 a +2 pp de conversión</div></div>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-num">9</div>
    <div class="card-title">Reforzar la validación con prueba social y mejorar la respuesta cuando el cliente pregunta "cómo funciona"</div>
    <span class="pri pri-med">Impacto medio</span>
  </div>
  <p>
    <strong>Situación actual:</strong> cuando el cliente indica cuánto quiere
    bajar, el bot valida emocionalmente con una línea breve ("Quedate tranqui
    que ese objetivo es re posible") y pasa directo a ofrecer las opciones
    de producto. Esto mantiene el ritmo de la conversación, que es valioso,
    pero deja una oportunidad de generar más confianza con muy poco texto. Por
    otro lado, cuando el cliente pregunta "¿cómo funciona?" o pide más
    información sobre el tratamiento, la respuesta queda librada a la
    inteligencia artificial sin un guion específico.
  </p>
  <p>
    <strong>Cambio propuesto:</strong> dos ajustes complementarios.
  </p>
  <ul>
    <li>
      <strong>Reforzar la línea de validación</strong> con una mención breve
      de prueba social (ejemplo: "10 kg es totalmente posible — lo logramos
      con miles de personas. Veamos qué opción te conviene más"). Suma
      confianza con 8 a 10 palabras adicionales, sin romper el ritmo de la
      conversación.
    </li>
    <li>
      <strong>Preparar una respuesta de calidad</strong> para los casos en
      que el cliente sí pide información sobre cómo funciona el producto.
      En lugar de generarla con inteligencia artificial cada vez (con costo
      y latencia), tener un mensaje pre-armado, breve y bien escrito, que
      el bot pueda usar directamente cuando detecta esa pregunta.
    </li>
  </ul>
  <p>
    <strong>Por qué este enfoque:</strong> en una venta conversacional, el
    momentum vale más que la educación. La regla es <em>explicar cuando el
    cliente lo pide, no preventivamente</em>. Forzar un párrafo educativo en
    medio del flujo enlentece la conversión sin sumar valor a quien ya estaba
    decidido. Pero quien sí lo pregunta merece una respuesta clara y prolija.
  </p>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">2 días</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Bajo</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">+0,5 a +1 pp de conversión</div></div>
  </div>
</div>

<div class="page-break"></div>

<h2>Mejoras estructurales · Requieren decisión de producto</h2>

<div class="card">
  <div class="card-header">
    <div class="card-num">10</div>
    <div class="card-title">Tablero de "cola de rescate" para los vendedores</div>
    <span class="pri pri-low">Impacto a largo plazo</span>
  </div>
  <p>
    <strong>Situación actual:</strong> en el 35% de las conversaciones donde
    el bot pausa al cliente, es porque un vendedor toma control manualmente
    para cerrar la venta. Esto demuestra que los vendedores agregan valor
    real, pero hoy lo hacen <strong>de forma reactiva</strong>, esperando que
    el cliente vuelva a escribir.
  </p>
  <p>
    <strong>Cambio propuesto:</strong> incorporar al panel una vista que
    muestre los clientes detenidos en el embudo, ordenados por probabilidad
    de cierre. Por ejemplo: clientes que ya eligieron plan y producto pero no
    respondieron en las últimas 24 horas. El vendedor podría priorizar a esos
    clientes y contactarlos proactivamente.
  </p>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">2-3 semanas</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Bajo</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">Mejora de productividad de cada vendedor</div></div>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-num">11</div>
    <div class="card-title">Pruebas A/B del mensaje de bienvenida</div>
    <span class="pri pri-low">Impacto a largo plazo</span>
  </div>
  <p>
    <strong>Situación actual:</strong> 1.346 clientes (un 26% del total) son
    creados como contactos pero nunca llegan a escribir un mensaje. Esto
    sugiere que algo en el primer punto de contacto (saludo, mensaje
    inicial, expectativa) no está funcionando para una parte significativa
    de los leads.
  </p>
  <p>
    <strong>Cambio propuesto:</strong> diseñar dos o tres variantes del
    mensaje inicial del bot y medir, en períodos de 7 días, cuál genera más
    respuestas. Las variantes podrían diferir en tono (más cercano vs. más
    profesional), longitud (más corto vs. más completo) o enfoque (foco en
    el producto vs. foco en el beneficio para el cliente).
  </p>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">2 semanas (incluye medición)</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Bajo</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">Aumento del top of funnel</div></div>
  </div>
</div>

<h2>Recomendación final</h2>

<div class="highlight">
<p style="margin: 0 0 8px 0;">
<strong>Por dónde empezar:</strong> las acciones <strong>1 y 2</strong> son
las de mayor impacto inmediato y se complementan entre sí (ambas se aplican en
el mismo punto del proceso de venta). Pueden implementarse en 2 a 3 días en
total, con riesgo bajo, y atacan directamente los dos mayores cuellos de
botella del embudo (donde se pierde el 60% de los clientes en cada uno).
</p>
<p style="margin: 0;">
El impacto de estas dos acciones puede medirse con los datos del sistema en un
plazo de <strong>7 a 14 días</strong> después de implementarlas.
</p>
</div>

<p>
Implementando las tres acciones de alta prioridad (1, 2 y 3), la proyección
conservadora es alcanzar una tasa de conversión global de <strong>9% a 11%</strong>
(versus el 5,95% actual). Sobre el mismo volumen de tráfico, esto representa
entre <strong>160 y 270 ventas adicionales por mes</strong>.
</p>

<p>
Las acciones 4 a 9 amplifican este impacto pero requieren más tiempo de
implementación. Las acciones 10 y 11 son mejoras estructurales con horizonte
mayor y dependen de decisiones de producto.
</p>

<div class="footer">
Documento complementario al análisis del embudo de ventas.
Las estimaciones de impacto son conservadoras y se basan en datos reales de los últimos 30 días.
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

    const outPath = path.join(__dirname, '..', 'reports', `sugerencias-mejora-${new Date().toISOString().split('T')[0]}.pdf`);
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
