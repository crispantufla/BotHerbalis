# Claude como motor del bot (migración full)

> **Actualización 2026-05-31 — MIGRACIÓN FULL.** Tras el A/B (horacio 30%) y una
> comparación cualitativa off-script, se decidió ir **100% Claude** y dejar GPT atrás:
> `CLAUDE_AB_SELLERS=*` (todos los sellers), `CLAUDE_AB_PERCENT=100`. Ya **no hay grupo
> de control** GPT — GPT-4o queda solo como *fallback* si Claude falla. La "revisión"
> del ~04-jun pasa a ser un **antes/después** de conversión (período Claude vs período
> GPT previo) + costo Anthropic, no un A/B. El resto de este doc describe el mecanismo
> original del A/B (sigue válido; con `PERCENT=100` y `SELLERS=*` simplemente cae todo
> en Claude). Rollback instantáneo: `railway variables --set CLAUDE_AB_PERCENT=0`.

**Activado:** 2026-05-30 (A/B 30%) → 2026-05-31 (full 100%)
**Revisión prevista:** ~2026-06-04
**Estado actual:** `CLAUDE_AB_SELLERS=*`, `CLAUDE_AB_PERCENT=100`

## Qué se está probando

Comparar Claude contra GPT-4o como cerebro conversacional del bot, midiendo si Claude
sigue mejor las reglas del prompt (menos reportes de "Errores de IA") y si mueve la
conversión, sin migrar todo de golpe.

Solo horacio tiene tráfico real hoy, así que el A/B corre **dentro de los clientes de
horacio**: un % de sus conversaciones va a Claude y el resto sigue en GPT-4o.

- Solo el `chat()` va a Claude (Sonnet en pasos premium, Haiku en el resto).
- Whisper (audios), embeddings (semantic cache) y visión **siguen en OpenAI** — Anthropic no los tiene.
- Si Claude falla en una llamada → **fallback automático a GPT-4o** (no se corta ninguna venta).

## Cómo funciona el split (determinista por teléfono)

Cada cliente cae siempre en el mismo brazo (no flipea a mitad de conversación):

```
hash = parseInt(md5(phoneLimpio).slice(0, 8), 16)   // phone sin @c.us
brazo = (hash % 100) < CLAUDE_AB_PERCENT ? "CLAUDE" : "GPT"
```

Como es determinista, los brazos se reproducen al medir: basta volver a hashear los
teléfonos con la misma fórmula. No se guarda nada extra.

Código: `src/services/ai.ts` → `_useClaudeFor()` + `_claudeChat()`.

## Variables de entorno (Railway, servicio MainHerbalisBot)

| Variable | Valor actual | Qué hace |
|---|---|---|
| `ANTHROPIC_API_KEY` | (set) | Sin esto, todo queda en OpenAI |
| `CLAUDE_AB_SELLERS` | `horacio` | Sellers en el experimento (coma-separados) |
| `CLAUDE_AB_PERCENT` | `30` | % de conversaciones de ese seller que van a Claude |
| `CLAUDE_MODEL_PREMIUM` | `claude-sonnet-4-6` (default) | Modelo para pasos premium |
| `CLAUDE_MODEL_SIMPLE` | `claude-haiku-4-5-20251001` (default) | Modelo para el resto |

## Cómo correr el análisis (en la revisión)

1. Sacar la URL read-only de prod: `railway variables --service Postgres --kv` → `DATABASE_PUBLIC_URL`.
2. Conectar con `pg.Client` (`ssl: { rejectUnauthorized: false }`). **Escribir el script en un
   archivo** (el quoting inline rompe) y **borrarlo al terminar**.
3. Para las conversaciones de horacio (`sellerId='horacio'`) desde `2026-05-30`, bucketear
   cada teléfono por el hash de arriba en brazo Claude vs GPT.
4. Comparar entre brazos:
   - **Conversión** = órdenes / prospectos. Órdenes en `Order` (excluir `instanceId='__legacy_import__'`);
     prospectos en `FunnelEvent` con `stepTo IN ('greeting','waiting_weight')`.
   - **Tasa de reportes** en la tabla `AiErrorReport`.
5. Reportar y decidir.

## Decisiones posibles tras la revisión

```bash
# Rampear a 50% (si Claude va bien y querés señal más rápida)
railway variables --set "CLAUDE_AB_PERCENT=50"

# Mantener en 30 (no hacer nada)

# Apagar — vuelve todo a GPT-4o al instante
railway variables --set "CLAUDE_AB_PERCENT=0"
# o sacar el experimento del todo: borrar CLAUDE_AB_SELLERS
```

> ⚠️ Mantener `CLAUDE_AB_PERCENT` fijo durante el experimento: cambiarlo re-asigna los
> brazos (un teléfono en hash 45 es Claude a 50% pero GPT a 40%).

## Probarlo a mano

La sección **"Probar bot"** del dashboard tiene un toggle **GPT-4o / Claude** para chatear
contra cualquiera de los dos modelos y comparar respuestas del mismo input. Funciona aunque
el A/B esté apagado (basta con `ANTHROPIC_API_KEY` cargada).

## Contexto

Por qué hicimos todo esto: ver el análisis de la caída de conversión de mayo 2026 (cambio de
modelo de pago) y las mejoras posteriores en el historial de commits del 2026-05-30.
