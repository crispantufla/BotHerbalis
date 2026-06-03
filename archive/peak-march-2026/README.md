# Recuperación del guión V3 (pico de conversión — marzo 2026)

Rama: `feat/guion-v3`. Esta carpeta + el `knowledge_v3.json` en la raíz documentan
y reconstruyen el guión que tuvo el pico de conversión del bot de Horacio.

## 1. El hallazgo (datos reales de producción)

Análisis de `DailyStats` + `Order` por semana para `instanceId = horacio`
(script `scripts/analyze-horacio-conversion.js`, solo lectura):

| Semana | Chats | Órdenes | Conversión | Revenue |
|---|---|---|---|---|
| **23-mar-2026** 🏆 | 575 | 59 | **10.26%** | $3.355.300 |
| **16-mar-2026** 🥈 | 605 | 53 | **8.76%** | $3.040.700 |
| 30-mar (parcial) | 160 | 13 | 8.13% | $781.700 |
| Abril (prom.) | ~600 | 26–47 | 5–6% | — |
| Mayo | ↓↓ | 0–13 | 0–4% | — |

**Pico = ventana del 16 al 30 de marzo 2026 (~9–10%).** Hoy: ~2–4%.

## 2. Qué corría en el pico

- **Guión: `v3`** ("Profesional + Contra Reembolso MAX"), default de la época, con
  A/B 50/50 contra v4. Commit de referencia: `7e5eb85` (30-mar-2026).
- **Flow:** pre-multi-tenant (la migración fue el 8-abr), `prices.json`, GPT-4o-mini,
  steps `waiting_ok` / `waiting_price_confirmation` (hoy eliminados).
- **Oferta clave:** **contra-reembolso / pago al recibir A DOMICILIO** (efectivo al
  cartero). Se removió el 25-may-2026 por rechazos → coincide con el desplome de
  conversión documentado en memoria.

El guión v3 auténtico de marzo está en `knowledge_v3_marzo.json` (extraído de git,
difiere ~806 líneas del `archive/knowledge_v3.json` que se editó en mayo).

## 3. Qué se reconstruyó en esta rama

`knowledge_v3.json` (raíz) = **la VOZ de v3 mapeada a la estructura de nodos del
engine V7**, para correr sobre el mismo motor sin romper nada:

| Aporta V3 (voz del funnel) | Se mantiene de V7 (verbatim) |
|---|---|
| `greeting` — precio al frente, "13 años", pago al recibir | `payment_menu`, `payment_*` (MercadoPago, transfer, retiro) |
| `recommendation_1/2` — push de cápsulas, tono directo | `order_confirmation_*` |
| `preference_*` — tono v3 + dosis | FAQ de pago, `rules` (modelo de pago actual) |
| `closing` — "¡Excelente! 🎉 Tomamos los datos" | — |

### ⚠️ Caveats importantes

1. **No reproduce el contra-reembolso a domicilio** (el driver probable del ~10%).
   V7 solo tiene contrarreembolso = retiro en sucursal. Reproducir el COD a puerta
   es una decisión de **negocio + flujo de pago**, no de guión. Si el objetivo real
   es recuperar conversión, esa es la palanca a evaluar (con mitigación de rechazos).
2. **No reproduce el adicional de $6.000** del v3 original (V7 no lo aplica; ponerlo
   en el copy mentiría sobre el precio). Por eso `rules` se hereda de V7.
3. **Orden de productos forzado a V7** (1=Cápsulas, 2=Gotas, 3=Semillas) porque el
   mapeo numérico está hardcodeado en `stepWaitingPreference.ts`. v3 usaba
   2=Semillas, 3=Gotas — copiarlo entregaría el producto equivocado.

## 4. Cómo activar v3 (por seller, sin reiniciar el bot)

**Opción A — Dashboard:** Configuración → tarjeta de Guión → elegir
"V3 · Profesional (pico mar-2026)". (Botón agregado en `SettingsView.jsx`.)

**Opción B — API:**
```
POST /api/script/switch        body: { "script": "v3" }   (?sellerId=horacio para admin global)
GET  /api/script/active        → { active, available:['v7','v3'], stats, labels }
```

Volver a v7: mismo flujo, elegir V7. El default de cuentas nuevas sigue siendo v7.

## 5. Archivos tocados en la rama

- `knowledge_v3.json` (nuevo) — guión v3 compat-V7.
- `src/services/stateManager.ts` — registra v3 en `knowledgeFiles`/`multiKnowledge`/`scriptStats`; deja de migrar v3→v7.
- `src/handlers/messageHandler.ts` — `v3` pasa a ser script soportado (no se coerce a v7).
- `src/api/routes/system.routes.js` — label de v3 en `/script/active`.
- `client/src/components/corporate/SettingsView.jsx` — botón v3 en el selector.
- `scripts/analyze-horacio-conversion.js` (nuevo) — análisis de conversión (solo lectura).
- `archive/peak-march-2026/` — este README + `knowledge_v3_marzo.json` (referencia).

## 6. Recomendación

Probar v3 en **un solo seller** (ej: Horacio) y medir conversión con `scriptStats`
contra v7 durante 1–2 semanas. Pero ojo: si el pico vino del COD a domicilio (muy
probable), el cambio de voz solo no va a recuperar el 10%. Considerar en paralelo
una prueba controlada de re-activación del retiro/COD como oferta héroe.
