import React, { useState } from 'react';
import { BookOpen, ChevronRight, AlertTriangle, CheckCircle, Hand, List, Sparkles, Terminal, HelpCircle, Zap, Users, Package, BarChart3, Settings, Send, Shield, Eye, Trash2, MousePointerClick, MessageCircle, ShoppingCart, CreditCard, FileText, ImageIcon, Bell, PauseCircle, PlayCircle, RotateCcw, TrendingUp, Filter, Edit2, ChevronLeft } from 'lucide-react';
import { Card, Button, Badge, cn } from '../ui';

// ─── Manual data ────────────────────────────────────────────────
const MANUALS = [
    {
        id: 'comandos',
        title: 'Comandos WhatsApp',
        description: 'Guia completa para controlar el bot desde WhatsApp. Alertas, pedidos, clientes, tracking, estadisticas y configuracion.',
        icon: Terminal,
        color: 'indigo',
        sections: [
            {
                title: 'Como funciona',
                icon: HelpCircle,
                content: `Podes controlar **todo el bot** desde WhatsApp. Cada comando empieza con **!** y podes mandarlo como texto o audio.\n\nCuando llegan alertas de pedidos, cada una tiene un **numero** (#1, #2, #3...). Para responder a una especifica, ponele el numero adelante: **1 ok**, **2 me encargo**.`
            },
            {
                title: 'Confirmar un pedido',
                icon: CheckCircle,
                content: `Manda el **numero de alerta + ok** para aprobar.`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['1 ok', 'Confirma el pedido de la alerta #1'],
                        ['2 ok', 'Confirma la alerta #2'],
                        ['1 dale / 1 si', 'Igual que "1 ok"'],
                        ['ok', 'Confirma la alerta mas reciente'],
                    ]
                },
            },
            {
                title: 'Tomar control ("Me encargo")',
                icon: Hand,
                content: `Pausa el bot para un cliente y lo atendes vos directamente.`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['1 me encargo', 'Pausa el bot para cliente #1'],
                        ['me encargo', 'Pausa la alerta mas reciente'],
                    ]
                },
                extra: `Cuando termines, usa **!despauser [tel]** para reactivar el bot.`
            },
            {
                title: 'Alertas activas',
                icon: List,
                content: `Manda **!alertas** para ver la cola numerada.`,
                codeBlock: `Alertas activas (3):\n\n#1 -- Juan (5491155551234) -- Kit Herbalis -- hace 2 min\n#2 -- Maria (5491166662345) -- Pack Premium -- hace 30 seg\n#3 -- Carlos (5491177773456) -- Kit Basico -- hace 10 seg`
            },
            {
                title: 'Respuestas rapidas contextuales',
                icon: Zap,
                content: `Cada alerta incluye **3 respuestas rapidas** sugeridas segun el contexto. El bot analiza el paso del cliente y su ultimo mensaje para sugerir las mejores respuestas.`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['1r1', 'Envia respuesta rapida 1 al cliente de alerta #1'],
                        ['1r2', 'Envia respuesta rapida 2 al cliente de alerta #1'],
                        ['2r3', 'Envia respuesta rapida 3 al cliente de alerta #2'],
                        ['r1', 'Envia respuesta rapida 1 a la alerta mas reciente'],
                    ]
                },
                extra: `Las sugerencias cambian segun: **paso del cliente** (datos, precio, confirmacion) y **lo que escribio** (dudas, desconfianza, rechazo).`
            },
            {
                title: 'Instrucciones por IA',
                icon: Sparkles,
                content: `El bot genera un mensaje a partir de tu instruccion y se lo envia al cliente.`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['1 decile que el envio tarda 48hs', 'Mensaje IA para cliente #1'],
                        ['2 preguntale si prefiere otro', 'Mensaje IA para cliente #2'],
                    ]
                },
            },
            {
                title: 'Gestion de clientes',
                icon: Users,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['!pausados', 'Ver clientes con el bot pausado'],
                        ['!despauser [tel]', 'Reactivar el bot para un cliente'],
                        ['!reset [tel]', 'Reiniciar estado de un cliente'],
                        ['!historial [tel]', 'Resumen IA de la conversacion'],
                        ['!enviar [tel] [msg]', 'Mensaje directo sin IA'],
                    ]
                },
            },
            {
                title: 'Pedidos y tracking',
                icon: Package,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['!pedidos', 'Ultimos 5 pedidos de todos'],
                        ['!pedido [tel]', 'Pedidos de un cliente'],
                        ['!tracking [tel] [cod]', 'Cargar codigo de seguimiento y avisar al cliente'],
                    ]
                },
                extra: `**!tracking** envia automaticamente el codigo al cliente por WhatsApp.`
            },
            {
                title: 'Estado y estadisticas',
                icon: BarChart3,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['!status', 'Conexion, memoria, sesiones, alertas'],
                        ['!stats', 'Ventas del dia, revenue, conversion'],
                        ['!precios', 'Precios actuales de todos los productos'],
                        ['!resumen', 'Reporte diario completo'],
                    ]
                },
            },
            {
                title: 'Analytics y funnel',
                icon: BarChart3,
                content: `Visualiza el embudo de ventas y analiza abandonos con testing A/B automatico.`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['!funnel', 'Embudo paso a paso con tasas de abandono'],
                        ['!abandonos', 'Motivos de abandono + rendimiento A/B de mensajes de seguimiento'],
                    ]
                },
                extra: `El sistema envia automaticamente mensajes de re-engagement probando diferentes variantes. Con **!abandonos** ves cual funciona mejor.`
            },
            {
                title: 'Configuracion del bot',
                icon: Settings,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['!pausa-global on/off', 'Pausar o reanudar todo el bot'],
                        ['!script', 'Ver script activo y disponibles'],
                        ['!script v3', 'Cambiar a script v3'],
                        ['!admin list', 'Ver numeros que reciben alertas'],
                        ['!admin add [tel]', 'Agregar numero a alertas'],
                        ['!admin remove [tel]', 'Quitar numero de alertas'],
                    ]
                },
            },
            {
                title: 'Ejemplo: 2 alertas + tracking',
                icon: Zap,
                steps: [
                    { label: 'Llegan 2 alertas', detail: 'Juan (#2) y Maria (#1, mas reciente)' },
                    { label: 'Confirmas a Juan', detail: 'Mandas: 2 ok' },
                    { label: 'Tomas control de Maria', detail: 'Mandas: 1 me encargo' },
                    { label: 'Le hablas a Maria directo', detail: 'Conversas por WhatsApp normal' },
                    { label: 'Reactivas el bot', detail: 'Mandas: !despauser 5491166662345' },
                    { label: 'Cargas tracking de Juan', detail: 'Mandas: !tracking 5491155551234 OC123AR' },
                    { label: 'Verificas todo', detail: 'Mandas: !status' },
                ],
            },
            {
                title: 'Reglas importantes',
                icon: AlertTriangle,
                bullets: [
                    'El numero de alerta puede cambiar. Usa !alertas para verificar.',
                    'Sin numero = la mas reciente.',
                    '"Me encargo" pausa el bot. Usa !despauser para reactivar.',
                    'Podes mandar audios. Se transcriben automaticamente.',
                    '!pausa-global detiene el bot para TODOS los clientes.',
                    'Maximo 50 alertas activas.',
                ],
            },
        ],
        quickRef: [
            { cmd: '!alertas', desc: 'Cola de alertas' },
            { cmd: '1 ok', desc: 'Confirmar #1' },
            { cmd: '1 me encargo', desc: 'Tomar control #1' },
            { cmd: '1r1 / 1r2 / 1r3', desc: 'Respuesta rapida a #1' },
            { cmd: '!pausados', desc: 'Clientes pausados' },
            { cmd: '!despauser [tel]', desc: 'Reactivar cliente' },
            { cmd: '!pedidos', desc: 'Ultimos pedidos' },
            { cmd: '!tracking [tel] [cod]', desc: 'Cargar tracking' },
            { cmd: '!funnel', desc: 'Embudo de ventas' },
            { cmd: '!abandonos', desc: 'Abandonos + A/B' },
            { cmd: '!status', desc: 'Estado del bot' },
            { cmd: '!stats', desc: 'Ventas del dia' },
            { cmd: '!precios', desc: 'Ver precios' },
            { cmd: '!pausa-global', desc: 'Pausar todo' },
            { cmd: '!enviar [tel] [msg]', desc: 'Mensaje directo' },
            { cmd: '!historial [tel]', desc: 'Resumen IA' },
            { cmd: '!reset [tel]', desc: 'Reiniciar cliente' },
            { cmd: '!script', desc: 'Ver/cambiar script' },
            { cmd: '!admin list', desc: 'Ver admins' },
            { cmd: '!resumen', desc: 'Reporte diario' },
            { cmd: '!ayuda', desc: 'Menu de comandos' },
        ],
    },
    {
        id: 'panel-alertas',
        title: 'Panel Principal & Alertas',
        description: 'Como leer el estado del bot, gestionar alertas de pedidos y entender los indicadores del panel de inicio.',
        icon: Bell,
        color: 'indigo',
        sections: [
            {
                title: '¿Qué muestra el panel?',
                icon: HelpCircle,
                content: `El panel de inicio es tu vista general del negocio en tiempo real. Tiene 4 bloques principales:\n\n- **Estado del sistema** — si el bot está conectado o no\n- **Alertas activas** — pedidos que esperan tu atención\n- **Clientes esperando** — usuarios con el bot pausado\n- **Estadísticas del día** — ventas, ingresos y conversiones`,
            },
            {
                title: 'Indicador de estado (ONLINE / OFFLINE)',
                icon: CheckCircle,
                content: `En la barra superior hay un punto de color con el texto **ONLINE** o **OFFLINE**.\n\n- 🟢 **ONLINE** — el bot está conectado y funcionando\n- 🔴 **OFFLINE** — el bot se desconectó, nadie está siendo atendido\n\nSi aparece OFFLINE, revisá la sección **Configuración** → Estado del Sistema para ver el motivo. Normalmente se resuelve solo en unos minutos.`,
            },
            {
                title: 'Alertas: qué son y cómo funcionan',
                icon: AlertTriangle,
                content: `Las alertas aparecen cuando el bot **necesita tu intervención** en una conversación. Tipos más comunes:`,
                table: {
                    headers: ['Tipo de alerta', 'Qué significa'],
                    rows: [
                        ['Pedido listo para confirmar', 'El cliente completó todos sus datos y espera confirmación'],
                        ['Cliente con dudas', 'El bot detectó resistencia o preguntas que no pudo resolver'],
                        ['Dirección problemática', 'El bot no pudo validar la dirección del cliente'],
                        ['Modo noche', 'Un mensaje llegó fuera del horario de atención'],
                    ]
                },
            },
            {
                title: 'Acciones rápidas desde una alerta',
                icon: Zap,
                steps: [
                    { label: 'Confirmar pedido', detail: 'Click en el botón verde "Confirmar" — el bot cierra la venta automáticamente.' },
                    { label: 'Ir al chat', detail: 'Click en el ícono de chat — te lleva directamente a la conversación.' },
                    { label: 'Descartar', detail: 'Click en la X roja — elimina la alerta sin hacer nada (el bot sigue activo).' },
                ],
                extra: `También podés gestionar alertas desde WhatsApp con los comandos **1 ok**, **1 me encargo**, etc. Ver manual "Comandos WhatsApp".`
            },
            {
                title: 'Clientes esperando',
                icon: Users,
                content: `El bloque **"Clientes Esperando"** muestra usuarios que tienen el bot **pausado manualmente**.\n\nEsto pasa cuando:\n- Vos pausaste el bot desde el chat para atenderlos\n- El bot se pausó automáticamente por una situación especial\n\nPara reactivar el bot a un cliente, andá al chat y clickeá el botón naranja/verde de pausa.`,
            },
            {
                title: 'Notificaciones (campana)',
                icon: Bell,
                content: `El ícono de campana en la barra superior muestra las alertas pendientes. El número en rojo indica cuántas hay.\n\nClickeá la campana para ver el listado sin salir del panel. Clickeá una alerta para ir directo al chat del cliente.`,
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Las alertas nuevas suenan en tiempo real — el número en la campana se actualiza automáticamente.',
                    'Confirmar un pedido desde el panel tiene el mismo efecto que confirmar por WhatsApp.',
                    'Descartar una alerta NO pausa ni afecta al cliente, solo limpia tu lista.',
                    'Si el bot dice OFFLINE más de 5 minutos, revisá Configuración → Estado del Sistema.',
                ],
            },
        ],
    },
    {
        id: 'chat-atencion',
        title: 'Chat & Atención',
        description: 'Como leer conversaciones, pausar/reactivar el bot, enviar mensajes manuales, reiniciar chats y usar el resumen de IA.',
        icon: MessageCircle,
        color: 'indigo',
        sections: [
            {
                title: 'Navegación de la pantalla',
                icon: HelpCircle,
                content: `La pantalla de Chat tiene dos paneles:\n\n- **Izquierda** — lista de todos los chats activos con indicadores de estado\n- **Derecha** — la conversación seleccionada con los botones de control`,
                table: {
                    headers: ['Indicador', 'Significado'],
                    rows: [
                        ['Punto rojo parpadeando', 'Alerta activa — requiere tu atención'],
                        ['Punto naranja', 'Bot pausado para ese cliente'],
                        ['Badge "Cliente"', 'Ya compró antes (cliente recurrente)'],
                        ['Número en gris', 'Mensajes sin leer'],
                    ]
                },
            },
            {
                title: 'Pausar y reactivar el bot',
                icon: PauseCircle,
                content: `En la barra superior del chat abierto hay un botón naranja/verde:`,
                steps: [
                    { label: 'Bot activo (botón naranja)', detail: 'Clickealo para pausarlo. El bot deja de responder a ese cliente.' },
                    { label: 'Bot pausado (botón verde)', detail: 'Clickealo para reactivarlo. El bot retoma la conversación.' },
                ],
                extra: `Cuando pausás el bot, el cliente queda en tu lista de "Clientes Esperando" del panel principal. Recordá siempre reactivarlo cuando terminés.`
            },
            {
                title: 'Enviar mensajes manuales',
                icon: Send,
                content: `Con el bot pausado (o activo), podés escribir en la caja de texto abajo y enviar mensajes directamente.\n\n**El bot se pausa automáticamente** cuando enviás un mensaje manual, para que no se pisen las respuestas.`,
                steps: [
                    { label: 'Escribí tu mensaje en la caja de texto', detail: 'En la parte inferior del chat.' },
                    { label: 'Presioná Enter o el botón de enviar', detail: 'El mensaje se envía como si fuera el bot.' },
                    { label: 'Reactivá el bot cuando termines', detail: 'Con el botón verde de la barra superior.' },
                ],
            },
            {
                title: 'Enviar imágenes',
                icon: ImageIcon,
                content: `Podés enviar imágenes directamente desde el panel. Clickeá el ícono de imagen en la barra de mensajes, seleccioná el archivo y opcionalmente agregá un texto.`,
                extra: `Las imágenes de la galería también se pueden enviar desde la sección **Galería de Medios**.`
            },
            {
                title: 'Reiniciar un chat',
                icon: RotateCcw,
                content: `El botón rojo de la papelera/reset en la barra superior **borra el historial y reinicia el estado** del cliente. Usalo cuando:\n\n- El cliente quiere empezar desde cero\n- Hubo un error grave en el flujo\n- Querés que el bot lo salude de nuevo`,
                extra: `⚠️ Esta acción es irreversible. El historial de WhatsApp y la memoria del bot se pierden.`
            },
            {
                title: 'Resumen inteligente (IA)',
                icon: Sparkles,
                content: `El botón azul con el ícono de rayo genera un **resumen de la conversación** usando IA. En segundos te muestra:\n\n- Qué quiere el cliente\n- En qué paso del proceso está\n- Si hay algún bloqueo o duda pendiente\n\nÚtil para ponerse al día rápido sin leer todo el historial.`,
            },
            {
                title: 'Ver historial de compras',
                icon: ShoppingCart,
                content: `El ícono de carrito en la barra superior muestra todos los pedidos anteriores del cliente:\n\n- Producto, plan y precio de cada compra\n- Estado del envío y tracking\n- Fecha de cada pedido`,
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Pausar el bot no notifica al cliente — la conversación queda igual para él.',
                    'Siempre reactivá el bot cuando termines de atender manualmente.',
                    'El resumen IA toma los últimos 50 mensajes del chat.',
                    'Reiniciar el chat no cancela pedidos ya registrados en la base de datos.',
                ],
            },
        ],
    },
    {
        id: 'ventas-logistica',
        title: 'Ventas & Logística',
        description: 'Como ver y filtrar pedidos, cambiar estados y cargar tracking.',
        icon: ShoppingCart,
        color: 'indigo',
        sections: [
            {
                title: '¿Qué muestra esta sección?',
                icon: HelpCircle,
                content: `La sección **Ventas & Logística** lista todos los pedidos registrados por el bot y el panel. Desde acá podés ver el estado de cada venta, actualizar datos y gestionar envíos.`,
            },
            {
                title: 'Estados de un pedido',
                icon: Package,
                table: {
                    headers: ['Estado', 'Significado'],
                    rows: [
                        ['Pendiente', 'El bot tomó los datos pero aún no fue confirmado'],
                        ['Confirmado', 'Aprobado — a preparar el paquete'],
                        ['En sistema', 'Ingresado al sistema de despacho'],
                        ['Enviado', 'Despachado con número de tracking'],
                        ['Entregado', 'El cliente recibió el paquete'],
                        ['Cancelado', 'Venta cancelada'],
                    ]
                },
            },
            {
                title: 'Filtrar y buscar pedidos',
                icon: Filter,
                content: `Usá la barra de búsqueda y los filtros de la parte superior para encontrar pedidos rápido.`,
                table: {
                    headers: ['Filtro', 'Para qué sirve'],
                    rows: [
                        ['Barra de búsqueda', 'Buscar por nombre, teléfono o código de tracking'],
                        ['Filtro de estado', 'Ver solo "Enviados", "Pendientes", etc.'],
                        ['Filtro de vendedor', 'Ver pedidos de un número de WhatsApp específico'],
                    ]
                },
            },
            {
                title: 'Cambiar el estado de un pedido',
                icon: Edit2,
                steps: [
                    { label: 'Buscá el pedido en la lista', detail: 'Usá la barra de búsqueda o filtrá por estado.' },
                    { label: 'Click en el ícono de edición (lápiz)', detail: 'Aparece un panel de edición.' },
                    { label: 'Seleccioná el nuevo estado', detail: 'Usá el selector desplegable.' },
                    { label: 'Guardá los cambios', detail: 'Click en "Guardar".' },
                ],
            },
            {
                title: 'Cargar número de tracking',
                icon: Package,
                steps: [
                    { label: 'Abrí el pedido (ícono de lápiz)', detail: 'En la fila del pedido.' },
                    { label: 'Ingresá el código de tracking', detail: 'En el campo "Tracking".' },
                    { label: 'Guardá', detail: 'El cliente recibe automáticamente un WhatsApp con el código.' },
                ],
                extra: `También podés cargar tracking por WhatsApp con **!tracking [tel] [codigo]**.`
            },
            {
                title: 'Ir al chat desde un pedido',
                icon: MessageCircle,
                content: `En cada pedido hay un botón de chat que te lleva directo a la conversación de ese cliente en la sección **Chat & Atención**.`,
            },
        ],
    },
    {
        id: 'pagos-mp',
        title: 'Pagos MercadoPago',
        description: 'Como generar links de pago, enviárselos a clientes, verificar el estado y entender los plazos de acreditación.',
        icon: CreditCard,
        color: 'amber',
        sections: [
            {
                title: '¿Para qué sirve esta sección?',
                icon: HelpCircle,
                content: `La sección **Pagos MP** te permite generar links de pago de MercadoPago y enviárselos a clientes que quieran pagar por adelantado.\n\nTodos los pagos se rastrean automáticamente — el sistema revisa cada 5 minutos si fueron pagados y actualiza el estado.`,
            },
            {
                title: 'Generar un link de pago',
                icon: CreditCard,
                steps: [
                    { label: 'Click en "Nuevo Link de Pago"', detail: 'Botón morado en la parte superior.' },
                    { label: 'Ingresá el monto', detail: 'En pesos argentinos, sin puntos ni comas.' },
                    { label: 'Ingresá el teléfono del cliente (opcional)', detail: 'Para poder ir al chat desde el listado.' },
                    { label: 'Click en "Generar"', detail: 'El link se crea en MercadoPago y aparece en la lista.' },
                ],
            },
            {
                title: 'Enviar el link al cliente',
                icon: Send,
                steps: [
                    { label: 'Encontrá el pago en la lista', detail: 'Aparece inmediatamente tras generarlo.' },
                    { label: 'Click en el ícono de copiar', detail: 'Copia el link al portapapeles.' },
                    { label: 'Pegalo en el chat del cliente', detail: 'Desde la sección Chat & Atención o WhatsApp directo.' },
                ],
                extra: `También podés hacer click en el ícono externo para abrirlo en MercadoPago y verificar los detalles.`
            },
            {
                title: 'Estados de un pago',
                icon: CheckCircle,
                table: {
                    headers: ['Estado', 'Significado'],
                    rows: [
                        ['Pendiente', 'El link fue creado pero el cliente aún no pagó'],
                        ['Aprobado', 'El pago fue acreditado exitosamente'],
                        ['Rechazado', 'El pago fue rechazado por MercadoPago'],
                        ['Expirado', 'El link venció sin ser usado'],
                    ]
                },
            },
            {
                title: 'Verificar si ya pagó',
                icon: Eye,
                content: `El sistema actualiza los estados automáticamente cada **5 minutos** de 9 a 23hs.\n\nSi necesitás verificar inmediatamente, clickeá el ícono de **recargar** en la fila del pago. También podés usar el botón **"Actualizar todos"** para refrescar todos los pendientes de una vez.`,
            },
            {
                title: 'Plazos de acreditación',
                icon: AlertTriangle,
                content: `El dinero no se acredita en tu cuenta al instante. MercadoPago tiene plazos según la comisión elegida:\n\n- **Inmediato** — comisión más alta (~6.29% + IVA)\n- **14 días** — comisión media\n- **35 días** — comisión más baja (~1.49% + IVA)\n\nEsto se configura en tu cuenta de MercadoPago en **Tu negocio → Costos y cuotas**, no desde el sistema.`,
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Cada link es de un solo uso — si el cliente necesita pagar de nuevo, generá uno nuevo.',
                    'Los links de MercadoPago vencen a los 30 días si no se usan.',
                    'El estado "Aprobado" no significa que el dinero está en tu cuenta — depende del plazo de acreditación configurado.',
                    'Si un pago figura como Pendiente pero el cliente dice que pagó, usá el botón de recarga individual.',
                ],
            },
        ],
    },
    {
        id: 'guion-prompts',
        title: 'Guión & Prompts',
        description: 'Como ver y editar el guion del bot, cambiar entre versiones y gestionar las respuestas frecuentes (FAQ).',
        icon: FileText,
        color: 'indigo',
        sections: [
            {
                title: '¿Qué es el guión?',
                icon: HelpCircle,
                content: `El **guión** es el texto que le dice a la IA cómo comportarse en cada paso de la conversación. Define:\n\n- Qué decir en el saludo inicial\n- Cómo preguntar el peso del cliente\n- Cómo presentar los planes y precios\n- Cómo manejar objeciones y cerrar la venta`,
            },
            {
                title: 'Versiones del guión',
                icon: List,
                content: `Hay múltiples versiones del guión (v3, v4, v5). Cada una tiene un enfoque distinto:`,
                table: {
                    headers: ['Versión', 'Enfoque'],
                    rows: [
                        ['v3', 'Guión original — flujo clásico de ventas, pago contra reembolso'],
                        ['v4', 'Variante mejorada — mismo flujo con copy optimizado'],
                        ['v5 (MP First)', 'Prioriza el pago con MercadoPago antes que el contra reembolso'],
                    ]
                },
                extra: `La versión activa tiene un punto verde parpadeante al lado. Solo una versión puede estar activa a la vez.`
            },
            {
                title: 'Cambiar la versión activa',
                icon: Zap,
                steps: [
                    { label: 'Clickeá en el nombre de la versión', detail: 'En la barra superior (ej: "V3", "V4", "V5").' },
                    { label: 'Confirmá el cambio', detail: 'El bot empieza a usar la nueva versión en todas las conversaciones nuevas.' },
                ],
                extra: `Las conversaciones en curso no se ven afectadas — siguen con el guión asignado al inicio.`
            },
            {
                title: 'Editar el guión (pestaña "Flujo")',
                icon: FileText,
                steps: [
                    { label: 'Seleccioná la versión a editar', detail: 'Con los botones V3, V4, V5 de la barra.' },
                    { label: 'Andá a la pestaña "Flujo"', detail: 'Muestra cada paso de la conversación.' },
                    { label: 'Editá el texto del paso que querés cambiar', detail: 'El campo de texto es editable directamente.' },
                    { label: 'Click en "Guardar Cambios"', detail: 'Los cambios se aplican al instante.' },
                ],
                extra: `⚠️ Cambiá una cosa a la vez y probá antes de guardar. Un error en el guión puede romper el flujo de ventas.`
            },
            {
                title: 'Editar FAQ (respuestas frecuentes)',
                icon: HelpCircle,
                content: `La pestaña **"FAQ"** contiene respuestas a preguntas frecuentes que el bot detecta por palabras clave (ej: "garantía", "muestras", "devolución").\n\nPodés:\n- Editar la respuesta de una pregunta existente\n- Agregar nuevas palabras clave a una pregunta\n- Eliminar una pregunta completa`,
            },
            {
                title: 'Mapa del guión',
                icon: Eye,
                content: `La pestaña **"Mapa"** muestra visualmente el flujo completo de la conversación: desde el saludo hasta el cierre. Útil para entender en qué punto está cada cliente y cuál es el camino esperado.`,
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Siempre guardá los cambios antes de cambiar de versión — se perderán si no.',
                    'Probá los cambios mandando un mensaje de prueba al bot antes de dejarlo con clientes reales.',
                    'Si algo se rompe, recargá el guión con el botón de recarga — restaura la última versión guardada.',
                    'Cambios en el guión no afectan conversaciones ya iniciadas, solo las nuevas.',
                ],
            },
        ],
    },
    {
        id: 'estadisticas',
        title: 'Estadísticas',
        description: 'Como leer el embudo de ventas, métricas de conversión, actividad por hora y rendimiento de anuncios.',
        icon: BarChart3,
        color: 'indigo',
        sections: [
            {
                title: '¿Qué muestra esta sección?',
                icon: HelpCircle,
                content: `La sección de **Estadísticas** muestra el rendimiento histórico del bot en 4 áreas:\n\n- **Embudo de ventas** — cuántos clientes avanzan en cada paso\n- **Actividad por hora** — cuándo se generan más ventas\n- **Origen de clientes** — si vienen de anuncios o tráfico orgánico\n- **Tendencias diarias** — evolución de ventas y revenue`,
            },
            {
                title: 'Embudo de ventas',
                icon: TrendingUp,
                content: `El embudo muestra cuántos usuarios llegan a cada paso del flujo:\n\n**Saludo → Peso → Preferencia → Plan → Datos → Confirmación → Completado**\n\nLa diferencia entre pasos es el **abandono**. Si hay mucho abandono entre "Plan" y "Datos", por ejemplo, el problema está en ese paso del guión.`,
                table: {
                    headers: ['Paso', 'Alta tasa de abandono significa...'],
                    rows: [
                        ['Saludo → Peso', 'El saludo no engancha o el cliente no está interesado'],
                        ['Plan → Datos', 'El precio o las opciones generan dudas'],
                        ['Datos → Confirmación', 'Problemas con la dirección o el cliente se arrepiente'],
                    ]
                },
            },
            {
                title: 'Actividad por hora',
                icon: BarChart3,
                content: `El gráfico de barras muestra **en qué horarios se cierran más ventas**.\n\nUsá este dato para:\n- Saber cuándo estar más atento a las alertas\n- Planificar el horario de tus anuncios\n- Entender si hay horas muertas donde conviene ajustar el bot`,
            },
            {
                title: 'Origen de clientes (anuncios)',
                icon: Zap,
                content: `Si usás anuncios de Click-to-WhatsApp, el sistema detecta automáticamente si el cliente viene de un anuncio o de forma orgánica.\n\nVes el rendimiento de cada fuente:\n- Cuántos iniciaron conversación\n- Cuántos llegaron hasta la confirmación\n- Tasa de conversión por fuente`,
                extra: `Si no ves datos de anuncios, verificá que los mensajes pre-llenados de tus anuncios coincidan con los configurados en el sistema.`
            },
            {
                title: 'Métricas clave a monitorear',
                icon: CheckCircle,
                table: {
                    headers: ['Métrica', 'Qué indica', 'Señal de alerta'],
                    rows: [
                        ['Tasa de conversión', '% de chats que terminan en venta', 'Menor al 5%'],
                        ['Abandono en datos', '% que no completa la dirección', 'Mayor al 40%'],
                        ['Revenue del día', 'Total facturado', 'Caída brusca respecto al día anterior'],
                    ]
                },
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Las estadísticas se calculan sobre el período visible — por defecto los últimos 7 días.',
                    'Un día con 0 ventas puede indicar un problema en el bot, no necesariamente poca demanda.',
                    'El embudo solo cuenta conversaciones del bot activo — las atendidas manualmente no se contabilizan.',
                    'Los datos se actualizan diariamente a las 4am hora Argentina.',
                ],
            },
        ],
    },
    {
        id: 'galeria',
        title: 'Galería de Medios',
        description: 'Como subir, organizar y enviar imágenes desde el panel.',
        icon: ImageIcon,
        color: 'indigo',
        sections: [
            {
                title: '¿Para qué sirve la galería?',
                icon: HelpCircle,
                content: `La **Galería de Medios** almacena imágenes que el bot puede enviar automáticamente o que vos enviás manualmente desde el chat.\n\nIdeal para:\n- Fotos del producto\n- Imágenes de resultados de clientes\n- Flyers de promociones`,
            },
            {
                title: 'Subir una imagen',
                icon: ImageIcon,
                steps: [
                    { label: 'Ir a "Galería de Medios"', detail: 'En el menú lateral, ícono de imagen.' },
                    { label: 'Click en "Subir imagen"', detail: 'Se abre el selector de archivo.' },
                    { label: 'Seleccioná el archivo', detail: 'Formatos soportados: JPG, PNG, WebP.' },
                    { label: 'Esperá la confirmación', detail: 'La imagen aparece en la galería.' },
                ],
            },
            {
                title: 'Enviar una imagen a un cliente',
                icon: Send,
                steps: [
                    { label: 'Andá a la galería y copiá el nombre de la imagen', detail: 'O recordá su nombre.' },
                    { label: 'Abrí el chat del cliente en "Chat & Atención"', detail: 'Buscá al cliente.' },
                    { label: 'Usá el ícono de imagen en la barra de mensajes', detail: 'También podés arrastrar y soltar.' },
                ],
            },
            {
                title: 'Eliminar una imagen',
                icon: Trash2,
                content: `Clickeá el ícono de basura sobre la imagen. Esta acción es irreversible — si el bot estaba usando esa imagen en el guión, puede dejar de funcionar correctamente.`,
                extra: `Antes de eliminar, verificá que la imagen no esté referenciada en el guión del bot.`
            },
        ],
    },
    {
        id: 'configuracion',
        title: 'Configuración',
        description: 'Como agregar números de alerta, pausar el bot globalmente y monitorear el estado del sistema.',
        icon: Settings,
        color: 'indigo',
        sections: [
            {
                title: '¿Qué se configura acá?',
                icon: HelpCircle,
                content: `La sección **Configuración** tiene tres bloques:\n\n- **Números de alerta** — quiénes reciben las alertas de pedidos por WhatsApp\n- **Estado del sistema** — memoria, conexiones y salud del bot\n- **Pausa global** — detener el bot para todos los clientes`,
            },
            {
                title: 'Agregar un número de alerta',
                icon: Bell,
                steps: [
                    { label: 'Ir a Configuración', detail: 'En el menú lateral, ícono de engranaje.' },
                    { label: 'Sección "Números de Alerta"', detail: 'Muestra los números que reciben alertas.' },
                    { label: 'Ingresá el número completo', detail: 'Con código de país, sin espacios (ej: 5491155551234).' },
                    { label: 'Click en "Agregar"', detail: 'El número empieza a recibir alertas de inmediato.' },
                ],
                extra: `También podés hacerlo por WhatsApp con **!admin add 5491155551234**.`
            },
            {
                title: 'Quitar un número de alerta',
                icon: Trash2,
                content: `En la lista de números de alerta, clickeá la X al lado del número que querés eliminar. Ese número dejará de recibir alertas.\n\n⚠️ Asegurate de que siempre haya al menos un número activo, o los pedidos no se notificarán.`,
            },
            {
                title: 'Pausa global del bot',
                icon: PauseCircle,
                content: `La **pausa global** detiene el bot para **todos** los clientes al mismo tiempo. Usala cuando:\n\n- Necesitás hacer mantenimiento\n- Hay un problema con los precios o el stock\n- El equipo no puede atender alertas por un período`,
                steps: [
                    { label: 'Activar pausa global', detail: 'Click en "Pausar Todo" en Configuración. O mandá !pausa-global on por WhatsApp.' },
                    { label: 'Desactivar pausa global', detail: 'Click en "Reanudar" o mandá !pausa-global off.' },
                ],
                extra: `⚠️ Durante la pausa global, los clientes que escriban no reciben respuesta. Avisales si va a ser prolongada.`
            },
            {
                title: 'Estado del sistema',
                icon: BarChart3,
                content: `El bloque de estado muestra la salud del bot en tiempo real:`,
                table: {
                    headers: ['Indicador', 'Qué significa'],
                    rows: [
                        ['Usuarios en RAM', 'Conversaciones activas en memoria (normal: < 200)'],
                        ['Base de Datos', 'Total de clientes históricos'],
                        ['Heap Usada', 'Memoria del servidor (alerta si supera 500 MB)'],
                        ['Activos Ahora', 'Clientes con conversación en curso'],
                    ]
                },
                extra: `Si el heap supera 500 MB de forma sostenida, el bot puede volverse lento. Contactá soporte técnico.`
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Siempre dejá al menos un número de alerta activo.',
                    'La pausa global afecta a todos los clientes, incluso los que están en medio de una compra.',
                    'Cambios en la configuración se aplican en tiempo real, sin necesidad de reiniciar.',
                    'El número de alerta debe ser el mismo que tiene la cuenta de WhatsApp del administrador.',
                ],
            },
        ],
    },
    {
        id: 'reporte-ia',
        title: 'Reportar Error de IA',
        description: 'Como marcar una respuesta incorrecta del bot, guardar el contexto y leer los reportes desde el panel.',
        icon: AlertTriangle,
        color: 'amber',
        sections: [
            {
                title: '¿Para que sirve?',
                icon: HelpCircle,
                content: `Cuando el bot responde algo **incorrecto, confuso o fuera de contexto**, podés reportarlo en segundos.\n\nEl reporte guarda la conversacion completa y tu correccion en la base de datos. Desde la seccion **"Errores de IA"** del panel podes leerlos todos y usarlos para mejorar el guion del bot.`,
            },
            {
                title: 'Paso 1: Abrí el chat',
                icon: MousePointerClick,
                content: `Anda a la seccion **Chat & Atencion** y abri la conversacion donde el bot se equivoco.`,
                steps: [
                    { label: 'Ir a "Chat & Atencion"', detail: 'En el menu lateral, segundo icono.' },
                    { label: 'Buscar al cliente', detail: 'Por nombre o numero de telefono.' },
                    { label: 'Abrir la conversacion', detail: 'Hacer click en el chat.' },
                ],
            },
            {
                title: 'Paso 2: Marcar el mensaje erróneo',
                icon: AlertTriangle,
                content: `Posate sobre el **mensaje del bot** que esta mal. Aparece un boton naranja con el texto **"Reportar Error de IA"**.`,
                steps: [
                    { label: 'Pasar el mouse sobre el mensaje', detail: 'El mensaje del bot se resalta.' },
                    { label: 'Click en "Reportar Error de IA"', detail: 'Se abre el modal de reporte.' },
                ],
                extra: `El boton solo aparece en mensajes del **bot** (burbuja derecha/violeta), no en los del cliente.`
            },
            {
                title: 'Paso 3: Completar el reporte',
                icon: Send,
                content: `El modal muestra las **ultimas 4 mensajes** del chat con el erroneo resaltado en rojo.\n\nPodés cargar más contexto con el botón **"Cargar más"** si necesitas mostrar más antecedentes.`,
                steps: [
                    { label: 'Revisar el contexto', detail: 'Las burbujas muestran quien dijo que. La roja es el mensaje erroneo.' },
                    { label: 'Cargar mas contexto (opcional)', detail: 'Click en "Cargar mas" para ver mensajes anteriores.' },
                    { label: 'Escribir la correccion', detail: 'Explicar que hizo mal o que deberia haber respondido.' },
                    { label: 'Click en "Guardar Reporte"', detail: 'Se guarda en la base de datos y aparece confirmacion.' },
                ],
            },
            {
                title: 'Ejemplo de buena corrección',
                icon: CheckCircle,
                content: `Al escribir la correccion, cuanto mas especifica mejor. Algunos ejemplos:`,
                table: {
                    headers: ['Mala correccion', 'Buena correccion'],
                    rows: [
                        ['Esta mal', 'Asumio que no teniamos stock de capsulas de 60 dias, pero si tenemos. Deberia haber ofrecido ese plan.'],
                        ['No debio decir eso', 'La cliente dijo que esta amamantando. El bot igual intento venderle. Deberia haber cerrado la conversacion.'],
                        ['Respuesta incorrecta', 'Confundio "Nuez de Brasil" con "Nuez de la India". Son productos distintos. Deberia haber aclarado la diferencia.'],
                    ]
                },
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Reporta solo mensajes del bot, no respuestas del cliente.',
                    'Sé especifico en la correccion: que estuvo mal y que deberia haber dicho.',
                    'Podes cargar hasta la conversacion entera con "Cargar mas".',
                    'Los reportes quedan guardados permanentemente hasta que los borres.',
                    'Usa los reportes para actualizar el guion del bot en la seccion "Guion & Prompts".',
                ],
            },
        ],
    },
];

// ─── Sub-components ─────────────────────────────────────────────

// Renderiza texto con **negrita** inline (preservamos el formato del array
// MANUALS que ya usaba markdown-style emphasis).
function Bold({ text }) {
    if (!text) return null;
    const parts = text.split(/\*\*(.*?)\*\*/g);
    return parts.map((part, i) =>
        i % 2 === 1
            ? <strong key={i} className="font-semibold text-slate-900 dark:text-slate-100">{part}</strong>
            : part
    );
}

function SectionCard({ section }) {
    const Icon = section.icon;
    return (
        <Card padding="md" interactive>
            <div className="flex items-center gap-2.5 mb-3">
                <div className="w-8 h-8 rounded-control bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400 flex items-center justify-center">
                    <Icon className="w-4 h-4" aria-hidden="true" />
                </div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{section.title}</h3>
            </div>

            {section.content && (
                <p className="text-sm text-slate-600 dark:text-slate-300 mb-3 leading-relaxed whitespace-pre-line">
                    <Bold text={section.content} />
                </p>
            )}

            {section.codeBlock && (
                <pre className="bg-slate-900 text-emerald-400 text-xs rounded-control p-3 mb-3 overflow-x-auto font-mono leading-relaxed">
                    {section.codeBlock}
                </pre>
            )}

            {section.table && (
                <div className="overflow-x-auto mb-3 rounded-control border border-slate-200 dark:border-slate-700">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 dark:bg-slate-800/40">
                            <tr>
                                {section.table.headers.map((h, i) => (
                                    <th key={i} className="text-left py-2 px-3 text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {section.table.rows.map((row, ri) => (
                                <tr key={ri}>
                                    <td className="py-2 px-3">
                                        <code className="bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300 px-1.5 py-0.5 rounded text-xs font-mono">
                                            {row[0]}
                                        </code>
                                    </td>
                                    <td className="py-2 px-3 text-slate-600 dark:text-slate-300 text-xs">
                                        {row[1]}
                                    </td>
                                    {row[2] && (
                                        <td className="py-2 px-3 text-slate-600 dark:text-slate-300 text-xs">
                                            {row[2]}
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {section.steps && (
                <ol className="space-y-2">
                    {section.steps.map((step, si) => (
                        <li key={si} className="flex gap-3">
                            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent-100 dark:bg-accent-900/40 text-accent-600 dark:text-accent-400 flex items-center justify-center text-xs font-semibold tabular-nums">
                                {si + 1}
                            </span>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{step.label}</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">{step.detail}</p>
                            </div>
                        </li>
                    ))}
                </ol>
            )}

            {section.bullets && (
                <ul className="space-y-1.5">
                    {section.bullets.map((b, bi) => (
                        <li key={bi} className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
                            <ChevronRight className="w-4 h-4 text-accent-500 dark:text-accent-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
                            <span>{b}</span>
                        </li>
                    ))}
                </ul>
            )}

            {section.extra && (
                <p className="text-xs text-slate-500 dark:text-slate-400 italic mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                    <Bold text={section.extra} />
                </p>
            )}
        </Card>
    );
}

// ─── Main Component ─────────────────────────────────────────────

const ManualsView = () => {
    const [activeManual, setActiveManual] = useState(null);

    if (activeManual) {
        const manual = MANUALS.find(m => m.id === activeManual);
        if (!manual) return null;
        const Icon = manual.icon;

        return (
            <div className="max-w-5xl mx-auto w-full space-y-5">
                <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={ChevronLeft}
                    onClick={() => setActiveManual(null)}
                >
                    Volver a manuales
                </Button>

                <header className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-card bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400 flex items-center justify-center flex-shrink-0">
                        <Icon className="w-5 h-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-h2 text-slate-900 dark:text-slate-100">{manual.title}</h1>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{manual.description}</p>
                    </div>
                </header>

                {manual.quickRef && (
                    <Card padding="md">
                        <h2 className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3">
                            Referencia rápida
                        </h2>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                            {manual.quickRef.map((ref, i) => (
                                <div key={i} className="flex items-center gap-2 min-w-0">
                                    <code className="bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300 px-1.5 py-0.5 rounded text-[11px] font-mono flex-shrink-0">
                                        {ref.cmd}
                                    </code>
                                    <span className="text-xs text-slate-600 dark:text-slate-400 truncate">{ref.desc}</span>
                                </div>
                            ))}
                        </div>
                    </Card>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    {manual.sections.map((section, i) => (
                        <SectionCard key={i} section={section} />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-5xl mx-auto w-full space-y-4">
            <header>
                <h1 className="text-display text-slate-900 dark:text-slate-100">Manuales</h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                    Guías de uso del sistema para el equipo de ventas.
                </p>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {MANUALS.map((manual) => {
                    const Icon = manual.icon;
                    return (
                        <button
                            key={manual.id}
                            type="button"
                            onClick={() => setActiveManual(manual.id)}
                            className={cn(
                                'group text-left rounded-card bg-white dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/70',
                                'shadow-card p-5 transition-all duration-200 hover:shadow-card-hover hover:border-accent-300 dark:hover:border-accent-700',
                                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500'
                            )}
                        >
                            <div className="w-11 h-11 rounded-card bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400 flex items-center justify-center mb-3 transition-transform group-hover:scale-[1.05]">
                                <Icon className="w-5 h-5" aria-hidden="true" />
                            </div>
                            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">{manual.title}</h3>
                            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{manual.description}</p>
                            <div className="flex items-center gap-1 text-accent-600 dark:text-accent-400 text-xs font-medium mt-3 group-hover:gap-1.5 transition-all">
                                Ver manual <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

export default ManualsView;
