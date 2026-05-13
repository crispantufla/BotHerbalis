# Scripts archivados

Scripts one-off que se ejecutaron una vez para análisis o reportes y ya cumplieron su propósito. **No correr en producción** — el contenido puede contradecir políticas actuales.

## generate-mp-vs-cr-report.js

**Fecha**: mayo 2026.
**Política reflejada**: empujar MercadoPago sobre Contra reembolso usando *cuotas* como anchor de valor ("9 cuotas sin interés desde $7.433/mes").

**Por qué quedó obsoleto**:
- Mayo/2026: política MP-only espontánea (este script fue parte de esa iniciativa).
- 13/05/2026: revertimos la política — ahora se ofrecen las 3 opciones de pago espontáneamente, y el bot **no menciona cuotas en ningún mensaje al cliente** (porque algunas tarjetas no las ofrecen y eso generaba expectativas falsas).

Si querés generar un PDF de recomendaciones nuevo, escribilo desde cero contra la política vigente — no usar este como base.
