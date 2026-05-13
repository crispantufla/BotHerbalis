/**
 * Genera un PDF ejecutivo con 5 sugerencias para empujar MercadoPago
 * por sobre contra reembolso en el flujo de pago.
 * Uso: node scripts/generate-mp-vs-cr-report.js
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
<title>Empujando MercadoPago sobre Contra Reembolso</title>
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
  .subtitle { color: #555; margin-bottom: 6px; font-size: 11pt; }
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

  .stats {
    display: flex;
    gap: 12px;
    margin: 14px 0 22px 0;
  }
  .stat {
    flex: 1;
    background: #fff;
    border: 1px solid #d4e5dc;
    border-radius: 6px;
    padding: 10px 12px;
    text-align: center;
  }
  .stat .num { font-size: 20pt; font-weight: 700; color: #0f5132; line-height: 1.1; }
  .stat .lbl { font-size: 8.5pt; color: #555; text-transform: uppercase; letter-spacing: 0.4px; margin-top: 4px; }

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

  .label-bold { font-weight: 600; color: #0f5132; }

  .copy {
    background: #f8fafb;
    border-left: 3px solid #0f5132;
    padding: 10px 14px;
    margin: 8px 0 10px 0;
    font-family: 'Courier New', monospace;
    font-size: 9.5pt;
    color: #1a1a1a;
    white-space: pre-line;
    border-radius: 3px;
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
</style>
</head>
<body>

<h1>Empujando MercadoPago sobre Contra Reembolso</h1>
<div class="subtitle">5 cambios concretos al flujo de pago</div>
<div class="meta">Informe ejecutivo · Bot Herbalis · ${today}</div>

<div class="intro">
<p style="margin: 0 0 8px 0;">
<strong>Por qué importa.</strong> El método de pago es uno de los dos cuellos de
botella más grandes del embudo: hasta el 49% de los clientes que llegan al paso
de elegir cómo pagar abandona o no completa la venta. Y de los que sí pagan,
los que eligen <strong>contra reembolso cancelan 9 veces más</strong> que los
que pagan con MercadoPago.
</p>
<p style="margin: 0;">
El 30 de abril ya desplegamos el reorden del menú (MP primero, contra reembolso
último) y el anclaje de cuotas. Este documento propone <strong>5 acciones
adicionales</strong> sobre el mismo paso, todas implementables en pocos días,
para amplificar el efecto antes del próximo informe automático del 7 de mayo.
</p>
</div>

<div class="stats">
  <div class="stat">
    <div class="num">9×</div>
    <div class="lbl">más cancelaciones de CR vs MP</div>
  </div>
  <div class="stat">
    <div class="num">49%</div>
    <div class="lbl">drop rate en el paso de pago</div>
  </div>
  <div class="stat">
    <div class="num">5</div>
    <div class="lbl">acciones propuestas</div>
  </div>
  <div class="stat">
    <div class="num">3-4</div>
    <div class="lbl">días para implementar las 4 primeras</div>
  </div>
</div>

<h2>Acciones propuestas</h2>

<div class="card">
  <div class="card-header">
    <div class="card-num">1</div>
    <div class="card-title">Mostrar la cuota mensual concreta, no solo "9 cuotas sin interés"</div>
    <span class="pri pri-high">Alto impacto</span>
  </div>
  <p>
    <span class="label-bold">Problema.</span> El cliente lee el total
    ($66.900) y se asusta. "9 cuotas sin interés" es abstracto y no ancla
    una expectativa concreta. El cerebro compara el total con la plata
    disponible hoy, no con lo que va a pagar por mes.
  </p>
  <p>
    <span class="label-bold">Cambio.</span> Calcular la cuota al renderizar
    el mensaje y mostrarla. Es el mismo patrón que ya aplicamos en plan 120
    ("$558 por día — un café"), pero ahora aplicado al método de pago.
  </p>
  <div class="copy">1️⃣ MercadoPago 💳 — desde $7.433/mes en 9 cuotas sin interés.
   Pagás con tarjeta, débito o saldo MP.
   Demora: 4 a 6 días hábiles 🚀</div>
  <p>
    <span class="label-bold">Hipótesis.</span> Una cuota baja desactiva la
    objeción de precio que empuja al cliente hacia contra reembolso ("no
    tengo $66.900 ahora, pago al cartero cuando lo tenga").
  </p>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">1 día</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Bajo</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">+5 a +8 pp de elección de MP</div></div>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-num">2</div>
    <div class="card-title">Hacer explícito el ahorro de elegir MP en plan 60</div>
    <span class="pri pri-high">Alto impacto</span>
  </div>
  <p>
    <span class="label-bold">Problema.</span> Hoy el adicional de contra
    reembolso se "bonifica" silenciosamente al elegir MP o transferencia.
    El cliente nunca ve el ahorro — solo lo vive como un cargo extra que
    suma contra reembolso. El framing actual es neutro.
  </p>
  <p>
    <span class="label-bold">Cambio.</span> Invertir el framing. Mostrar el
    delta como un descuento que se gana al elegir MP, no como un cargo que
    se evita en CR.
  </p>
  <div class="copy">1️⃣ MercadoPago 💳 — $XX.XXX (te ahorrás $Z eligiendo esta opción) 🎉
2️⃣ Transferencia — $XX.XXX (también sin recargo)
3️⃣ Contra reembolso — $XX.XXX + $Z de adicional</div>
  <p>
    <span class="label-bold">Por qué funciona.</span> Aversión a la pérdida.
    "Elegir contra reembolso me cuesta $Z más" pesa más en la decisión que
    "MP no tiene recargo". Es el mismo dato presentado desde el otro lado.
  </p>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">0,5 día</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Bajo</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">+3 a +5 pp en plan 60</div></div>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-num">3</div>
    <div class="card-title">Atacar la objeción de confianza preventivamente</div>
    <span class="pri pri-med">Impacto medio</span>
  </div>
  <p>
    <span class="label-bold">Problema.</span> La razón principal por la que
    los clientes argentinos eligen contra reembolso es desconfianza: no
    quieren pagar antes de tener el producto en la mano. Hoy el bot no
    aborda esta objeción — espera a que el cliente la verbalice, y la
    mayoría no la verbaliza, simplemente elige CR.
  </p>
  <p>
    <span class="label-bold">Cambio.</span> Sumar una línea breve sobre la
    protección al comprador de MercadoPago, que es real y resuelve la
    objeción mental antes de que aparezca.
  </p>
  <div class="copy">1️⃣ MercadoPago 💳 — desde $7.433/mes en 9 cuotas sin interés.
   🛡️ Protección al comprador: si no recibís el producto, te devuelven el 100%.
   Demora: 4 a 6 días hábiles 🚀</div>
  <p>
    <span class="label-bold">Por qué funciona.</span> El cliente que elegía
    CR por desconfianza ahora tiene una razón concreta para confiar en MP.
    Una sola línea, riesgo cero, beneficio probable.
  </p>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">1 hora</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Bajo</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">+2 a +3 pp de elección de MP</div></div>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-num">4</div>
    <div class="card-title">Recomendación explícita en lugar de menú neutro</div>
    <span class="pri pri-high">Alto impacto</span>
  </div>
  <p>
    <span class="label-bold">Problema.</span> Presentar 3 opciones planas
    invita a comparar. Cuando el cliente compara, contra reembolso parece
    "lo seguro" porque no requiere pagar antes. La inteligencia artificial
    interna ya tiene la directiva de empujar MP, pero el copy del menú no
    refleja esa recomendación: es completamente neutro.
  </p>
  <p>
    <span class="label-bold">Cambio.</span> Arrancar con una recomendación,
    no con un menú. Las otras opciones siguen disponibles pero como
    alternativa, no como pares.
  </p>
  <div class="copy">¡Perfecto! 😊 Para el pago, te recomiendo MercadoPago — 9 cuotas sin
interés desde $7.433/mes y llega 3-4 días antes. ¿Avanzamos con ese?

Si preferís otra forma:
  ▸ Transferencia bancaria (sin recargos)
  ▸ Contra reembolso ($Z de adicional, demora 7-10 días)</div>
  <p>
    <span class="label-bold">Por qué funciona.</span> El cliente que iba a
    elegir CR por inercia ahora tiene que elegirlo activamente contra una
    recomendación. La fricción cambia de lado.
  </p>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">1 día</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Bajo</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">+5 a +10 pp de elección de MP</div></div>
  </div>
</div>

<div class="card">
  <div class="card-header">
    <div class="card-num">5</div>
    <div class="card-title">Last-mile retry cuando el cliente elige contra reembolso</div>
    <span class="pri pri-med">Impacto medio</span>
  </div>
  <p>
    <span class="label-bold">Problema.</span> Hoy, una vez que el cliente
    dice "contra reembolso", el bot lo acepta y avanza. No hay segundo
    intento. Algunos clientes eligen CR por reflejo y nunca consideraron
    activamente las alternativas.
  </p>
  <p>
    <span class="label-bold">Cambio.</span> Insertar un único mensaje
    suave antes de avanzar (solo cuando hay adicional, o sea plan 60). No
    insistir más de una vez.
  </p>
  <div class="copy">Dale, contra reembolso 👍

Antes de cerrar, capaz te conviene saber: con MP en 9 cuotas son $7.433/mes,
no pagás el adicional de $Z y llega 3-4 días antes.

¿Confirmás contra reembolso o lo cambiamos a MP?</div>
  <p>
    <span class="label-bold">Por qué funciona.</span> Recupera al subset de
    clientes que eligieron CR sin pensar. Costo: 1 mensaje extra. Si
    confirma, avanza sin fricción adicional.
  </p>
  <div class="meta-row">
    <div class="item"><div class="label">Esfuerzo</div><div class="value">1,5 días</div></div>
    <div class="item"><div class="label">Riesgo</div><div class="value">Bajo a medio</div></div>
    <div class="item"><div class="label">Impacto estimado</div><div class="value">+2 a +4 pp de migración CR → MP</div></div>
  </div>
</div>

<h2>Recomendación de implementación</h2>

<div class="highlight">
<p style="margin: 0 0 8px 0;">
<strong>Por dónde empezar.</strong> Las acciones <strong>1, 2, 3 y 4</strong>
viven todas en el mismo archivo del flujo de pago, son cambios de copy + un
cálculo simple, y se pueden agrupar en un único PR de <strong>2 a 3 días</strong>
de trabajo. Riesgo bajo, sin cambios de schema ni dependencias nuevas.
</p>
<p style="margin: 0;">
La acción <strong>5</strong> requiere un sub-paso nuevo en la máquina de
estados y conviene dejarla para una segunda iteración, después de medir el
efecto de las primeras cuatro con el informe automático del <strong>7 de
mayo</strong>.
</p>
</div>

<p>
<strong>Proyección conservadora</strong> sumando las cuatro primeras acciones:
una migración del 15% al 25% del tráfico actual de contra reembolso hacia
MercadoPago. Eso impacta directamente la tasa de cancelaciones (CR cancela 9×
más que MP) y la velocidad de entrega (4-6 días vs 7-10 días), reduciendo
también los reclamos de seguimiento que hoy ocupan tiempo del equipo.
</p>

<p>
<strong>Cómo medirlo.</strong> El informe automático del 7 de mayo ya está
agendado para comparar el funnel del 19-25 de abril (baseline pre-cambios)
contra el 30 de abril - 6 de mayo (post-cambios). Si las acciones 1 a 4 se
despliegan antes del 4 de mayo, el mismo informe captará su efecto.
</p>

<div class="footer">
Documento ejecutivo · Bot Herbalis · ${today} · Próxima revisión automática: 07/05/2026
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

    const reportsDir = path.join(__dirname, '..', 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    const outPath = path.join(reportsDir, `MP-vs-CR-sugerencias-${new Date().toISOString().split('T')[0]}.pdf`);
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
