# Domain Glossary — Bot Herbalis

Diccionario de términos del dominio. Las skills (`diagnose`, `improve-codebase-architecture`, `tdd`, `zoom-out`) leen este archivo antes de proponer refactors o reportar bugs, para usar tu jerga y no inventar sinónimos.

> Mantenelo simple: agregá entradas cuando aparezca un término que se repita y donde el lenguaje natural ambiguo te haga repreguntar. No es un wiki — es un glosario.

## Conceptos centrales

- **seller** = **vendedor** = **bot** = **instancia** = **tenant**. Identificado por `sellerId` en código y `instanceId` en DB (siempre el mismo string, ej: `"horacio"`, `"ines"`, `"pablo"`). Cada uno tiene su propio Client de WhatsApp, su queue BullMQ y su `sharedState` aislado.
- **admin global** vs **tenant admin**: cuenta con `role=admin`. Si `sellerId=null` → admin global (ve todo agregado). Si `sellerId` ≠ null → admin scopeado a su seller.
- **client** / **cliente** = la persona que escribe al bot por WhatsApp (NO el `Client` de wwebjs — eso es la conexión técnica). Identificado por su `phone`.
- **chat** = una conversación con un cliente específico. Una fila en `User`, una sesión en memoria (`userState[phone]`), e historial en `ChatLog`.

## Flujo de venta

- **step** = **paso del embudo** = nodo de la state machine en `src/flows/steps/`. Valores en `FlowStep` enum (`greeting`, `waiting_weight`, `waiting_preference`, etc.).
- **transición** = pasar de un step a otro. Se hace **siempre** con `_setStep(state, FlowStep.X)`. NUNCA asignar `state.step` directamente — eso saltea reset de flags y log de funnel.
- **matched** = el step handler entendió el mensaje del cliente sin tener que llamar a la IA. Es el camino feliz (rápido, predecible, barato).
- **AI fallback** = el step handler no entendió, llamó a OpenAI con un goal específico al step. Riesgoso porque depende de IA disponible.

## Estados del cliente

- **pausa** / **pausado** = bot dejó de responder a ese cliente, requiere intervención humana del admin. No se auto-libera. Se setea con `_pauseAndAlert(...)`. Razones típicas: bot no entendió, cliente recurrente, cliente post-venta.
- **alerta** = entrada en `sessionAlerts` que aparece en el dashboard del admin pidiendo atención. NO es lo mismo que pausa (puede haber pausa sin alerta y viceversa).
- **stale** = cliente pausado/inactivo más de N días. Cron lo despausa automáticamente.

## Datos de venta

- **order** / **pedido** / **venta** = fila en `Order`. Status: `Pendiente` (datos incompletos) → `En sistema` (datos completos, no confirmado por admin) → `Confirmado` (admin lo aprobó) → `Enviado`. `Cancelado` aparte.
- **plan** = duración del tratamiento (`60` o `120` días).
- **adicional MAX** / **contrarembolso MAX** = recargo de $6.000 que aplica solo a plan 60 días + pago en efectivo/contrarembolso. NUNCA inventar precios — leer con `_getAdicionalMAX()` de `pricing.ts`.

## Infraestructura

- **clientPool** = mapa `sellerId → SellerInstance` que orquesta todos los bots en un solo proceso Node. Único punto de creación de Clients de wwebjs.
- **sharedState** = estado en memoria por seller (`userState`, `pausedUsers`, `config`, `io`). NO se mezcla entre sellers.
- **knowledge** = JSON de configuración del bot (`knowledge_v3.json`) con script de respuestas y FAQ. Se carga al boot, no es por cliente.
