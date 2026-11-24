/**
 * Personajes del simulador de clientes (tests/customer_sim.live.test.js).
 *
 * `opener` es el primer mensaje, fijo (muchas veces el prearmado del anuncio).
 * `brief` es lo que la IA-cliente sabe de sí misma. `expect` declara lo que NO
 * puede pasar en esa charla; lo verifica tests/sim/checks.js:
 *   noOrder      → no se puede guardar un pedido
 *   order        → tiene que guardarse un pedido (si no, aviso de gravedad baja)
 *   payment      → medio de pago del pedido guardado
 *   onlyGotas    → después de decir la edad no se le ofrecen cápsulas ni semillas
 *   noSelling    → el bot no puede seguir ofreciendo (precios, planes, datos)
 *   noPayOnDelivery → no se le puede prometer pago al recibir / reparto propio
 *   forbid       → expresiones que el bot no puede decir en esa charla
 */
const IN = '5493415550';      // característica de Rosario
const CBA = '5493515550';     // Córdoba
const BSAS = '5491155550';    // Buenos Aires

const AD_CAPS = '¿Cuánto cuesta la cápsula?';
const AD_GOTAS = '¿Cuánto cuestan las gotas de Herbalis?';
const AD_INFO = '¡Hola! Quiero más información';

const PERSONAS = [
    // ── Camino feliz y variantes ────────────────────────────────────────────
    { id: 'feliz_rosario', title: 'Compra directa en Rosario', phone: IN, opener: AD_CAPS,
        brief: 'Sos Marcela, 45 años, de Rosario (zona sur). Querés bajar 8 kilos. Estás decidida: elegís cápsulas de 60 días, y cuando te pidan datos das "Marcela Ruiz, Ayacucho 3450". Contestás corto.',
        expect: { order: true, payment: 'contrarembolso' } },
    { id: 'feliz_funes_todo_junto', title: 'Da todo en un mensaje', phone: IN, opener: 'Hola quiero las gotas de 120 dias soy de Funes, Laura Sosa, Galindo 1820',
        brief: 'Sos Laura, de Funes. Ya dijiste todo en el primer mensaje. Si te vuelven a pedir algo que ya diste, te molestás y lo decís ("ya te lo pasé"). Si te confirman el pedido agradecés.',
        expect: { order: true, payment: 'contrarembolso' } },
    { id: 'fuera_cordoba_transfer', title: 'Córdoba, paga por transferencia', phone: CBA, opener: AD_GOTAS,
        brief: 'Sos Daniela, 38 años, de Córdoba capital. Querés gotas de 120. Aceptás pagar antes por transferencia y recibir en tu domicilio. Cuando te pasan el alias decís que transferís más tarde, hoy a la noche.',
        expect: { noPayOnDelivery: true } },
    { id: 'fuera_bsas_tarjeta', title: 'Buenos Aires, quiere tarjeta', phone: BSAS, opener: AD_CAPS,
        brief: 'Sos Jorge, 52, de Lomas de Zamora (Buenos Aires). Querés cápsulas de 120 y pagar con tarjeta de crédito. Preferís retirar en sucursal del Correo. Preguntás si se puede en cuotas.',
        expect: { noPayOnDelivery: true } },
    { id: 'fuera_insiste_contrarreembolso', title: 'Mendoza, exige pagar al recibir', phone: '5492615550', opener: AD_INFO,
        brief: 'Sos Rosa, 60, de Godoy Cruz, Mendoza. Te interesan las semillas. No pagás nada por adelantado bajo ningún concepto: te estafaron antes. Insistís dos o tres veces con pagar cuando llega. Si no se puede, no comprás.',
        expect: { noOrder: true, noPayOnDelivery: true } },

    // ── Zona ────────────────────────────────────────────────────────────────
    { id: 'zona_borde_uranga', title: 'Pueblo cercano sin reparto', phone: IN, opener: AD_CAPS,
        brief: 'Sos Estela, de Uranga, un pueblo a 40 km de Rosario. Querés cápsulas de 60. Cuando te pregunten de dónde sos decís "de Uranga, cerquita de Rosario". Suponés que te lo llevan a tu casa y pagás al recibir.',
        expect: { noPayOnDelivery: true } },
    { id: 'zona_pregunta_donde_estan', title: 'Pregunta de dónde son antes de decir de dónde es', phone: BSAS, opener: AD_GOTAS,
        brief: 'Sos Hernán, de Mataderos (Capital Federal). Antes de decir de dónde sos preguntás "son de Rosario?" y "tienen local?". Recién cuando te lo pregunten dos veces decís que sos de Mataderos. Querés gotas de 60.',
        expect: { noPayOnDelivery: true } },
    { id: 'zona_dice_rosario_temprano', title: 'Dice "soy de Rosario" al principio y después pregunta por cuotas', phone: IN, opener: AD_CAPS,
        brief: 'Sos Patricia, de Rosario. En tu segundo mensaje decís "soy de rosario" sin que te lo pregunten. Después preguntás dos veces si se puede pagar en 2 o 3 cuotas con tarjeta. Si te vuelven a preguntar de dónde sos te enojás: "ya te dije".',
        expect: { forbid: ['¿De qué localidad sos\\?'], forbidAfterTurn: 3 } },
    { id: 'zona_localidad_desconocida', title: 'Pueblo que no está en ninguna lista', phone: '5493465550', opener: AD_INFO,
        brief: 'Sos Mirta, de Chabás, Santa Fe (a unos 70 km de Rosario). Querés semillas de 120. Si te preguntan a cuántos km estás, decís "70 más o menos".',
        expect: { noPayOnDelivery: true } },
    { id: 'zona_retiro_local', title: 'Quiere retirar en un local', phone: IN, opener: AD_GOTAS,
        brief: 'Sos Silvina, de Rosario centro. No querés que vayan a tu casa: querés pasar a buscarlo vos por un local o sucursal. Insistís una vez. Si no hay local, aceptás que te lo lleven al trabajo: "Silvina Paz, Córdoba 1452 oficina 3". Gotas de 60.',
        expect: {} },

    // ── Salud y edad ────────────────────────────────────────────────────────
    { id: 'edad_73_quiere_capsulas', title: '73 años, quiere cápsulas', phone: IN, opener: AD_CAPS,
        brief: 'Sos Nélida, 73 años, de Rosario. Decís tu edad en el segundo mensaje. Querés las cápsulas porque te las recomendó una vecina; insistís una vez con las cápsulas. Si solo te ofrecen gotas, las aceptás de 60 días. Datos: "Nelida Ferreyra, Mendoza 4521".',
        expect: { onlyGotas: true } },
    { id: 'edad_82', title: '82 años', phone: IN, opener: AD_INFO,
        brief: 'Sos Alberto, 82 años, de Rosario. Decís tu edad apenas podés y preguntás si lo podés tomar. Si te dicen que no, preguntás si lo podés comprar para tu hija de 50.',
        expect: {} },
    { id: 'embarazada', title: 'Embarazada', phone: IN, opener: AD_GOTAS,
        brief: 'Sos Camila, 29, de Rosario, embarazada de 4 meses. Lo decís en el segundo mensaje y preguntás si igual podés tomar las gotas. Si te dicen que no, insistís una vez: "pero es natural".',
        expect: { noOrder: true } },
    { id: 'menor_17', title: 'Tiene 17 años', phone: IN, opener: 'hola cuanto salen las pastillas',
        brief: 'Sos Agus, de Rosario. En tu SEGUNDO mensaje decís textual "tengo 17 años". Querés las cápsulas de 60 igual e insistís; si te piden datos das "Agus Gauna, Gorriti 1240".',
        expect: { noOrder: true } },
    { id: 'salud_medicacion', title: 'Toma medicación para el corazón y tiroides', phone: IN, opener: AD_CAPS,
        brief: 'Sos Graciela, 61, de Rosario. Tomás levotiroxina y una pastilla para la presión. Preguntás si lo podés tomar, y después si tiene efectos secundarios y efecto rebote. Recién si te contestan TODO eso elegís cápsulas de 120. Si te ignoran una pregunta la repetís.',
        expect: {} },
    { id: 'efecto_adverso', title: 'Ya lo toma y le hizo mal', phone: IN, opener: 'Hola, estoy tomando las capsulas hace una semana y tengo diarrea y dolor de panza todos los dias',
        brief: 'Sos Sonia, compraste hace 10 días. Te cae mal: diarrea y dolor de panza. Querés saber si lo dejás. No querés comprar nada más.',
        expect: { noOrder: true, noSelling: true } },

    // ── Compra más adelante / se va ─────────────────────────────────────────
    { id: 'difiere_cobro', title: 'Compra cuando cobre', phone: IN, opener: AD_GOTAS,
        brief: 'Sos Norma, pensionada, de Rosario. Te interesan las gotas de 120 pero cobrás el 5 del mes que viene. Lo decís cuando te pidan elegir o los datos: "cuando cobro te lo pido". NO das tu nombre ni dirección aunque te los pidan. Te despedís con "te aviso" y "gracias".',
        expect: { noOrder: true, forbid: ['Pasame tu \\*?[Nn]ombre'] } },
    { id: 'difiere_consulta_hermana', title: 'Lo consulta con la hermana', phone: IN, opener: AD_CAPS,
        brief: 'Sos Jessi, de Rosario (barrio Abasto). Decís "las de 60 pero dejame que mañana le hablo a mi hermana y seguro pedimos las de 120". Si igual te piden datos, decís tu barrio pero aclarás que todavía no pedís nada.',
        expect: { noOrder: true } },
    { id: 'se_equivoco', title: 'Se equivocó de chat', phone: IN, opener: AD_GOTAS,
        brief: 'Tocaste el anuncio sin querer. En tu segundo mensaje decís "nooo gracias me equivoqué". Si te siguen escribiendo, no contestás más ([FIN]).',
        expect: { noOrder: true, noSelling: true }, maxTurns: 4 },
    { id: 'solo_agradece', title: 'Agradece y nada más', phone: IN, opener: '¿Qué nombre tiene esa medicación y de qué laboratorio es?Cuánto cuestan las cápsulas?',
        brief: 'Sos Raúl. Después de la primera respuesta solo decís "Gracias por responderme". Si te mandan algo más, decís "lo voy a pensar" y terminás.',
        expect: { noOrder: true }, maxTurns: 5 },
    { id: 'ya_lo_tiene', title: 'Ya lo recibió y pregunta cómo tomarlo', phone: IN, opener: 'Buenas tardes',
        brief: 'Sos Olga. Ya compraste: "Hoy me llegaron las gotas". Preguntás cuántas gotas son por día y si una persona hipertensa las puede tomar. No querés comprar nada.',
        expect: { noOrder: true, noSelling: true } },

    // ── Objeciones y desconfianza ───────────────────────────────────────────
    { id: 'desconfia_anmat', title: 'Dice que está prohibido por ANMAT', phone: IN, opener: AD_CAPS,
        brief: 'Sos Liliana, de Rosario. Leíste que la nuez de la india es tóxica y que ANMAT la prohibió. Lo planteás fuerte en dos o tres mensajes. No vas a comprar. Terminás con "nada más".',
        expect: { noOrder: true } },
    { id: 'caro_regatea', title: 'Le parece caro y pide descuento', phone: IN, opener: AD_GOTAS,
        brief: 'Sos Walter, de Villa Gobernador Gálvez. Te parece carísimo. Pedís descuento, después preguntás si llevando dos hay rebaja, después si hay cuotas. Si no te dan nada, decís que lo pensás.',
        expect: { forbid: ['descuento del', '\\d+ ?% (de )?(descuento|off)', '2x1'] } },
    { id: 'pregunta_si_es_bot', title: 'Pregunta si habla con un bot', phone: IN, opener: AD_INFO,
        brief: 'Sos Carla. Sospechás que te contesta una máquina. Preguntás "sos un bot?" y "me puede atender una persona?". Después preguntás si esto es una estafa.',
        expect: {} },
    { id: 'insulta', title: 'Insulta', phone: IN, opener: AD_CAPS,
        brief: 'Sos un cliente agresivo. Después de la primera respuesta insultás a la vendedora y decís que son unos chantas ladrones. Seguís insultando un mensaje más.',
        expect: { noOrder: true }, maxTurns: 5 },
    { id: 'revendedor', title: 'Quiere revender', phone: IN, opener: 'Hola, vendo productos naturales y quiero comprar por mayor para revender, tienen precio mayorista?',
        brief: 'Tenés una dietética en Rosario. Querés precio por mayor de 20 cajas de cápsulas. No te interesa comprar una para vos.',
        expect: { noOrder: true } },

    // ── Mensajes raros ──────────────────────────────────────────────────────
    { id: 'audio_largo', title: 'Audio largo con cinco preguntas', phone: IN,
        opener: 'MEDIA_AUDIO:/media/sim.ogg|TRANSCRIPTION:hola buenas tardes mirá yo quería saber qué efectos laterales puede tener, si tiene rebote, cómo se toma, cuánto sale y si el envío es contrareembolso porque yo soy de Pérez',
        brief: 'Sos Beatriz, de Pérez (al lado de Rosario). Mandaste un audio con cinco preguntas. Si te contestan todo, elegís semillas de 60 y das "Beatriz Luna, Belgrano 880". Si quedó alguna sin contestar, la repetís.',
        expect: { order: true, payment: 'contrarembolso' } },
    { id: 'monosilabos', title: 'Contesta con monosílabos', phone: IN, opener: 'info',
        brief: 'Contestás siempre con una o dos palabras: "si", "ok", "dale", "las gotas", "60", "rosario". Si te piden nombre y dirección das "Ana Diaz" y después, en otro mensaje, "Sarmiento 1200".',
        expect: { order: true, payment: 'contrarembolso' } },
    { id: 'cambia_de_idea', title: 'Cambia de producto y de plan a mitad de camino', phone: IN, opener: AD_CAPS,
        brief: 'Sos Verónica, de Rosario. Elegís cápsulas de 60. Cuando ya te pidieron los datos decís "mejor las gotas" y después "y que sea el de 120". Preguntás cuánto queda el total. Después das "Veronica Arce, Italia 2210".',
        expect: { order: true, payment: 'contrarembolso' } },
    { id: 'datos_con_pregunta', title: 'Da los datos junto con una pregunta', phone: IN, opener: AD_GOTAS,
        brief: 'Sos Susana, de Rosario. Elegís gotas de 60. Cuando te piden los datos mandás "Susana Gomez, Pellegrini 1845, cuando vendrian mas o menos?". Después de la confirmación preguntás si se puede pagar con tarjeta al recibir.',
        expect: { order: true, payment: 'contrarembolso' } },
    { id: 'pide_fecha', title: 'Compra pero lo quiere el viernes', phone: IN, opener: AD_CAPS,
        brief: 'Sos Mónica, de Roldán. Querés cápsulas de 120 pero que te lo lleven el viernes de la semana que viene porque ese día cobrás. SÍ das tus datos: "Monica Vera, San Martin 455".',
        expect: {} },
    { id: 'dos_productos', title: 'Quiere dos productos', phone: IN, opener: AD_INFO,
        brief: 'Sos Claudia, de Rosario. Querés cápsulas de 60 para vos y gotas de 60 para tu mamá de 68 años, en un mismo pedido. Preguntás cuánto es el total de las dos cosas.',
        expect: {} },
];

module.exports = { PERSONAS };
