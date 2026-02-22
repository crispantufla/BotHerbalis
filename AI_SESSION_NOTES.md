# 📝 Historial de Sesiones de IA (Contexto Acumulado)

Este documento mantiene un registro de los problemas resueltos, características implementadas y decisiones tomadas en interacciones previas con la IA. 
Al cambiar de cuenta de Google, puedes pedirle a la IA: *"Lee el archivo AI_SESSION_NOTES.md para tener todo el contexto de lo que estábamos haciendo"*.

---

## 🛑 [22 Feb 2026] Análisis Rápido: Salto de mensaje "Prices" y Ajuste de Tono (V2)
**Problema:** Aunque la IA detectaba que el cliente elegía Cápsulas (ej. "Cápsulas o gotas" -> IA recomienda Cápsulas y pregunta si avanzar), cuando el usuario decía "Sí", el bot enviaba el mensaje general de "preference" en lugar del mensaje detallado de PRECIOS de las cápsulas y avanzaba al plan. Además, el cierre de la recomendación de la IA ("¿Te gustaría avanzar con las cápsulas?") sonaba muy robótico.
**Solución:** 
1. En `src/flows/salesFlow.js` (sección `waiting_preference`), se cambió el bloque `_formatMessage(knowledge.flow.preference_capsulas.response)` por `knowledge.flow.price_capsulas.response`. Ahora, cuando el fallback de IA detecta el producto, dispara obligatoriamente el guión exacto de precios.
2. En las instrucciones de recomendación de `aiService.chat` (`waiting_preference_consultation`), se cambió la pregunta final a un tono más humano y argentino: *"¿Te comento sobre las cápsulas?"*.

---

## 🛑 [22 Feb 2026] Análisis Rápido: Doble Confirmación y Fechas Diferidas ("Postdatado")
**Problemas Detectados:**
1. **Doble Confirmación de Producto:** Si en `waiting_weight` (pesaje) el usuario mandaba los kilos pero antes le habíamos respondido consultivamente que le recomendábamos cápsulas, el bot en vez de avanzar fluido al cierre le mandaba el mensaje genérico de preferencias (`preference_capsulas.response` o bien preguntaba de nuevo "cápsulas o gotas").
2. **Ignorar Petición de Fecha Diferida:** Durante la toma de dirección (`waiting_data`), si el cliente tiraba la dirección e inmediatamente pedía que se lo mandemos después del "10 de marzo" o "a principio de mes", el bot ignoraba esa línea porque el parser de direcciones solo buscaba calle/ciudad, perdiendo ese dato logístico clave.

**Soluciones Implementadas:**
1. `src/flows/salesFlow.js` (línea ~655): Se perfeccionó aún más el texto de AI Fallback en `waiting_weight` cuando el usuario dice producto pero no kilos. Si el usuario luego de eso responde simplemente sus "10 kilos", como la IA nunca seteó él `goalMet=true`, el bloque sigue pidiendo la preferencia del producto. ESTO se enlazó con que en realidad el bot debe avanzar si el script encuentra explícitamente la cantidad de peso.
2. `src/services/ai.js` (línea ~580) y `src/flows/salesFlow.js` (línea ~1274): 
   - Se añadió la llave `postdatado` al prompt de extracción de la IA en `parseAddress` para que separe y entienda textos de "diferimiento de envíos" (ej: "cobro el martes").
   - En `waiting_data`, si viene ese dato, se lo guarda en `currentState.postdatado` y no bloquea el avance de recolección de la calle.
   - **`waiting_data` Swap Tolerance and Iteration (v3/v4)**: Added special prefix prompts (`prefixIterated`) and (`prefixPostdatado`) to handle cases where a user re-confirms a product choice during the address stage or specifies a delayed delivery.
- **IMPORTANT**: If a user is already buying capsulas and says "mejor capsulas y me las puedes enviar despues del dia X", the bot correctly *avoids* treating this as a new product swap since the base product is identical. This avoids redundant confirmation blocks. DO NOT change this logic back to aggressively swap on every product mention in `waiting_data`. Tanto el reporte interno (ALERTA SISTEMA) que recibe el administrador, como la Confirmación de Envío final hacia el cliente, ahora incluyen dinámicamente el cartel "Entrega diferida: [Fecha extraída]" para que quede clarísimo.

---

## 🛑 [22 Feb 2026] Análisis Rápido: Lógica de Cambio de Producto y "Preguntas Adelantadas"
**Problemas Detectados:**
1. En `waiting_weight`, si el usuario preguntaba directamente por un producto (ej. "Capsulas o gotas") antes de decir los kilos, el bot asumía que su intención estaba cubierta, daba avance manual e ignoraba la pregunta actual.
2. Si el usuario **cambiaba de producto** durante la toma de datos (`waiting_data`), es decir, después de haber elegido la duración del plan (ej. 120 días), el bot borraba todo el carrito y enviaba nuevamente el bloque de mensajes ultra largos (`preference_producto.response`), provocando que se repitieran largos textos explicativos y preguntando nuevamente los días, lo cual rompía la fluidez en un salto hacia atrás excesivo.
**Soluciones Implementadas:**
1. **Actualización del AI Fallback de `waiting_weight` (línea ~655):**
   - El anclaje original de las recomendaciones ("cápsula" o "gotas" previo al peso) pisaba la transición real al no setear bien `goalMet`.
   - Modificamos el bloque para que, *si descubre el producto adelantado y LUEVO obtiene el kilaje de forma ordinaria por regex*, lo capture de `currentState.suggestedProduct` y salte el mensaje genérico largo ("Ese objetivo es posible...") yendo directo a la propuesta de `price_gotas`, `price_semillas`, o `price_capsulas`.

2. **Corrección de Lógica de Cambio durante Envío (`waiting_data`) (línea ~1155):**
   - Antes estaba "hardcodeado" que cualquier cambio en la intención de producto derivara al usuario devuelta a que tenga que escuchar todo el pitch de preferencias del carrito.
   - Construimos una sub-rutina en `waiting_data` `productChangeMatch`: Si el usuario elige cambiar producto, pero ya tenía un plan de meses elegido y validado (`currentState.selectedPlan`), el sistema re-calcula `subtotal => nuevo_precio * plan`.
   - **Fix (22Feb):** Se corrigió un `break` dentro del bloque condicional `productChangeMatch` en `salesFlow.js`. Al usar recursividad con `break`, Node.js rompía el condicional pero el bloque general ejecutaba hacia abajo, intentando procesar el texto pibe "Mejor gotas" como una calle (triggering la extracción y confirmación de envío vacía). Se reemplazó por un `return`. Ahora manda el msg corto ("Genial 🌿 Las gotas son prácticas... ¿Te tomo los datos?") y frena la ejecución.

3. **Corrección Continua: Fallo de Captura en `waiting_weight` (22Feb):**
   - *Issue*: El bot no guardaba el `suggestedProduct` entre turnos si el usuario no enviaba todo junto.
   - *Fix*: Se añadió captura limpia por simple Regex al tope de la función `waiting_weight` (ej: `/capsula/`), y un comando obligatorio de `saveState()` al enviar el primer AI fallback para persistirlo al 100%. Así saltan el loop de preferencias sin problema.

4. **Mejora del Parser de Datos en Extracciones Redundantes (`waiting_data`) (22Feb):**
   - *Issue*: Si el cliente ya había elegido cápsulas pero reiteraba "Ok, mejor enviame las cápsulas para el martes", el bot ignoraba la redundancia y lanzaba el template robótico de pedir los datos al faltar la calle.
   - *Fix*: Detectamos redundancia `(newProduct === currentState.selectedProduct)` y creamos un generador de `basePrefix` interactivo. Si detecta pedido de "postdatado", la respuesta base cambia de forma inteligente: *"Ok, las cápsulas entonces 😊. Anotado para enviarlo en esa fecha 📅. ¡Dale! Cuando puedas pasame tu Nombre completo..."* permitiendo escalar conversacionalmente.

---

## 🛑 [22 Feb 2026] Análisis Rápido: Salto de mensaje "Prices" y Ajuste de Tono (V2)
**Problema:** Cuando el bot recomendaba un producto al cliente (ej. "Para vos, las cápsulas son la mejor opción...") y el usuario respondía "Si", el bot asignaba el producto por medio del fallback de la IA pero **no enviaba** el bloque de precios (`preference_capsulas.response`) y en el siguiente turno saltaba directo a preguntar por el plan de 60 o 120 días.
**Solución:** Se modificó la regla del AI Fallback para `waiting_preference` en `src/flows/salesFlow.js`. Ahora la IA devuelve `goalMet=true` y `extractedData="Cápsulas/Gotas/Semillas"`. El flujo intercepta esto, marca el `selectedProduct`, cambia el paso para la selección del plan y **envía obligatoriamente el mensaje original de precios** para el producto elegido.

---

## 🗓️ Resumen Histórico de Sesiones Recientes (Hasta Febrero 2026)

A continuación se detalla todo el contexto que he logrado recuperar basándome en los registros de las últimas 20 sesiones de trabajo que tuvimos.

### 🐛 Correcciones y Debugging
* **Interpretación de Fechas por IA**: Se depuraron problemas con la interpretación de fechas y nombres de productos en la lógica del bot (`ai.js`).
* **Crash Loop de Inicialización (Railway)**: Se resolvió un bucle de caídas al inicializar la sesión en Railway (`TargetCloseError` o sesión corrupta). Se añadió manejo con `try-catch` y se indicó el uso de la variable `RESET_SESSION=true` en Railway para limpiar corrupciones.
* **Crash en Frontend (`CommsView.jsx`)**: Se solucionó el error crítico de "pantalla blanca" provocado al fallar el renderizado (por ejemplo, timestamps o datos de mensaje inválidos).
* **Límites de Peticiones de IA (Error 429)**: Se implementó un sistema de rotación de múltiples claves (`API Keys`) para la IA, utilizando el `.env` para distribuir las llamadas y evitar bloqueos por rate limit.
* **Solución de Bugs de Flujo (Febrero)**: Corrección de "stale steps" (pasos conversacionales estancados), problemas de codificación (encoding), manejo de pasos genéricos o desconocidos, y confirmaciones sin datos completos (ejemplo "CP: undefined").

### ✨ Nuevas Características (Features)
* **Rotación de Scripts (Pruebas A/B)**: Se implementó un sistema (backend y frontend en `SettingsView.jsx`) para enviar dinámicamente el script regular y uno alternativo a los clientes y probar su efectividad (Sales Script V1 y V2).
* **Indicador Visual de Script**: La interfaz web y la API se modificaron para visualizar claramente si a un contacto específico se le está asignando el Script 1 o Script 2 en el panel de chats.
* **Recuperación de Carritos y Growth**: Implementación de la función de recuperación de carritos (abandoned cart recovery) para enganchar nuevamente a los posibles clientes.
* **Persistencia de Volúmenes (Docker/Railway)**: Configuración en el `Dockerfile`, `index.js`, y `system.routes.js` de la variable de entorno `DATA_DIR` apuntando a `/app/data` para garantizar la supervivencia de la sesión de WhatsApp entre despliegues.

### 💬 Mejoras en el Comportamiento de IA (Tono y Naturalidad)
* **Tono de la IA (Estilo Argentino)**: Modificamos el sistema y fallbacks para que el bot responda con mayor empatía y acento local (ej. *"No te preocupes, te ayudo..."*). 
* **Manejo de Objeciones y Desconfianza**: Se dotó a la IA de flexibilidad para volver atrás si el usuario cambia de opinión. También aprendió a calmar la desconfianza ("¿esto es una estafa?") ofreciendo métodos seguros como pago contra entrega.
* **Desglose de Costos de Envío/Productos**: El bot ahora pide la información de dirección faltante y, en la confirmación final, desglosa el costo del producto, los cargos fijos de "Servicio MAX", y el total explícitamente.
* **Ordenamiento de Bienvenida**: Ajuste del flujo de inicio para asegurar que el texto se entregue primero y la imagen después, favoreciendo la lectura.
* **Implementación de Auditorías**: Validar los Códigos Postales (CP), autocompletado de provincia por código postal y reseteo de la sesión para usuarios que completaron el flujo de compra.

---

> *Este log de contexto se irá actualizando a medida que terminemos nuevas áreas de trabajo si se activa el comando definido en la regla de flujo.*
