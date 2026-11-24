# Simulación de clientes — 32 charlas

Pedidos cerrados: 14 · pausados: 23 · excepciones: 0

## Chequeos automáticos (15)

- **alta** `dijo_lo_prohibido` — caro_regatea#1: /descuento del/ → "Con dos de 60 días no hay rebaja, se paga cada uno a su precio. El descuento del 50% aplica solo a partir del tercer producto, cuando el ped"
- **alta** `pago_al_recibir_fuera_de_zona` — fuera_cordoba_transfer#1: "Dale, a *Rosario* llegamos con reparto propio 🚚 Te lo llevamos a tu casa sin costo y lo pagás al recibirlo: efectivo, tarjeta o transferenc"
- **alta** `localidad_ya_dicha` — pregunta_si_es_bot#1: el cliente dijo "jajaja bueno dale, cuanto tarda en llegar? soy de capital" y después el bot preguntó: " sucursal más cercana. Se abona antes y llega en *4 días hábiles*. ¿De qué localidad sos?"
- **media** `precio_fuera_de_lista` — caro_regatea#1: montos que no están en la lista de precios: $13.000, $73.800, $91.800, $109.800
- **media** `precio_fuera_de_lista` — dos_productos#1: montos que no están en la lista de precios: $109.800
- **media** `mensaje_repetido` — edad_73_quiere_capsulas#1: 2 veces: "despues de los 70 no indicamos las capsulas ni las semillas 🙏 con 73 "
- **media** `mensaje_repetido` — fuera_bsas_tarjeta#1: 2 veces: "⏳ todavia no veo el pago confirmado en el sistema. espera unos minuto"
- **media** `sin_respuesta` — menor_17#1: el bot no contestó a: "dale pero igual quiero intentar, pasame los datos y ya fue"
- **media** `sin_respuesta` — menor_17#1: el bot no contestó a: "anda dale elena no seas asi, solo quiero probar. me das los datos o no?"
- **media** `sin_respuesta` — menor_17#1: el bot no contestó a: "dale anda elena porfa, tengo q bajar de peso ahora. me das los datos para confirmar?"
- **media** `sin_respuesta` — menor_17#1: el bot no contestó a: "dale elena anda, insistí una vez más porfa. igual me las mandas no? dame los datos y listo"
- **media** `sin_respuesta` — menor_17#1: el bot no contestó a: "anda elena porfa, ya insistí mucho. igual soy de rosario, me las mandas? agus gauna, gorriti 1240. dale?"
- **media** `localidad_3_veces` — pregunta_si_es_bot#1: preguntó la localidad 4 veces
- **baja** `dos_preguntas_seguidas` — fuera_bsas_tarjeta#1: "unos datos para armar el envío. Primero, ¿me pasás tu nombre completo?" + " crédito* o por *transferencia*. ¿Lo querés en tu casa o en sucursal?"
- **baja** `pregunta_kilos` — solo_agradece#1: "Te entiendo, es una inversión y está bien que lo pienses 😊 Cada cuerpo tiene su ritmo. Quienes tienen más kil"

## Juez (8)

- **alta** — desconfia_anmat: El cliente preguntó específicamente si ANMAT prohibió la nuez de la india por ser tóxica. El bot ignoró esa pregunta por completo y respondió como si la duda fuera sobre si el vendedor era una empresa seria o un trucho, hablando de protección con tarjeta y años de trayectoria. No contestó lo que se le preguntó.
  - Debía: Responder directamente a la pregunta sobre ANMAT: aclarar que la nuez de la india no está prohibida por ANMAT, y si hay confusión con otro producto (como la nuez de Brasil), explicarlo. Recién después, si correspondía, mencionar la trayectoria del negocio.
  - Cita: CLIENTE: "ey espera, no es verdad q la nuez de india esta prohibida por anmat? lei q es toxxica" → BOT: "¡Te re entiendo, hay mucho trucho por ahí! 😊 Por eso el pago con tarjeta de crédito tiene protección al comprador: si no te llega el producto te devuelven el 100%. 13 años haciendo esto, más de 70 mil clientes. ¿Te tomo los datos así te llega?"
- **alta** — dos_productos: El cliente pidió dos productos (cápsulas para ella y gotas para la mamá) y el bot confirmó el total de $109.800. Pero después procesó el pedido con solo las cápsulas ($54.900) y emitió una confirmación con ese monto. Cuando el cliente lo señaló, el bot siguió sin corregirlo y cerró el pedido incompleto. El sistema también guardó solo las cápsulas.
  - Debía: Armar el pedido con los dos productos desde el principio, confirmar el total de $109.800 con ambos ítems, y no emitir la confirmación hasta tener los dos productos correctamente cargados.
  - Cita: CLIENTE: "sí, confirmame los 109.800 con las dos cosas y listo. paso mis datos" → BOT: "Perdoná, no me quedó clara la dirección 🙈 ¿Me pasás la *calle y la altura* (número)?" (y luego la confirmación final solo dice cápsulas por $54.900)
- **alta** — fuera_cordoba_transfer: El cliente dijo que era de Córdoba y el bot le ofreció reparto propio de Rosario, pago al recibir y le pidió nombre y dirección como si fuera local. Recién cuando el cliente lo corrigió ("yo soy de córdoba no de rosario jaja") el bot se reacomodó.
  - Debía: Apenas el cliente dijo "soy de córdoba capital", el bot tenía que informar que el envío va por Correo Argentino prepago, no ofrecer reparto propio ni pago al recibir.
  - Cita: CLIENTE: "soy de córdoba capital, barrio alberdi" → BOT: "Dale, a *Rosario* llegamos con reparto propio 🚚 Te lo llevamos a tu casa sin costo y lo pagás al recibirlo..."
- **alta** — pregunta_si_es_bot: El cliente preguntó explícitamente quién era Elena y pidió datos de la empresa antes de clickear el link, con clara desconfianza. El bot ignoró la pregunta y mandó el link de pago de nuevo, sin responder nada de lo que el cliente preguntó.
  - Debía: Responder quién es Elena / qué es Herbalis, dar algún dato de contacto o referencia de la empresa, y recién después (o junto con eso) ofrecer el link. No ignorar una pregunta directa sobre identidad cuando el cliente ya dijo que le da cosa.
  - Cita: CLIENTE: "espera espera, no voy a clickear un link sin saber bien quien sos. vos sos elena? tenes numero de empresa o algo? me da cosa" → BOT: "Acá está tu enlace de pago: https://mpago.la/sim-link Cuando completes el pago escribime *"listo"* 👍"
- **media** — difiere_cobro: El cliente dejó en claro desde el primer mensaje que quería las gotas de 120 días. El bot lo reconoció, pero cuando el cliente confirmó la fecha (5 de mayo), el bot le volvió a preguntar si quería 60 o 120 días, como si no hubiera elegido nada.
  - Debía: Recordar que el cliente ya eligió las gotas de 120 días y avanzar con esa elección, sin volver a preguntar algo que ya estaba respondido.
  - Cita: CLIENTE: "el 5 de mayo me va bien" → BOT: "¡Genial, las *gotas*! 💧 Vienen en dos planes: 🔹 *60 días* → $54.900 🔹 *120 días* → $68.900 ¿Con cuál vas, 60 o 120 días?"
- **media** — zona_borde_uranga: El cliente preguntó explícitamente si podía pagar cuando le traigan el producto ("yo pago cuando me lo traen") y el bot ya le había explicado que fuera de Rosario es prepago. Hasta ahí bien. Pero cuando el cliente dijo que no tenía tarjeta y que la transferencia le cobraba comisión, el bot directamente le pasó el alias de transferencia sin atender la objeción real: el cliente no quería pagar por adelantado, no que no supiera cómo hacerlo.
  - Debía: Reconocer que el cliente tenía una objeción sobre el pago anticipado en sí (no sobre el método), y explicar por qué no hay contrarreembolso fuera de Rosario antes de ofrecer las opciones de pago.
  - Cita: CLIENTE: "ay no, yo no tengo tarjeta. y la transferencia me cobra el banco. me parece mucho" → BOT: "¡Dale, podemos por *transferencia bancaria* 🏦 Alias: *HERBALIS.TIENDA*..."
- **media** — zona_localidad_desconocida: El cliente preguntó dos veces si podía pagar en cuotas ("necesito saber si puedo pagar en cuotas", "che, pero en cuotas se puede?"). El bot nunca respondió claramente si se puede o no; en cambio, esquivó la pregunta y siguió empujando el link de pago. Cuando el cliente dijo "vos pasame el link y listo", el bot lo interpretó como que aceptó pagar el total, pero en realidad el cliente estaba asumiendo que su tarjeta le iba a permitir cuotas por su cuenta, algo que el bot nunca aclaró ni confirmó ni desmintió.
  - Debía: Responder directamente que desde Herbalis no se ofrecen cuotas, pero que si la tarjeta del cliente lo permite al momento de pagar, eso depende del banco/tarjeta y no de ellos. Así el cliente decide con información clara.
  - Cita: CLIENTE: "che, pero en cuotas se puede? tengo tarjeta pero prefiero así" → BOT: "Entiendo que preferís pagar con la tarjeta 😊 Con el link de pago seguro abonás el total de *$49.900* con tu tarjeta de crédito..."
- **baja** — revendedor: El bot primero derivó correctamente a Horacio para la consulta mayorista, pero acto seguido mandó la lista de precios minoristas como si el cliente fuera un comprador común.
  - Debía: Después de derivar a Horacio, no mandar nada más. La lista de precios minoristas no tiene sentido para alguien que preguntó por precio mayorista y ya fue derivado.
  - Cita: CLIENTE: "Hola, vendo productos naturales y quiero comprar por mayor para revender, tienen precio mayorista?" → BOT: (primero deriva a Horacio, luego) "¡Claro! Estos son los precios 👇 💧 *Gotas* — 60 días *$54.900*..."

## Por personaje

- audio_largo#1 — Audio largo con cinco preguntas: fin `completed`, pedido, pausado · 0 chequeos
- cambia_de_idea#1 — Cambia de producto y de plan a mitad de camino: fin `completed`, pedido, pausado · 0 chequeos
- caro_regatea#1 — Le parece caro y pide descuento: fin `waiting_preference` · 2 chequeos
- datos_con_pregunta#1 — Da los datos junto con una pregunta: fin `completed`, pedido, pausado · 0 chequeos
- desconfia_anmat#1 — Dice que está prohibido por ANMAT: fin `waiting_preference`, pausado · 0 chequeos
- difiere_cobro#1 — Compra cuando cobre: fin `waiting_plan_choice`, pausado · 0 chequeos
- difiere_consulta_hermana#1 — Lo consulta con la hermana: fin `waiting_preference` · 0 chequeos
- dos_productos#1 — Quiere dos productos: fin `completed`, pedido, pausado · 1 chequeos
- edad_73_quiere_capsulas#1 — 73 años, quiere cápsulas: fin `completed`, pedido, pausado · 1 chequeos
- edad_82#1 — 82 años: fin `rejected_medical`, pausado · 0 chequeos
- efecto_adverso#1 — Ya lo toma y le hizo mal: fin `greeting`, pausado · 0 chequeos
- embarazada#1 — Embarazada: fin `rejected_medical` · 0 chequeos
- feliz_funes_todo_junto#1 — Da todo en un mensaje: fin `completed`, pedido, pausado · 0 chequeos
- feliz_rosario#1 — Compra directa en Rosario: fin `completed`, pedido, pausado · 0 chequeos
- fuera_bsas_tarjeta#1 — Buenos Aires, quiere tarjeta: fin `waiting_mp_payment` · 2 chequeos
- fuera_cordoba_transfer#1 — Córdoba, paga por transferencia: fin `waiting_transfer_confirmation`, pedido, pausado · 1 chequeos
- fuera_insiste_contrarreembolso#1 — Mendoza, exige pagar al recibir: fin `waiting_payment_method`, pausado · 0 chequeos
- insulta#1 — Insulta: fin `rejected_abusive`, pausado · 0 chequeos
- menor_17#1 — Tiene 17 años: fin `rejected_medical` · 5 chequeos
- monosilabos#1 — Contesta con monosílabos: fin `completed`, pedido, pausado · 0 chequeos
- pide_fecha#1 — Compra pero lo quiere el viernes: fin `completed`, pedido, pausado · 0 chequeos
- pregunta_si_es_bot#1 — Pregunta si habla con un bot: fin `waiting_mp_payment` · 2 chequeos
- revendedor#1 — Quiere revender: fin `waiting_preference`, pausado · 0 chequeos
- salud_medicacion#1 — Toma medicación para el corazón y tiroides: fin `completed`, pedido, pausado · 0 chequeos
- se_equivoco#1 — Se equivocó de chat: fin `waiting_preference` · 0 chequeos
- solo_agradece#1 — Agradece y nada más: fin `waiting_preference` · 1 chequeos
- ya_lo_tiene#1 — Ya lo recibió y pregunta cómo tomarlo: fin `completed`, pausado · 0 chequeos
- zona_borde_uranga#1 — Pueblo cercano sin reparto: fin `waiting_payment_method`, pausado · 0 chequeos
- zona_dice_rosario_temprano#1 — Dice "soy de Rosario" al principio y después pregunta por cuotas: fin `completed`, pedido, pausado · 0 chequeos
- zona_localidad_desconocida#1 — Pueblo que no está en ninguna lista: fin `waiting_mp_payment` · 0 chequeos
- zona_pregunta_donde_estan#1 — Pregunta de dónde son antes de decir de dónde es: fin `waiting_transfer_confirmation`, pedido, pausado · 0 chequeos
- zona_retiro_local#1 — Quiere retirar en un local: fin `completed`, pedido, pausado · 0 chequeos