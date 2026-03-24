# Manual de Comandos WhatsApp para Vendedores

## Como funciona

Podes controlar todo el bot desde WhatsApp. Cada comando empieza con `!` y podes mandarlo como mensaje de texto o audio.

Cuando llegan alertas de pedidos, cada una tiene un **numero** (#1, #2, #3...). Para responder a una alerta especifica, ponele el numero adelante: `1 ok`, `2 me encargo`.

---

## 1. Alertas y pedidos

### Confirmar un pedido

| Escribis | Que hace |
|----------|----------|
| `1 ok` | Confirma el pedido de la alerta #1 |
| `2 ok` | Confirma el pedido de la alerta #2 |
| `1 dale` / `1 si` / `1 confirmar` | Igual que "1 ok" |
| `ok` | Confirma la alerta mas reciente (sin numero) |

### Tomar control ("Me encargo")

| Escribis | Que hace |
|----------|----------|
| `1 me encargo` | Pausa el bot para el cliente #1, lo atendes vos |
| `me encargo` | Pausa el bot para la alerta mas reciente |
| `1 intervenir` | Igual que "1 me encargo" |

### Ver alertas activas

| Escribis | Que hace |
|----------|----------|
| `!alertas` | Muestra la lista numerada de alertas pendientes |

Ejemplo de respuesta:
```
Alertas activas (3):

#1 -- Juan (5491155551234) -- Kit Herbalis -- hace 2 min
#2 -- Maria (5491166662345) -- Pack Premium -- hace 30 seg
#3 -- Carlos (5491177773456) -- Kit Basico -- hace 10 seg
```

### Instruccion personalizada por IA

| Escribis | Que hace |
|----------|----------|
| `1 decile que el envio tarda 48hs` | La IA genera un mensaje para el cliente #1 |
| `2 preguntale si prefiere otro producto` | Mensaje IA para cliente #2 |
| `decile que lo llamamos manana` | Manda al cliente de la alerta mas reciente |

---

## 2. Gestion de clientes

### Ver clientes pausados

| Escribis | Que hace |
|----------|----------|
| `!pausados` | Lista todos los clientes con el bot pausado |

### Reactivar el bot para un cliente

| Escribis | Que hace |
|----------|----------|
| `!despauser 5491155551234` | Reactiva el bot para ese cliente |
| `!reanudar 5491155551234` | Igual que !despauser |

### Reiniciar estado de un cliente

| Escribis | Que hace |
|----------|----------|
| `!reset 5491155551234` | Borra toda la memoria del cliente. El proximo mensaje que mande arranca un chat nuevo |

### Ver historial resumido

| Escribis | Que hace |
|----------|----------|
| `!historial 5491155551234` | La IA genera un resumen de la conversacion con ese cliente |

### Enviar mensaje directo

| Escribis | Que hace |
|----------|----------|
| `!enviar 5491155551234 Hola, te contacto desde Herbalis` | Manda ese texto al cliente sin IA |

---

## 3. Pedidos y tracking

### Ver pedidos recientes

| Escribis | Que hace |
|----------|----------|
| `!pedidos` | Muestra los ultimos 5 pedidos de todos los clientes |
| `!pedido 5491155551234` | Muestra los pedidos de un cliente especifico |

### Cargar codigo de seguimiento

| Escribis | Que hace |
|----------|----------|
| `!tracking 5491155551234 OC123456789AR` | Carga el tracking y le avisa al cliente por WhatsApp |

El cliente recibe automaticamente un mensaje con su codigo de seguimiento.

---

## 4. Estado y estadisticas

### Ver estado del bot

| Escribis | Que hace |
|----------|----------|
| `!status` | Muestra: conexion, memoria, sesiones activas, alertas, script activo |

Ejemplo de respuesta:
```
Estado del Bot

WhatsApp: Conectado
Uptime: 2h 15m
Memoria: 128 MB
Sesiones activas: 23
Clientes pausados: 3
Alertas activas: 1
Pausa global: NO
Script activo: v3
```

### Ver ventas del dia

| Escribis | Que hace |
|----------|----------|
| `!stats` | Pedidos hoy, revenue, conversion, sesiones activas |

### Ver precios actuales

| Escribis | Que hace |
|----------|----------|
| `!precios` | Muestra la lista de precios de todos los productos |

### Reporte diario

| Escribis | Que hace |
|----------|----------|
| `!resumen` | Reporte completo del dia |

---

## 5. Configuracion del bot

### Pausar todo el bot

| Escribis | Que hace |
|----------|----------|
| `!pausa-global on` | Pausa el bot entero. No responde a nadie |
| `!pausa-global off` | Reactiva el bot |
| `!pausa-global` | Alterna entre encendido y apagado |

### Cambiar script activo

| Escribis | Que hace |
|----------|----------|
| `!script` | Ver que script esta activo y cuales hay disponibles |
| `!script v3` | Cambiar a script v3 |
| `!script v4` | Cambiar a script v4 |

### Gestionar numeros de alerta

| Escribis | Que hace |
|----------|----------|
| `!admin list` | Ver numeros que reciben alertas |
| `!admin add 5491155551234` | Agregar numero a alertas |
| `!admin remove 5491155551234` | Quitar numero de alertas |

### Otros

| Escribis | Que hace |
|----------|----------|
| `!saltear 5491155551234` | Fuerza a un usuario al paso de datos |
| `!ayuda` | Muestra el menu de comandos |

---

## Ejemplo: 2 alertas al mismo tiempo

1. Llega alerta de **Juan** (#1): Kit Herbalis - $15000
2. Llega alerta de **Maria** (#1 nueva, Juan pasa a #2): Pack Premium - $25000
3. Confirmas a Juan: `2 ok`
4. Tomas control de Maria: `1 me encargo`
5. Le hablas a Maria directamente por WhatsApp
6. Cuando terminas, la reactivas: `!despauser 5491166662345`
7. Verificas que no quede nada: `!alertas`

---

## Ejemplo: Cargar tracking y verificar estado

1. Ves los pedidos del dia: `!pedidos`
2. Cargas el tracking: `!tracking 5491155551234 OC123456789AR`
3. El cliente recibe su codigo automaticamente
4. Verificas el estado del bot: `!status`

---

## Reglas importantes

- **El numero de alerta puede cambiar** cuando se agrega o elimina una alerta. Siempre usa `!alertas` si no estas seguro.
- **Sin numero = la mas reciente.** Si escribis solo "ok" sin numero, aplica a la alerta mas nueva.
- **"Me encargo" pausa el bot.** Usa `!despauser` para reactivarlo cuando termines.
- **Podes mandar audios.** El bot los transcribe y los interpreta como texto.
- **Maximo 50 alertas.** Las mas viejas se eliminan automaticamente.

---

## Referencia rapida

```
ALERTAS:
  !alertas              Ver cola de alertas
  1 ok                  Confirmar pedido #1
  2 me encargo          Tomar control de #2
  1 [instruccion]       Mandar mensaje IA a #1

CLIENTES:
  !pausados             Ver clientes pausados
  !despauser [tel]      Reactivar bot para cliente
  !reset [tel]          Reiniciar estado de cliente
  !historial [tel]      Resumen IA del chat
  !enviar [tel] [msg]   Mensaje directo

PEDIDOS:
  !pedidos              Ultimos pedidos
  !pedido [tel]         Pedidos de un cliente
  !tracking [tel] [cod] Cargar codigo seguimiento

SISTEMA:
  !status               Estado del bot
  !stats                Ventas del dia
  !precios              Ver precios
  !pausa-global on/off  Pausar/reanudar todo
  !script [version]     Ver o cambiar script
  !admin add/remove     Gestionar admins
  !resumen              Reporte diario
  !ayuda                Menu de comandos
```
