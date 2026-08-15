import React, { useState } from 'react';
import { BookOpen, ChevronRight, AlertTriangle, CheckCircle, Hand, List, Sparkles, Terminal, HelpCircle, Zap, Users, Package, BarChart3, Settings, Send, Shield, Eye, Trash2, MousePointerClick, MessageCircle, ShoppingCart, CreditCard, FileText, ImageIcon, Bell, PauseCircle, PlayCircle, RotateCcw, TrendingUp, Filter, Edit2, ChevronLeft } from 'lucide-react';
import { Card, Button, Badge, cn } from '../ui';

// ─── Manual data ────────────────────────────────────────────────
const MANUALS = [
    {
        id: 'comandos',
        title: 'Comandos WhatsApp',
        description: 'Guía completa para controlar el bot desde WhatsApp. Alertas, pedidos, clientes, seguimiento, estadísticas y configuración.',
        icon: Terminal,
        color: 'indigo',
        sections: [
            {
                title: 'Cómo funciona',
                icon: HelpCircle,
                content: `Puedes controlar **todo el bot** desde WhatsApp. Cada comando empieza con **!** y puedes mandarlo como texto o como audio.\n\nCuando llegan alertas de pedidos, cada una tiene un **número** (#1, #2, #3...). Para responder a una en concreto, ponle el número delante: **1 ok**, **2 me encargo**.`
            },
            {
                title: 'Confirmar un pedido',
                icon: CheckCircle,
                content: `Manda el **número de alerta + ok** para aprobarlo.`,
                table: {
                    headers: ['Escribes', 'Qué hace'],
                    rows: [
                        ['1 ok', 'Confirma el pedido de la alerta #1'],
                        ['2 ok', 'Confirma la alerta #2'],
                        ['1 si / 1 confirmar', 'Igual que "1 ok"'],
                        ['ok', 'Confirma la alerta más reciente'],
                    ]
                },
            },
            {
                title: 'Tomar el control ("Me encargo")',
                icon: Hand,
                content: `Pausa el bot para un cliente y lo atiendes tú directamente.`,
                table: {
                    headers: ['Escribes', 'Qué hace'],
                    rows: [
                        ['1 me encargo', 'Pausa el bot para el cliente #1'],
                        ['me encargo', 'Pausa la alerta más reciente'],
                    ]
                },
                extra: `Cuando termines, usa **!despauser [tel]** para reactivar el bot.`
            },
            {
                title: 'Alertas activas',
                icon: List,
                content: `Manda **!alertas** para ver la cola numerada.`,
                codeBlock: `Alertas activas (3):\n\n#1 -- Juan (34612345678) -- Cápsulas 120 días -- hace 2 min\n#2 -- María (34622334455) -- Gotas 60 días -- hace 30 seg\n#3 -- Carlos (34655667788) -- Semillas 120 días -- hace 10 seg`
            },
            {
                title: 'Respuestas rápidas contextuales',
                icon: Zap,
                content: `Cada alerta incluye **3 respuestas rápidas** sugeridas según el contexto. El bot analiza el paso en el que está el cliente y su último mensaje para sugerir las mejores respuestas.`,
                table: {
                    headers: ['Escribes', 'Qué hace'],
                    rows: [
                        ['1r1', 'Envía la respuesta rápida 1 al cliente de la alerta #1'],
                        ['1r2', 'Envía la respuesta rápida 2 al cliente de la alerta #1'],
                        ['2r3', 'Envía la respuesta rápida 3 al cliente de la alerta #2'],
                        ['r1', 'Envía la respuesta rápida 1 a la alerta más reciente'],
                    ]
                },
                extra: `Las sugerencias cambian según: **el paso del cliente** (datos, precio, confirmación) y **lo que ha escrito** (dudas, desconfianza, rechazo).`
            },
            {
                title: 'Instrucciones por IA',
                icon: Sparkles,
                content: `El bot genera un mensaje a partir de tu instrucción y se lo envía al cliente.`,
                table: {
                    headers: ['Escribes', 'Qué hace'],
                    rows: [
                        ['1 dile que el envío tarda 3 a 5 días laborables', 'Mensaje IA para el cliente #1'],
                        ['2 pregúntale si prefiere otro formato', 'Mensaje IA para el cliente #2'],
                    ]
                },
            },
            {
                title: 'Gestión de clientes',
                icon: Users,
                table: {
                    headers: ['Escribes', 'Qué hace'],
                    rows: [
                        ['!pausados', 'Ver los clientes con el bot pausado'],
                        ['!despauser [tel]', 'Reactivar el bot para un cliente'],
                        ['!reset [tel]', 'Reiniciar el estado de un cliente'],
                        ['!historial [tel]', 'Resumen IA de la conversación'],
                        ['!enviar [tel] [msg]', 'Mensaje directo sin IA'],
                    ]
                },
            },
            {
                title: 'Pedidos y seguimiento',
                icon: Package,
                table: {
                    headers: ['Escribes', 'Qué hace'],
                    rows: [
                        ['!pedidos', 'Últimos 5 pedidos de todos'],
                        ['!pedido [tel]', 'Pedidos de un cliente'],
                        ['!tracking [tel] [cod]', 'Cargar el localizador de Correos y avisar al cliente'],
                    ]
                },
                extra: `**!tracking** envía automáticamente el localizador al cliente por WhatsApp.`
            },
            {
                title: 'Estado y estadísticas',
                icon: BarChart3,
                table: {
                    headers: ['Escribes', 'Qué hace'],
                    rows: [
                        ['!status', 'Conexión, memoria, sesiones, alertas'],
                        ['!stats', 'Ventas del día, ingresos, conversión'],
                        ['!precios', 'Precios actuales de todos los productos'],
                        ['!resumen', 'Informe diario completo'],
                    ]
                },
            },
            {
                title: 'Analítica y embudo',
                icon: BarChart3,
                content: `Muestra el embudo de ventas y analiza los abandonos con test A/B automático.`,
                table: {
                    headers: ['Escribes', 'Qué hace'],
                    rows: [
                        ['!funnel', 'Embudo paso a paso con tasas de abandono'],
                        ['!abandonos', 'Motivos de abandono + rendimiento A/B de los mensajes de seguimiento'],
                    ]
                },
                extra: `El sistema envía automáticamente mensajes de recuperación probando distintas variantes. Con **!abandonos** ves cuál funciona mejor.`
            },
            {
                title: 'Configuración del bot',
                icon: Settings,
                table: {
                    headers: ['Escribes', 'Qué hace'],
                    rows: [
                        ['!pausa-global on/off', 'Pausar o reanudar todo el bot'],
                        ['!script', 'Ver el guion activo y los disponibles'],
                        ['!script v7', 'Cambiar al guion v7 (hoy es el único)'],
                        ['!admin list', 'Ver los números que reciben alertas'],
                        ['!admin add [tel]', 'Añadir un número a las alertas'],
                        ['!admin remove [tel]', 'Quitar un número de las alertas'],
                    ]
                },
            },
            {
                title: 'Ejemplo: 2 alertas + seguimiento',
                icon: Zap,
                steps: [
                    { label: 'Llegan 2 alertas', detail: 'Juan (#2) y María (#1, la más reciente)' },
                    { label: 'Confirmas a Juan', detail: 'Mandas: 2 ok' },
                    { label: 'Tomas el control de María', detail: 'Mandas: 1 me encargo' },
                    { label: 'Hablas con María directamente', detail: 'Conversas por WhatsApp normal' },
                    { label: 'Reactivas el bot', detail: 'Mandas: !despauser 34622334455' },
                    { label: 'Cargas el seguimiento de Juan', detail: 'Mandas: !tracking 34612345678 PQ1234567890ES' },
                    { label: 'Lo compruebas todo', detail: 'Mandas: !status' },
                ],
            },
            {
                title: 'Reglas importantes',
                icon: AlertTriangle,
                bullets: [
                    'El número de alerta puede cambiar. Usa !alertas para comprobarlo.',
                    'Sin número = la más reciente.',
                    '"Me encargo" pausa el bot. Usa !despauser para reactivarlo.',
                    'Puedes mandar audios. Se transcriben automáticamente.',
                    '!pausa-global detiene el bot para TODOS los clientes.',
                    'Máximo 50 alertas activas.',
                ],
            },
        ],
        quickRef: [
            { cmd: '!alertas', desc: 'Cola de alertas' },
            { cmd: '1 ok', desc: 'Confirmar #1' },
            { cmd: '1 me encargo', desc: 'Tomar el control de #1' },
            { cmd: '1r1 / 1r2 / 1r3', desc: 'Respuesta rápida a #1' },
            { cmd: '!pausados', desc: 'Clientes pausados' },
            { cmd: '!despauser [tel]', desc: 'Reactivar cliente' },
            { cmd: '!pedidos', desc: 'Últimos pedidos' },
            { cmd: '!tracking [tel] [cod]', desc: 'Cargar seguimiento' },
            { cmd: '!funnel', desc: 'Embudo de ventas' },
            { cmd: '!abandonos', desc: 'Abandonos + A/B' },
            { cmd: '!status', desc: 'Estado del bot' },
            { cmd: '!stats', desc: 'Ventas del día' },
            { cmd: '!precios', desc: 'Ver precios' },
            { cmd: '!pausa-global', desc: 'Pausar todo' },
            { cmd: '!enviar [tel] [msg]', desc: 'Mensaje directo' },
            { cmd: '!historial [tel]', desc: 'Resumen IA' },
            { cmd: '!reset [tel]', desc: 'Reiniciar cliente' },
            { cmd: '!script', desc: 'Ver/cambiar guion' },
            { cmd: '!admin list', desc: 'Ver admins' },
            { cmd: '!resumen', desc: 'Informe diario' },
            { cmd: '!ayuda', desc: 'Menú de comandos' },
        ],
    },
    {
        id: 'panel-alertas',
        title: 'Panel Principal & Alertas',
        description: 'Cómo leer el estado del bot, gestionar las alertas de pedidos y entender los indicadores del panel de inicio.',
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
                content: `En la barra superior hay un punto de color con el texto **ONLINE** o **OFFLINE**.\n\n- 🟢 **ONLINE** — el bot está conectado y funcionando\n- 🔴 **OFFLINE** — el bot se ha desconectado, no se está atendiendo a nadie\n\nSi aparece OFFLINE, revisa la sección **Configuración** → Estado del Sistema para ver el motivo. Normalmente se resuelve solo en unos minutos.`,
            },
            {
                title: 'Alertas: qué son y cómo funcionan',
                icon: AlertTriangle,
                content: `Las alertas aparecen cuando el bot **necesita tu intervención** en una conversación. Tipos más comunes:`,
                table: {
                    headers: ['Tipo de alerta', 'Qué significa'],
                    rows: [
                        ['Pedido listo para confirmar', 'El cliente ha completado todos sus datos y espera la confirmación'],
                        ['Cliente con dudas', 'El bot ha detectado resistencia o preguntas que no ha sabido resolver'],
                        ['Dirección problemática', 'El bot no ha podido validar la dirección del cliente'],
                        ['Modo noche', 'Ha llegado un mensaje fuera del horario de atención'],
                    ]
                },
            },
            {
                title: 'Acciones rápidas desde una alerta',
                icon: Zap,
                steps: [
                    { label: 'Confirmar pedido', detail: 'Haz clic en el botón verde "Confirmar" — el bot cierra la venta automáticamente.' },
                    { label: 'Ir al chat', detail: 'Haz clic en el icono de chat — te lleva directamente a la conversación.' },
                    { label: 'Descartar', detail: 'Haz clic en la X roja — elimina la alerta sin hacer nada (el bot sigue activo).' },
                ],
                extra: `También puedes gestionar las alertas desde WhatsApp con los comandos **1 ok**, **1 me encargo**, etc. Ver el manual "Comandos WhatsApp".`
            },
            {
                title: 'Clientes esperando',
                icon: Users,
                content: `El bloque **"Clientes Esperando"** muestra los usuarios que tienen el bot **pausado manualmente**.\n\nEsto pasa cuando:\n- Has pausado el bot desde el chat para atenderlos tú\n- El bot se ha pausado automáticamente por una situación especial\n\nPara reactivar el bot a un cliente, ve al chat y pulsa el botón naranja/verde de pausa.`,
            },
            {
                title: 'Notificaciones (campana)',
                icon: Bell,
                content: `El icono de campana de la barra superior muestra las alertas pendientes. El número en rojo indica cuántas hay.\n\nPulsa la campana para ver el listado sin salir del panel. Pulsa una alerta para ir directo al chat del cliente.`,
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Las alertas nuevas suenan en tiempo real — el número de la campana se actualiza automáticamente.',
                    'Confirmar un pedido desde el panel tiene el mismo efecto que confirmarlo por WhatsApp.',
                    'Descartar una alerta NO pausa ni afecta al cliente, solo limpia tu lista.',
                    'Si el bot lleva más de 5 minutos en OFFLINE, revisa Configuración → Estado del Sistema.',
                ],
            },
        ],
    },
    {
        id: 'chat-atencion',
        title: 'Chat & Atención',
        description: 'Cómo leer las conversaciones, pausar o reactivar el bot, enviar mensajes manuales, reiniciar chats y usar el resumen de IA.',
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
                        ['Etiqueta "Cliente"', 'Ya ha comprado antes (cliente recurrente)'],
                        ['Número en gris', 'Mensajes sin leer'],
                    ]
                },
            },
            {
                title: 'Pausar y reactivar el bot',
                icon: PauseCircle,
                content: `En la barra superior del chat abierto hay un botón naranja/verde:`,
                steps: [
                    { label: 'Bot activo (botón naranja)', detail: 'Púlsalo para pausarlo. El bot deja de responder a ese cliente.' },
                    { label: 'Bot pausado (botón verde)', detail: 'Púlsalo para reactivarlo. El bot retoma la conversación.' },
                ],
                extra: `Cuando pausas el bot, el cliente aparece en la lista de "Clientes Esperando" del panel principal. Acuérdate de reactivarlo siempre que termines.`
            },
            {
                title: 'Enviar mensajes manuales',
                icon: Send,
                content: `Con el bot pausado (o activo), puedes escribir en el cuadro de texto de abajo y enviar mensajes directamente.\n\n**El bot se pausa automáticamente** cuando envías un mensaje manual, para que no se pisen las respuestas.`,
                steps: [
                    { label: 'Escribe tu mensaje en el cuadro de texto', detail: 'En la parte inferior del chat.' },
                    { label: 'Pulsa Intro o el botón de enviar', detail: 'El mensaje se envía como si fuera el bot.' },
                    { label: 'Reactiva el bot cuando termines', detail: 'Con el botón verde de la barra superior.' },
                ],
            },
            {
                title: 'Enviar imágenes',
                icon: ImageIcon,
                content: `Puedes enviar imágenes directamente desde el panel. Pulsa el icono de imagen de la barra de mensajes, elige el archivo y, si quieres, añade un texto.`,
                extra: `Las imágenes de la galería también se pueden enviar desde la sección **Galería de Medios**.`
            },
            {
                title: 'Reiniciar un chat',
                icon: RotateCcw,
                content: `El botón rojo de la papelera/reinicio de la barra superior **borra el historial y reinicia el estado** del cliente. Úsalo cuando:\n\n- El cliente quiere empezar desde cero\n- Ha habido un error grave en el flujo\n- Quieres que el bot lo salude de nuevo`,
                extra: `⚠️ Esta acción es irreversible. El historial de WhatsApp y la memoria del bot se pierden.`
            },
            {
                title: 'Resumen inteligente (IA)',
                icon: Sparkles,
                content: `El botón azul con el icono de rayo genera un **resumen de la conversación** con IA. En segundos te muestra:\n\n- Qué quiere el cliente\n- En qué paso del proceso está\n- Si hay algún bloqueo o duda pendiente\n\nÚtil para ponerte al día rápido sin leer todo el historial.`,
            },
            {
                title: 'Ver el historial de compras',
                icon: ShoppingCart,
                content: `El icono del carrito de la barra superior muestra todos los pedidos anteriores del cliente:\n\n- Producto, plan y precio de cada compra\n- Estado del envío y localizador de Correos\n- Fecha de cada pedido`,
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Pausar el bot no avisa al cliente — la conversación se ve igual desde su lado.',
                    'Reactiva siempre el bot cuando termines de atender a mano.',
                    'El resumen de IA coge los últimos 50 mensajes del chat.',
                    'Reiniciar el chat no cancela los pedidos ya registrados en la base de datos.',
                ],
            },
        ],
    },
    {
        id: 'ventas-logistica',
        title: 'Ventas & Logística',
        description: 'Cómo ver y filtrar pedidos, cambiar estados y cargar el localizador de Correos.',
        icon: ShoppingCart,
        color: 'indigo',
        sections: [
            {
                title: '¿Qué muestra esta sección?',
                icon: HelpCircle,
                content: `La sección **Ventas & Logística** lista todos los pedidos registrados por el bot y por el panel. Desde aquí puedes ver el estado de cada venta, actualizar datos y gestionar los envíos.`,
            },
            {
                title: 'Estados de un pedido',
                icon: Package,
                table: {
                    headers: ['Estado', 'Significado'],
                    rows: [
                        ['Pendiente', 'El bot ha cogido los datos pero todavía no está confirmado'],
                        ['Confirmado', 'Aprobado — a preparar el paquete'],
                        ['En sistema', 'Dado de alta en el sistema de envíos de Correos'],
                        ['Enviado', 'Entregado a Correos, con localizador'],
                        ['Entregado', 'El cliente ha recibido el paquete y lo ha pagado'],
                        ['Cancelado', 'Venta cancelada'],
                    ]
                },
                extra: `Todos los pedidos son **contra reembolso**: el cliente paga cuando recibe el paquete, así que "Entregado" es también el momento del cobro.`
            },
            {
                title: 'Filtrar y buscar pedidos',
                icon: Filter,
                content: `Usa la barra de búsqueda y los filtros de la parte superior para encontrar pedidos rápido.`,
                table: {
                    headers: ['Filtro', 'Para qué sirve'],
                    rows: [
                        ['Barra de búsqueda', 'Buscar por nombre, teléfono o localizador de envío'],
                        ['Filtro de estado', 'Ver solo "Enviados", "Pendientes", etc.'],
                        ['Filtro de vendedor', 'Ver los pedidos de un número de WhatsApp concreto'],
                    ]
                },
            },
            {
                title: 'Cambiar el estado de un pedido',
                icon: Edit2,
                steps: [
                    { label: 'Busca el pedido en la lista', detail: 'Usa la barra de búsqueda o filtra por estado.' },
                    { label: 'Haz clic en el icono de edición (lápiz)', detail: 'Aparece un panel de edición.' },
                    { label: 'Elige el nuevo estado', detail: 'Con el desplegable.' },
                    { label: 'Guarda los cambios', detail: 'Haz clic en "Guardar".' },
                ],
            },
            {
                title: 'Cargar el localizador de Correos',
                icon: Package,
                steps: [
                    { label: 'Abre el pedido (icono de lápiz)', detail: 'En la fila del pedido.' },
                    { label: 'Escribe el localizador del envío', detail: 'En el campo "Tracking".' },
                    { label: 'Guarda', detail: 'El cliente recibe automáticamente un WhatsApp con el localizador.' },
                ],
                extra: `También puedes cargarlo por WhatsApp con **!tracking [tel] [localizador]**.`
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
        title: 'Cobro contra reembolso',
        description: 'Cómo se cobra aquí: el cliente paga al recibir el pedido. Dónde paga, cómo se sigue el cobro y qué no hay que pedirle nunca.',
        icon: CreditCard,
        color: 'amber',
        sections: [
            {
                title: '¿Cómo se cobra?',
                icon: HelpCircle,
                content: `Todas las ventas son **contra reembolso**: el cliente **no paga nada por adelantado**. Paga el importe completo cuando recibe el paquete.\n\nNo hay pago con tarjeta, ni enlaces de pago, ni transferencias, ni señas ni anticipos. El bot no los ofrece y el cliente no los espera.`,
            },
            {
                title: 'Dónde paga el cliente',
                icon: Package,
                table: {
                    headers: ['Dónde', 'Cómo paga'],
                    rows: [
                        ['En casa', 'Le paga al repartidor de Correos cuando le entrega el paquete'],
                        ['En su oficina de Correos', 'Si no estaba en casa, recoge el paquete y lo paga allí'],
                    ]
                },
                extra: `El envío es **gratis** y tarda de **3 a 5 días laborables**. El cliente solo paga el precio del producto, sin gastos añadidos.`
            },
            {
                title: 'Dónde se sigue el cobro',
                icon: Eye,
                content: `No hay una pantalla de pagos aparte: el cobro va pegado al pedido. Lo sigues desde **Ventas & Logística**, mirando el estado de cada pedido y su localizador de Correos.`,
                extra: `Con el localizador puedes comprobar la entrega en la web de Correos. Entregado = cobrado.`
            },
            {
                title: 'Qué significa cada estado para el cobro',
                icon: CheckCircle,
                table: {
                    headers: ['Estado del pedido', 'Qué significa para el dinero'],
                    rows: [
                        ['Pendiente', 'Todavía no hay nada que cobrar — falta confirmarlo'],
                        ['Confirmado', 'A preparar el paquete. Sigue sin haber cobro'],
                        ['Enviado', 'En camino con Correos, pendiente de cobro'],
                        ['Entregado', 'El cliente ha recibido el paquete y lo ha pagado'],
                        ['Cancelado', 'No se cobra nada'],
                    ]
                },
            },
            {
                title: 'Cuándo llega el dinero',
                icon: AlertTriangle,
                content: `El repartidor cobra al cliente, pero el dinero no aparece en tu cuenta el mismo día: Correos ingresa el importe de los reembolsos al remitente unos días después de la entrega, según las condiciones de tu contrato de reembolso.\n\nPor eso un pedido puede figurar como **Entregado** antes de que veas el ingreso en el banco. Los plazos y las comisiones se consultan con Correos, no desde este panel.`,
            },
            {
                title: 'Si el cliente quiere pagar antes',
                icon: Send,
                content: `Pasa a menudo, y la respuesta es siempre la misma: **no hace falta**. Se paga al recibir, y eso juega a favor — el cliente no arriesga nada.\n\nNunca le des un número de cuenta ni le pidas una transferencia, aunque insista: no hay forma de cuadrar ese dinero con el pedido y el paquete se envía igual contra reembolso.`,
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'El cliente no paga nada por adelantado: paga el importe completo al recibir el paquete.',
                    'No pidas nunca tarjeta, transferencia, señas ni anticipos.',
                    'Los importes van en euros (ej.: 51,90 €). El precio que ve el cliente es el que paga al repartidor.',
                    'Confirma la dirección y el teléfono antes de dar el pedido por bueno: un dato mal cogido es un paquete devuelto.',
                    'Si el cliente no está en casa, Correos le deja aviso y puede recogerlo y pagarlo en su oficina.',
                    'Un pedido no está cobrado hasta que figura como "Entregado".',
                ],
            },
        ],
    },
    {
        id: 'guion-prompts',
        title: 'Guion & Prompts',
        description: 'Cómo ver y editar el guion del bot, cambiar de versión y gestionar las respuestas frecuentes (FAQ).',
        icon: FileText,
        color: 'indigo',
        sections: [
            {
                title: '¿Qué es el guion?',
                icon: HelpCircle,
                content: `El **guion** es el texto que le dice a la IA cómo comportarse en cada paso de la conversación. Define:\n\n- Qué decir en el saludo inicial\n- Cómo preguntar qué tipo de plan busca el cliente\n- Cómo presentar los planes y precios\n- Cómo manejar objeciones y cerrar la venta`,
            },
            {
                title: 'Versiones del guion',
                icon: List,
                content: `Hoy solo hay **una versión viva, la v7**. Las anteriores se archivaron y ya no se usan:`,
                table: {
                    headers: ['Versión', 'Enfoque'],
                    rows: [
                        ['v7 (activa)', 'Persona Elena. Dos tramos (rutina corta / plan completo) y todo contra reembolso'],
                        ['v3 – v6', 'Archivadas — guiones antiguos, ya no se pueden asignar'],
                    ]
                },
                extra: `La versión activa tiene un punto verde parpadeante al lado. Solo una versión puede estar activa a la vez.`
            },
            {
                title: 'Cambiar la versión activa',
                icon: Zap,
                steps: [
                    { label: 'Pulsa el nombre de la versión', detail: 'En la barra superior (hoy solo aparece "V7").' },
                    { label: 'Confirma el cambio', detail: 'El bot empieza a usar la nueva versión en todas las conversaciones nuevas.' },
                ],
                extra: `Las conversaciones en curso no se ven afectadas — siguen con el guion que tenían asignado al empezar.`
            },
            {
                title: 'Editar el guion (pestaña "Flujo")',
                icon: FileText,
                steps: [
                    { label: 'Selecciona la versión a editar', detail: 'Con los botones de versión de la barra (hoy solo V7).' },
                    { label: 'Ve a la pestaña "Flujo"', detail: 'Muestra cada paso de la conversación.' },
                    { label: 'Edita el texto del paso que quieras cambiar', detail: 'El campo de texto se edita directamente.' },
                    { label: 'Pulsa "Guardar Cambios"', detail: 'Los cambios se aplican al instante.' },
                ],
                extra: `⚠️ Cambia una cosa cada vez y pruébala antes de guardar. Un error en el guion puede romper el flujo de ventas. Los precios no se tocan aquí: el bot los coge de la lista de precios.`
            },
            {
                title: 'Editar FAQ (respuestas frecuentes)',
                icon: HelpCircle,
                content: `La pestaña **"FAQ"** contiene respuestas a preguntas frecuentes que el bot detecta por palabras clave (ej.: "garantía", "muestras", "devolución").\n\nPuedes:\n- Editar la respuesta de una pregunta existente\n- Añadir nuevas palabras clave a una pregunta\n- Eliminar una pregunta entera`,
            },
            {
                title: 'Mapa del guion',
                icon: Eye,
                content: `La pestaña **"Mapa"** muestra visualmente el flujo completo de la conversación: desde el saludo hasta el cierre. Útil para entender en qué punto está cada cliente y cuál es el camino esperado.`,
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Guarda siempre los cambios antes de cambiar de versión — si no, se pierden.',
                    'Prueba los cambios mandándole un mensaje al bot antes de dejarlo con clientes reales.',
                    'Si algo se rompe, recarga el guion con el botón de recarga — restaura la última versión guardada.',
                    'Los cambios en el guion no afectan a las conversaciones ya empezadas, solo a las nuevas.',
                ],
            },
        ],
    },
    {
        id: 'estadisticas',
        title: 'Estadísticas',
        description: 'Cómo leer el embudo de ventas, las métricas de conversión, la actividad por hora y el rendimiento de los anuncios.',
        icon: BarChart3,
        color: 'indigo',
        sections: [
            {
                title: '¿Qué muestra esta sección?',
                icon: HelpCircle,
                content: `La sección de **Estadísticas** muestra el rendimiento histórico del bot en 4 áreas:\n\n- **Embudo de ventas** — cuántos clientes avanzan en cada paso\n- **Actividad por hora** — cuándo se generan más ventas\n- **Origen de clientes** — si vienen de anuncios o tráfico orgánico\n- **Tendencias diarias** — evolución de ventas e ingresos`,
            },
            {
                title: 'Embudo de ventas',
                icon: TrendingUp,
                content: `El embudo muestra cuántos usuarios llegan a cada paso del flujo:\n\n**Saludo → Peso → Preferencia → Plan → Datos → Confirmación → Completado**\n\nLa diferencia entre pasos es el **abandono**. Si hay mucho abandono entre "Plan" y "Datos", por ejemplo, el problema está en ese paso del guion.`,
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
                content: `El gráfico de barras muestra **a qué horas se cierran más ventas**.\n\nUsa este dato para:\n- Saber cuándo estar más atento a las alertas\n- Planificar el horario de tus anuncios\n- Ver si hay horas muertas en las que conviene ajustar el bot`,
            },
            {
                title: 'Origen de clientes (anuncios)',
                icon: Zap,
                content: `Si usas anuncios de Click-to-WhatsApp, el sistema detecta automáticamente si el cliente viene de un anuncio o de forma orgánica.\n\nVes el rendimiento de cada fuente:\n- Cuántos han iniciado conversación\n- Cuántos han llegado hasta la confirmación\n- Tasa de conversión por fuente`,
                extra: `Si no ves datos de anuncios, comprueba que los mensajes predefinidos de tus anuncios coincidan con los configurados en el sistema.`
            },
            {
                title: 'Métricas clave que vigilar',
                icon: CheckCircle,
                table: {
                    headers: ['Métrica', 'Qué indica', 'Señal de alerta'],
                    rows: [
                        ['Tasa de conversión', '% de chats que acaban en venta', 'Por debajo del 5%'],
                        ['Abandono en datos', '% que no completa la dirección', 'Por encima del 40%'],
                        ['Ingresos del día', 'Total facturado en euros', 'Caída brusca respecto al día anterior'],
                    ]
                },
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Las estadísticas se calculan sobre el periodo visible — por defecto, los últimos 7 días.',
                    'Un día con 0 ventas puede indicar un problema en el bot, no necesariamente poca demanda.',
                    'El embudo solo cuenta conversaciones del bot activo — las atendidas a mano no se contabilizan.',
                    'Los datos se actualizan a diario a las 4 de la mañana (hora peninsular).',
                ],
            },
        ],
    },
    {
        id: 'galeria',
        title: 'Galería de Medios',
        description: 'Cómo subir, organizar y enviar imágenes desde el panel.',
        icon: ImageIcon,
        color: 'indigo',
        sections: [
            {
                title: '¿Para qué sirve la galería?',
                icon: HelpCircle,
                content: `La **Galería de Medios** guarda las imágenes que el bot puede enviar automáticamente o que envías tú a mano desde el chat.\n\nIdeal para:\n- Fotos del producto\n- Imágenes de resultados de clientes\n- Carteles de promociones`,
            },
            {
                title: 'Subir una imagen',
                icon: ImageIcon,
                steps: [
                    { label: 'Ir a "Galería de Medios"', detail: 'En el menú lateral, icono de imagen.' },
                    { label: 'Pulsa "Subir imagen"', detail: 'Se abre el selector de archivos.' },
                    { label: 'Selecciona el archivo', detail: 'Formatos admitidos: JPG, PNG, WebP.' },
                    { label: 'Espera la confirmación', detail: 'La imagen aparece en la galería.' },
                ],
            },
            {
                title: 'Enviar una imagen a un cliente',
                icon: Send,
                steps: [
                    { label: 'Ve a la galería y copia el nombre de la imagen', detail: 'O quédate con su nombre.' },
                    { label: 'Abre el chat del cliente en "Chat & Atención"', detail: 'Busca al cliente.' },
                    { label: 'Usa el icono de imagen de la barra de mensajes', detail: 'También puedes arrastrar y soltar.' },
                ],
            },
            {
                title: 'Eliminar una imagen',
                icon: Trash2,
                content: `Pulsa el icono de papelera sobre la imagen. Esta acción es irreversible — si el bot estaba usando esa imagen en el guion, puede dejar de funcionar bien.`,
                extra: `Antes de borrarla, comprueba que la imagen no esté referenciada en el guion del bot.`
            },
        ],
    },
    {
        id: 'configuracion',
        title: 'Configuración',
        description: 'Cómo añadir números de alerta, pausar el bot para todos y vigilar el estado del sistema.',
        icon: Settings,
        color: 'indigo',
        sections: [
            {
                title: '¿Qué se configura aquí?',
                icon: HelpCircle,
                content: `La sección **Configuración** tiene tres bloques:\n\n- **Números de alerta** — quiénes reciben las alertas de pedidos por WhatsApp\n- **Estado del sistema** — memoria, conexiones y salud del bot\n- **Pausa global** — parar el bot para todos los clientes`,
            },
            {
                title: 'Añadir un número de alerta',
                icon: Bell,
                steps: [
                    { label: 'Ir a Configuración', detail: 'En el menú lateral, icono de engranaje.' },
                    { label: 'Sección "Números de Alerta"', detail: 'Muestra los números que reciben alertas.' },
                    { label: 'Escribe el número completo', detail: 'Con prefijo de país y sin espacios (ej.: 34612345678).' },
                    { label: 'Pulsa "Agregar"', detail: 'El número empieza a recibir alertas al momento.' },
                ],
                extra: `También puedes hacerlo por WhatsApp con **!admin add 34612345678**.`
            },
            {
                title: 'Quitar un número de alerta',
                icon: Trash2,
                content: `En la lista de números de alerta, pulsa la X que hay al lado del número que quieras quitar. Ese número dejará de recibir alertas.\n\n⚠️ Asegúrate de que siempre quede al menos un número activo, o los pedidos no se notificarán a nadie.`,
            },
            {
                title: 'Pausa global del bot',
                icon: PauseCircle,
                content: `La **pausa global** para el bot para **todos** los clientes a la vez. Úsala cuando:\n\n- Tengas que hacer mantenimiento\n- Haya un problema con los precios o con el stock\n- El equipo no pueda atender las alertas durante un rato`,
                steps: [
                    { label: 'Activar la pausa global', detail: 'Pulsa "Pausar Todo" en Configuración, o manda !pausa-global on por WhatsApp.' },
                    { label: 'Desactivar la pausa global', detail: 'Pulsa "Reanudar" o manda !pausa-global off.' },
                ],
                extra: `⚠️ Durante la pausa global, los clientes que escriban no reciben respuesta. Avísales si va a durar mucho.`
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
                        ['Heap Usada', 'Memoria del servidor (aviso si pasa de 500 MB)'],
                        ['Activos Ahora', 'Clientes con conversación en curso'],
                    ]
                },
                extra: `Si el heap se mantiene por encima de 500 MB, el bot puede volverse lento. Ponte en contacto con soporte técnico.`
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Deja siempre al menos un número de alerta activo.',
                    'La pausa global afecta a todos los clientes, incluso a los que están en mitad de una compra.',
                    'Los cambios de configuración se aplican al momento, sin reiniciar nada.',
                    'El número de alerta tiene que ser el mismo que el de la cuenta de WhatsApp del administrador.',
                ],
            },
        ],
    },
    {
        id: 'reporte-ia',
        title: 'Reportar Error de IA',
        description: 'Cómo marcar una respuesta incorrecta del bot, guardar el contexto y leer los reportes desde el panel.',
        icon: AlertTriangle,
        color: 'amber',
        sections: [
            {
                title: '¿Para qué sirve?',
                icon: HelpCircle,
                content: `Cuando el bot responde algo **incorrecto, confuso o fuera de contexto**, puedes reportarlo en segundos.\n\nEl reporte guarda la conversación completa y tu corrección en la base de datos. Desde la sección **"Errores de IA"** del panel puedes leerlos todos y usarlos para mejorar el guion del bot.`,
            },
            {
                title: 'Paso 1: Abre el chat',
                icon: MousePointerClick,
                content: `Ve a la sección **Chat & Atención** y abre la conversación en la que el bot se equivocó.`,
                steps: [
                    { label: 'Ir a "Chat & Atención"', detail: 'En el menú lateral, segundo icono.' },
                    { label: 'Buscar al cliente', detail: 'Por nombre o número de teléfono.' },
                    { label: 'Abrir la conversación', detail: 'Haz clic en el chat.' },
                ],
            },
            {
                title: 'Paso 2: Marcar el mensaje erróneo',
                icon: AlertTriangle,
                content: `Pon el ratón encima del **mensaje del bot** que está mal. Aparece un botón naranja con el texto **"Reportar Error de IA"**.`,
                steps: [
                    { label: 'Pasar el ratón por encima del mensaje', detail: 'El mensaje del bot se resalta.' },
                    { label: 'Pulsar "Reportar Error de IA"', detail: 'Se abre la ventana del reporte.' },
                ],
                extra: `El botón solo aparece en los mensajes del **bot** (burbuja de la derecha, morada), no en los del cliente.`
            },
            {
                title: 'Paso 3: Rellenar el reporte',
                icon: Send,
                content: `La ventana muestra los **últimos 4 mensajes** del chat, con el erróneo resaltado en rojo.\n\nPuedes cargar más contexto con el botón **"Cargar más"** si hace falta enseñar más antecedentes.`,
                steps: [
                    { label: 'Revisar el contexto', detail: 'Las burbujas muestran quién dijo qué. La roja es el mensaje erróneo.' },
                    { label: 'Cargar más contexto (opcional)', detail: 'Pulsa "Cargar más" para ver mensajes anteriores.' },
                    { label: 'Escribir la corrección', detail: 'Explica qué hizo mal o qué debería haber respondido.' },
                    { label: 'Pulsar "Guardar Reporte"', detail: 'Se guarda en la base de datos y aparece la confirmación.' },
                ],
            },
            {
                title: 'Ejemplo de buena corrección',
                icon: CheckCircle,
                content: `Al escribir la corrección, cuanto más concreta, mejor. Algunos ejemplos:`,
                table: {
                    headers: ['Mala corrección', 'Buena corrección'],
                    rows: [
                        ['Está mal', 'Ha dado por hecho que no teníamos existencias de cápsulas de 60 días, y sí las tenemos. Debería haber ofrecido ese plan.'],
                        ['No debió decir eso', 'La clienta dijo que está dando el pecho y el bot intentó venderle igual. Debería haber cerrado la conversación.'],
                        ['Respuesta incorrecta', 'Confundió "Nuez de Brasil" con "Nuez de la India". Son productos distintos. Debería haber aclarado la diferencia.'],
                    ]
                },
            },
            {
                title: 'Reglas importantes',
                icon: Shield,
                bullets: [
                    'Reporta solo mensajes del bot, no respuestas del cliente.',
                    'Sé concreto en la corrección: qué estuvo mal y qué debería haber dicho.',
                    'Puedes cargar hasta la conversación entera con "Cargar más".',
                    'Los reportes se guardan para siempre hasta que los borres.',
                    'Usa los reportes para actualizar el guion del bot en la sección "Guion & Prompts".',
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
                <pre className="bg-slate-900 text-success-400 text-xs rounded-control p-3 mb-3 overflow-x-auto font-mono leading-relaxed">
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
