# Architecture Decision Records (ADRs)

Decisiones arquitectónicas importantes del Bot Herbalis. Una ADR registra el "porqué" detrás de una decisión técnica significativa, para que en el futuro sepamos qué consideramos y qué descartamos.

## Cuándo crear una ADR

Cuando tomes una decisión que:

- Va a costar revertir (ej: cambio de schema mayor, swap de proveedor)
- Tiene tradeoffs no obvios entre alternativas
- Te vas a olvidar el "por qué" en 3 meses

**No** crees ADRs para fixes triviales o decisiones obvias.

## Formato

Numeradas: `0001-titulo-corto.md`, `0002-...`. Plantilla mínima:

```markdown
# ADR-NNNN: Título

**Fecha**: YYYY-MM-DD
**Estado**: Propuesta / Aceptada / Reemplazada por ADR-XXXX / Obsoleta

## Contexto
Qué problema estamos resolviendo. Qué constraints había.

## Decisión
Qué decidimos hacer.

## Alternativas consideradas
Qué otras opciones había y por qué las descartamos.

## Consecuencias
Qué cambia / qué empeora / qué hay que aceptar como costo.
```

## Decisiones documentadas

_(Nada todavía. Cuando aparezca la primera, agregala acá como link)._
