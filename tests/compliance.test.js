/**
 * El filtro de compliance es lo único que separa una pieza publicada de un
 * expediente de la AEMPS o una cuenta publicitaria inhabilitada. Estos tests
 * cubren los dos lados: que no deje pasar lo prohibido, y que no bloquee el
 * lenguaje que la marca sí puede usar (si bloquea todo, se acaba desactivando).
 */
const { checkCompliance } = require('../src/services/compliance');

describe('compliance de piezas de marketing', () => {

    describe('bloquea lo que la ley y Meta prohíben', () => {
        const prohibidos = [
            ['magnitud en kilos', 'Pierde 5 kg con nuestra rutina'],
            ['kilos sueltos', 'Hasta 10 kilos menos en tu día a día'],
            ['plazo con resultados', 'Resultados en 15 días'],
            ['plazo + peso', 'Nota el cambio de peso en solo 3 semanas'],
            ['verbo adelgazar', 'El complemento que adelgaza sin esfuerzo'],
            ['adelgazante', 'Nuez adelgazante en cápsulas'],
            ['quema grasas', 'Fórmula quema grasas natural'],
            ['bajar de peso', 'Te ayuda a bajar de peso'],
            ['atributo personal', '¿Te sobran esos kilos?'],
            ['atributo personal 2', 'Adiós a tu barriga'],
            ['antes y después', 'Mira el antes y después de Marta'],
            ['milagro', 'El producto milagroso del que todas hablan'],
            ['detox', 'Acción detox que limpia tu organismo'],
            ['sin efecto rebote', 'Baja de forma sostenida y sin efecto rebote'],
            ['urgencia', '¡Últimas unidades, solo hoy!'],
            ['voseo argentino', 'Elegí tu plan y escribinos'],
            ['voseo: empezá', 'Consultanos y empezá tu plan Herbalis'],
            ['voseo: querés/vos', 'Si querés saber qué propuesta se adapta mejor a vos'],
            ['voseo: tenés', 'Tenés que tomarlo antes de comer'],
            ['voseo: sabés', '¿Sabés cómo se toma?'],
            ['voseo: venís', 'Si venís a recogerlo te lo explican'],
            ['testimonio inventado', '— Carmen, 52 años'],
            ['testimonio inventado 2', 'Lo cuenta Marta, que lleva meses con nosotras'],
            ['testimonio inventado 3', 'Rosa (58) empezó el mes pasado'],
            // Estos salieron del material real de la agencia: la primera versión
            // del filtro los dejaba pasar porque solo cubría el infinitivo.
            ['bajar de peso conjugado', 'Bajá de peso sin dietas estrictas'],
            ['bajé en testimonio', 'Bajé y dejé de sentirme hinchada'],
            ['reduce peso', 'Reduce peso y grasa corporal, elimina toxinas'],
            ['grasas localizadas', 'Favorece la eliminación de grasas localizadas'],
        ];

        test.each(prohibidos)('rechaza: %s', (_etiqueta, texto) => {
            const issues = checkCompliance([texto]);
            expect(issues.length).toBeGreaterThan(0);
        });
    });

    describe('deja pasar el lenguaje que la marca sí puede usar', () => {
        const permitidos = [
            'Bienestar digestivo y control del peso después de los 45',
            'Una rutina sencilla que sí puedes sostener, sin dietas extremas ni promesas mágicas',
            'Cuando la digestión se ordena, el resto de la rutina cuesta menos',
            'Acompaña tu digestión diaria y ayuda al control del apetito',
            'Cápsulas o gotas, tú eliges el formato que encaje con tu día',
            'Hecho con cuidado para mujeres reales y rutinas posibles de sostener',
            'Muchas mujeres sienten que su cuerpo ya no responde igual',
            'Escríbenos por WhatsApp y te contamos cómo funciona',
            'Te llega a casa y lo pagas al recibirlo',
            // Imperativos de tuteo que se parecen al voseo solo en la tilde.
            // La primera versión del filtro los rechazaba y habría bloqueado
            // copy peninsular correcto.
            'Mira, en el tratamiento va todo incluido',
            'Descarga la guía gratuita',
            'Elige el formato que mejor te encaje',
            'Empieza hoy con una rutina sencilla',
            'Prueba el formato en gotas y nos cuentas',
            'Consulta con nosotras cualquier duda',
            // Formas de tuteo que solo se distinguen del voseo por la tilde.
            'Si no lo sabes, te lo consultamos',
            'Cuando vienes a recogerlo te lo explican',
            'Lo haces una vez al día y ya está',
        ];

        test.each(permitidos)('acepta: %s', (texto) => {
            const issues = checkCompliance([texto]);
            expect(issues).toEqual([]);
        });
    });

    test('revisa todos los campos de la pieza, no solo el titular', () => {
        const issues = checkCompliance([
            'BIENESTAR DIGESTIVO',
            'Una rutina que puedes sostener',
            'Pierde 8 kilos este mes',   // el claim viene en el pie
        ]);
        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0].match).toMatch(/8/);
    });

    test('cada problema explica qué escribir en su lugar', () => {
        const issues = checkCompliance(['El complemento que adelgaza rápido']);
        expect(issues[0].hint).toBeTruthy();
        expect(issues[0].hint.length).toBeGreaterThan(20);
    });

    test('texto vacío o nulo no rompe', () => {
        expect(checkCompliance([])).toEqual([]);
        expect(checkCompliance([null, undefined, ''])).toEqual([]);
    });
});
