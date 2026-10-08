# ADR-0002: Campañas promo salientes al ritmo de una persona

**Fecha**: 2026-10-08
**Estado**: Aceptada

## Contexto

Horacio quiere mandarle una promo (plan de 60 días a precio promo) a todo el que consultó
en los últimos 6 meses y no compró, dejando afuera a los últimos 30 días (pueden tener un
pedido en curso o una charla viva), y que quien conteste la pueda comprar con el bot. Medido
el 8-oct-2026 en el seller `horacio`: 6.285 personas entre 30 y 180 días. El 95% solo dejó
rastro en `FunnelEvent`: los estados del chat se limpian a los 30 días y `ChatLog` se purga,
así que el embudo es la única memoria de más de un mes.

Dos constraints chocan:

- En junio de 2026 se desactivó `checkColdLeads` porque escribirle a alguien fuera de la
  ventana de servicio de 24 h de WhatsApp es lo que más rápido hace que Meta marque el
  número. Una campaña a 1.300 personas es exactamente eso, a escala.
- El guion V7 arranca pidiendo kilos y cotiza precios de lista. Un cliente que recibió una
  promo de 60 días no tiene que volver a pasar por eso, y el precio que vio tiene que
  sobrevivir hasta la confirmación del pedido.

## Decisión

1. **Pacing humano, no masivo.** Un cron por minuto por seller (`promoDispatcher.promoTick`)
   manda a lo sumo un mensaje por tick, y solo cuando venció `nextSendAt`, que se sortea
   después de cada envío: pausa entre 6 y 25 min cargada hacia abajo, un corte largo de 35 a
   90 min cada ~8 envíos, arranque del día con retraso al azar, tope diario, ventana horaria
   argentina, fines de semana opcionales. Tres fallos seguidos pausan la campaña.
2. **Un texto distinto por persona, sin IA.** El mensaje se arma por bloques con variantes y
   spintax (`promoTemplates`), determinístico por campaña + teléfono. Se descartó pedirle la
   paráfrasis a Claude: cuesta por mensaje y puede inventar precios o promesas; las
   plantillas no pueden decir nada que no escribimos nosotros.
3. **Lista congelada.** `PromoCampaign` + `PromoRecipient`: la audiencia se calcula una vez
   al crear la campaña (desde `FunnelEvent` para el rastro de 6 meses y `User.profileData`
   para el nombre y el estado de los recientes; nunca `ChatLog`), se mezcla al azar y se
   guarda. Quien solo dejó rastro en el embudo recibe la promo sin nombre y arranca con un
   estado limpio. Cada destinatario se re-valida al momento de mandar (compró, pausado, escribió
   hace poco, pidió no recibir).
4. **Guion propio para la respuesta.** Step `promo_offer`: PROMO/sí → elige presentación →
   carrito del plan 60 al precio promo → menú de pago, y de ahí el flujo normal. Sin kilos.
   Rechazos pausan sin alerta; "no me escribas más" excluye al teléfono de toda campaña.
5. **Precio promo en la fuente única.** `promoPrice60` en `prices.json`; `_getEffectivePrice`
   decide entre promo y lista según `state.promo.active`, y reemplaza a `_getPrice` en los
   cinco sitios que arman o verifican el carrito.

## Consecuencias

- Es un riesgo de reputación del número asumido a propósito. Se arranca con tope bajo
  (10-15 por día) y se mira si bajan los entregados. El botón "Pausar" y el corte automático
  por fallos son el freno.
- Lo que se promete en el texto tiene que ser cierto en la operación: a domicilio va prepago
  y el pago al recibir es retirando en el Correo. Por eso ninguna variante dice "en tu
  puerta". Si el negocio quiere contrarreembolso a domicilio, es otro ADR.
- El precio promo se aplica al plan 60 de cualquier presentación pero nunca por encima del
  de lista (las semillas quedan a 36.900).
- Quien recibe la promo pierde el carrito que tenía a medio armar (se limpia a propósito:
  el precio y el plan cambian). Su `prevStep` queda en `state.promo` para entender el
  historial.
