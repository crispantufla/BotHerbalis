# Manual de Alertas para Vendedores

## Como funciona

Cuando un cliente completa un pedido, el bot te envia una **alerta** por WhatsApp con todos los datos. Cada alerta tiene un **numero** (#1, #2, #3...) que la identifica.

Si llegan varios pedidos al mismo tiempo, cada uno tiene su propio numero y podes responder a cada uno por separado.

---

## Formato de la alerta

Cuando llega un pedido, recibis un mensaje asi:

```
ALERTA #1 (2 activas)

Motivo: Pedido Requiere Aprobacion
Cliente: Juan (5491155551234)
Producto: Kit Herbalis (30 dias) - $15000
Direccion: Av. Corrientes 1234, CABA, CP 1043

Detalles: Cliente confirmo pedido

Responde: "1 ok" para confirmar, "1 me encargo" para intervenir, "!alertas" para ver todas
```

---

## Comandos disponibles

### Confirmar un pedido

Para aprobar el pedido de un cliente especifico, manda el **numero de alerta + ok**:

| Escribis | Que hace |
|----------|----------|
| `1 ok` | Confirma el pedido de la alerta #1 |
| `2 ok` | Confirma el pedido de la alerta #2 |
| `1 dale` | Igual que "1 ok" |
| `1 si` | Igual que "1 ok" |
| `1 confirmar` | Igual que "1 ok" |

Si solo hay **una alerta activa**, podes escribir simplemente:

| Escribis | Que hace |
|----------|----------|
| `ok` | Confirma la alerta mas reciente |
| `dale` | Igual que "ok" |
| `si` | Igual que "ok" |
| `confirmar` | Igual que "ok" |

El cliente recibe un mensaje de confirmacion con los datos de su pedido.

---

### Tomar control de un cliente ("Me encargo")

Si necesitas hablarle personalmente al cliente y que el bot no interfiera:

| Escribis | Que hace |
|----------|----------|
| `1 me encargo` | Pausa el bot para el cliente #1 y lo atendes vos |
| `2 me encargo` | Pausa el bot para el cliente #2 |
| `me encargo` | Pausa el bot para la alerta mas reciente |
| `1 intervenir` | Igual que "1 me encargo" |

Cuando usas "me encargo", el bot se **pausa** para ese cliente. Podes hablarle directamente sin que el bot responda.

---

### Ver todas las alertas activas

| Escribis | Que hace |
|----------|----------|
| `!alertas` | Muestra la lista de alertas pendientes |

Respuesta ejemplo:

```
Alertas activas (3):

#1 -- Juan (5491155551234) -- Kit Herbalis -- hace 2 min
#2 -- Maria (5491166662345) -- Pack Premium -- hace 30 seg
#3 -- Carlos (5491177773456) -- Kit Basico -- hace 10 seg

Responde con el # + comando, ej: "1 ok", "2 me encargo"
```

---

### Enviar instruccion personalizada por IA

Si queres que el bot le mande un mensaje especifico a un cliente (generado por IA):

| Escribis | Que hace |
|----------|----------|
| `1 decile que el envio tarda 48hs` | La IA genera un mensaje para el cliente #1 |
| `2 preguntale si prefiere otro producto` | La IA genera un mensaje para el cliente #2 |
| `decile que lo llamamos manana` | Manda al cliente de la alerta mas reciente |

El bot interpreta tu instruccion, genera un mensaje apropiado y se lo envia al cliente.

---

### Otros comandos utiles

| Escribis | Que hace |
|----------|----------|
| `!ayuda` | Muestra el menu de comandos |
| `!resumen` | Reporte de ventas del dia |
| `!saltear 5491155551234` | Fuerza a un usuario al paso de datos |

---

## Ejemplo paso a paso: 2 alertas al mismo tiempo

**Situacion:** Llegan dos pedidos casi juntos.

1. Recibis:
   ```
   ALERTA #1 (1 activas)
   Cliente: Juan (5491155551234)
   Producto: Kit Herbalis (30 dias) - $15000
   ```

2. Inmediatamente recibis:
   ```
   ALERTA #1 (2 activas)
   Cliente: Maria (5491166662345)
   Producto: Pack Premium (60 dias) - $25000
   ```
   (Maria es ahora #1 porque es la mas reciente, Juan paso a #2)

3. Queres confirmar a Juan y hablar con Maria personalmente:
   - Mandas: `2 ok` (confirma a Juan)
   - Mandas: `1 me encargo` (tomas control de Maria)

4. Queres ver si queda algo pendiente:
   - Mandas: `!alertas`
   - Respuesta: "No hay alertas activas" (o te muestra las que queden)

---

## Ejemplo: Pedir mas informacion sobre una alerta

Si necesitas que el bot le pregunte algo al cliente antes de confirmar:

1. Recibis alerta #1 de Juan pero no estas seguro del pedido
2. Mandas: `1 preguntale si esta seguro del plan de 30 dias`
3. El bot genera un mensaje y se lo envia a Juan
4. Cuando Juan responde, el bot sigue el flujo normal

---

## Reglas importantes

- **El numero de alerta puede cambiar** cuando se agrega o elimina una alerta. Siempre usa `!alertas` si no estas seguro.
- **Sin numero = la mas reciente.** Si escribis solo "ok" sin numero, aplica a la alerta mas nueva.
- **"Me encargo" pausa el bot.** El cliente no va a recibir respuestas automaticas hasta que el bot se reactive.
- **Podes mandar audios.** El bot los transcribe y los interpreta como texto, asi que podes decir "uno ok" y funciona.
- **Maximo 50 alertas.** Las mas viejas se eliminan automaticamente.

---

## Resumen rapido

```
!alertas         --> Ver cola de alertas
1 ok             --> Confirmar pedido #1
2 me encargo     --> Tomar control de #2
1 [instruccion]  --> Mandar mensaje IA a #1
ok               --> Confirmar la mas reciente
!ayuda           --> Menu de comandos
!resumen         --> Reporte del dia
```
