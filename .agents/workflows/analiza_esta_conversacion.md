---
description: Analizar y guardar el contexto de la conversación para mantener sincronización entre cuentas
---

Este flujo de trabajo se activa cuando el usuario dice algo como "Analiza esta conversacion: guarda logs en el proyecto", o simplemente pide analizar la conversación. Suele ocurrir múltiples veces al día, específicamente cuando el bot comete un error con un cliente y acabamos de corregir la lógica.

**Objetivo:** El usuario trabaja en este proyecto desde diferentes cuentas de Google, por lo que el contexto (historial de chat) se pierde al cambiar de cuenta. Guardar un log del contexto actual en el proyecto permite continuar trabajando sin fricciones y mantener un registro de los errores recientes arreglados.

**Pasos a seguir:**

1. **Analizar la conversación reciente:** Repasa específicamente el último error del bot que se discutió, el problema detectado en la lógica, y la solución o ajuste que se implementó.
2. **Generar un apunte conciso:** Crea un apunte rápido directo al grano sobre qué fallaba y cómo se solucionó (qué archivo/línea se tocó o qué concepto se ajustó).
3. **Actualizar el log general:** Usa la herramienta `multi_replace_file_content` o `write_to_file` para **añadir** este nuevo apunte al principio del archivo `d:\Bot Whatsapp\AI_SESSION_NOTES.md` (debajo del título principal), incluyendo la fecha y hora. No borres el historial anterior.
4. **Confirmar al usuario:** Notifica al usuario brevemente que el contexto del error se ha guardado en el documento.
