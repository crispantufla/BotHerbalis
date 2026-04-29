# Analytics API — Acceso programático

Endpoints HTTP para leer métricas agregadas del bot Herbalis. Pensado para integraciones externas (otro Claude Code, scripts de análisis, dashboards de marketing) sin necesidad de cuenta de usuario ni acceso a la DB.

## Autenticación

Header en cada request:

```
Authorization: Bearer htbk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

El token se genera desde el panel admin: **Cuentas → API Tokens → Nuevo token**. El plaintext se muestra una sola vez al crearlo. Si lo perdés, revocá y creá uno nuevo.

Scope necesario: `analytics:read`. Cualquier otro endpoint del bot rechaza este token.

## Base URL

```
https://mainherbalisbot-production.up.railway.app
```

## Endpoints

### `GET /api/analytics/overview?days=30`

Métricas financieras del último período + crecimiento vs período anterior.

```jsonc
{
  "revenue": { "value": 1234500, "growth": 18 },   // ARS, % vs período previo
  "orders":  { "value": 47,      "growth": 25 },
  "aov":     { "value": 26266,   "growth": -5 }    // ticket promedio
}
```

### `GET /api/analytics/products?days=30`

Distribución por producto y plan de duración.

```jsonc
{
  "popularity": [{ "name": "Capsulas", "value": 32 }, ...],
  "duration":   [{ "name": "60 días", "value": 18 }, ...]
}
```

### `GET /api/analytics/demographics?days=30`

Heatmap de ventas por hora del día y top provincias.

```jsonc
{
  "provinces": [{ "name": "Buenos Aires", "value": 12 }, ...],
  "heatmap":   [{ "hour": 14, "day": "Mon", "value": 3 }, ...],
  "dailyChats": [{ "date": "2026-04-28", "chats": 88 }, ...]
}
```

### `GET /api/analytics/ad-performance?days=30`

Conversión por fuente de anuncio (cuando el cliente vino con UTM/tag).

```jsonc
[
  { "source": "facebook_carrusel_v3", "chats": 120, "orders": 14, "revenue": 320000 },
  ...
]
```

### `GET /api/stats/charts`

Series históricas de los últimos 30 días (revenue + chats por día).

## Filtrado por vendedor

Por defecto los endpoints devuelven datos **agregados de todos los bots**. Si querés filtrar por uno específico:

```
?sellerId=horacio
# o
-H "x-seller-id: horacio"
```

Vendedores válidos: `pablo`, `horacio`, `ines`, `alejandra`, `suzane`, `denis`. Pasá `""` (vacío) o omití para vista global.

## Ejemplos

### curl

```bash
TOKEN="htbk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
BASE="https://mainherbalisbot-production.up.railway.app"

curl -H "Authorization: Bearer $TOKEN" "$BASE/api/analytics/overview?days=7"
```

### Python

```python
import requests

BASE = "https://mainherbalisbot-production.up.railway.app"
TOKEN = "htbk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
H = {"Authorization": f"Bearer {TOKEN}"}

r = requests.get(f"{BASE}/api/analytics/overview", params={"days": 30}, headers=H)
print(r.json())
```

### Node.js

```js
const TOKEN = 'htbk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const BASE = 'https://mainherbalisbot-production.up.railway.app';

const res = await fetch(`${BASE}/api/analytics/overview?days=30`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
});
console.log(await res.json());
```

## Notas

- **Tiempo en UTC**. Convertí a Argentina (UTC-3, sin DST) si lo necesitás.
- Los endpoints **no exponen PII** (teléfonos, nombres, direcciones). Solo agregados.
- Rate limit: el bot mismo no impone uno, pero Railway sí. Mantenete por debajo de ~60 req/min.
- Si el token se compromete, revocalo desde el panel de admin: efecto inmediato.
- Para histórico de días específicos en AR: filtrar con `createdAt >= '2026-04-28T03:00:00Z' AND createdAt < '2026-04-29T03:00:00Z'` no aplica acá (los endpoints reciben `days` desde hoy hacia atrás), pero si necesitás granularidad fina, pedí un endpoint nuevo.
