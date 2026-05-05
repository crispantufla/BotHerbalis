/**
 * Test del detector de "pedido de horario específico" en globalScheduleRequest.
 * Solo testea la lógica de regex, sin disparar _pauseAndAlert.
 * Uso: npx tsx scripts/test-schedule-detector.ts
 */
import { _detectScheduleRequest } from '../src/flows/globals/globalScheduleRequest';

const cases: [string, boolean][] = [
    // SHOULD MATCH (cliente pide horario específico)
    ['Hola Mañana ala tarde pueden venir 17 30', true],
    ['vengan a las 5 de la tarde por favor', true],
    ['que pasen mañana a la tarde', true],
    ['el cartero a las 9am está bien', true],
    ['Pueden venir mañana a las 17:30?', true],
    ['envíen el paquete a las 18hs', true],
    ['que llegue mañana sobre las 5pm', true],

    // SHOULD NOT MATCH (uso casual de horarios o números)
    ['Hola, cuanto sale?', false],
    ['Tomo las cápsulas a la mañana, está bien?', false],
    ['Calle Belgrano 1234, código postal 1407', false],
    ['Quiero el plan de 60 días', false],
    ['Mañana cobro y arranco', false],
    ['Ya pagué', false],
    ['si dale', false],
];

let pass = 0, fail = 0;
for (const [text, expected] of cases) {
    const matched = _detectScheduleRequest(text);
    const ok = matched === expected;
    console.log(`${ok ? '✓' : '✗'} [esperado=${expected ? 'MATCH ' : 'pasa  '}, real=${matched ? 'MATCH ' : 'pasa  '}] "${text}"`);
    if (ok) pass++; else fail++;
}
console.log(`\n${pass}/${pass + fail} casos correctos`);
if (fail > 0) process.exit(1);
