/**
 * auditar-cumplimiento.ts — Barre TODO el texto del bot buscando claims que no
 * se pueden publicar en España.
 *
 *   npx tsx scripts/auditar-cumplimiento.ts
 *
 * Por qué existe: el 15-08-2026 una auditoría encontró 124 incumplimientos
 * repartidos entre el guion, los prompts de IA y los mensajes automáticos. El
 * problema no era solo el texto literal — varios prompts ORDENABAN a la IA
 * escribir claims prohibidos, así que el bot los emitía aunque el JSON del
 * guion estuviera limpio. Este script cubre las tres superficies a la vez.
 *
 * Base legal de lo que busca: Reglamento (CE) 1924/2006 (art. 12b prohíbe
 * mencionar magnitud o ritmo de pérdida de peso), precedente AEMPS alerta
 * ICM/MI 13/2012 sobre este mismo producto, y normas de publicidad de Meta.
 * Las reglas concretas viven en src/services/compliance.ts.
 *
 * Salida: código 1 si encuentra algo, para poder engancharlo a CI.
 */
const fs = require('fs');
const path = require('path');
const { checkCompliance } = require('../src/services/compliance');

const RAIZ = path.join(__dirname, '..');
const DIR_FUENTE = path.join(RAIZ, 'src');
const GUION = path.join(RAIZ, 'knowledge_v7.json');

// El propio filtro cita los términos prohibidos por definición: es su lista.
const EXCLUIR = /services[\\/]compliance\.ts$/;

interface Hallazgo {
    donde: string;
    reglas: string;
    texto: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Falsos positivos que hay que descartar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un prompt tiene que NOMBRAR lo que veta para poder vetarlo ("🛑 PROHIBIDO
 * escribir 'adelgazar'"). El filtro no distingue eso de un claim, así que se
 * mira el contexto: la propia línea hacia atrás, y unas líneas arriba para las
 * listas con viñetas bajo una cabecera que dice PROHIBIDO una sola vez.
 */
const VETO = /(prohibid|no digas|no escribas|no repreguntes|nunca\s+\w*\s*(digas|escribas|hables|menciones|repitas)|ni de\b|ni hables|evita(r)?|jam[áa]s\s+\w*\s*(digas|escribas)|no (se lo )?verbalices|criterio interno|sin (la )?cifra)/i;

/** Un ejemplo marcado como INCORRECTO enseña justo lo que no hay que decir. */
const EJEMPLO_MALO = /❌|\bMAL\b\s*\(/;

/** Líneas que citan cómo habla el CLIENTE para que la IA lo reconozca. */
const CITA_CLIENTE = /\b(el|la) client[ea]\s+\w*\s*(menciona|dice|responde|escribe|pide|contesta|suelta)|cifras sueltas|responde con monos[íi]labos/i;

function esProhibicion(linea: string, match: string, previas: string[]): boolean {
    if (EJEMPLO_MALO.test(linea)) return true;
    const i = linea.toLowerCase().indexOf(match.toLowerCase());
    if (i < 0) return false;
    const antes = linea.slice(0, i);
    if (VETO.test(antes.slice(-200)) || CITA_CLIENTE.test(antes.slice(-200))) return true;
    // Cabeceras que vetan una vez y luego enumeran en viñetas.
    if (/^\s*['"`]?\s*[-•*]/.test(linea.trim())) return previas.some(p => VETO.test(p));
    return false;
}

function esComentario(linea: string): boolean {
    const t = linea.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

// ─────────────────────────────────────────────────────────────────────────────

function* archivos(dir: string): Generator<string> {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) yield* archivos(full);
        else if (/\.(ts|js)$/.test(e.name) && !EXCLUIR.test(full)) yield full;
    }
}

/** Strings que el bot envía y prompts que instruyen a la IA. */
function auditarFuente(): Hallazgo[] {
    const out: Hallazgo[] = [];
    for (const f of archivos(DIR_FUENTE)) {
        const lineas: string[] = fs.readFileSync(f, 'utf8').split('\n');
        lineas.forEach((linea, i) => {
            if (esComentario(linea)) return;
            if (!/['"`].*[a-záéíóúñ]{4,}/i.test(linea)) return;
            const previas = lineas.slice(Math.max(0, i - 6), i);
            const issues = checkCompliance([linea]).filter((x: any) => !esProhibicion(linea, x.match, previas));
            if (!issues.length) return;
            out.push({
                donde: `${path.relative(RAIZ, f)}:${i + 1}`,
                reglas: issues.map((x: any) => `${x.rule}("${x.match}")`).join(', '),
                texto: linea.trim().slice(0, 150),
            });
        });
    }
    return out;
}

/**
 * Ramas del guion que NO son texto que emitimos, sino texto que RECIBIMOS.
 *
 * `keywords` son las palabras que escribe el cliente para que salte una FAQ, y
 * ahí tiene que estar "efecto rebote" precisamente para poder responder a quien
 * lo pregunta. Auditarlas es confundir lo que decimos con lo que nos dicen: la
 * ley limita lo primero, no lo segundo. Si algún día hay más ramas así, van
 * aquí.
 */
const RAMAS_DE_ENTRADA = /\.keywords(\[\d+\])?$/;

/** Cada texto del guion, recorriendo el JSON entero. */
function auditarGuion(): Hallazgo[] {
    const out: Hallazgo[] = [];
    const knowledge = JSON.parse(fs.readFileSync(GUION, 'utf8'));

    (function recorrer(nodo: any, ruta: string) {
        if (RAMAS_DE_ENTRADA.test(ruta)) return;
        if (typeof nodo === 'string') {
            const issues = checkCompliance([nodo]);
            if (issues.length) {
                out.push({
                    donde: `knowledge_v7.json → ${ruta}`,
                    reglas: issues.map((x: any) => `${x.rule}("${x.match}")`).join(', '),
                    texto: nodo.replace(/\s+/g, ' ').slice(0, 150),
                });
            }
            return;
        }
        if (Array.isArray(nodo)) return nodo.forEach((v, i) => recorrer(v, `${ruta}[${i}]`));
        if (nodo && typeof nodo === 'object') {
            for (const [k, v] of Object.entries(nodo)) recorrer(v, ruta ? `${ruta}.${k}` : k);
        }
    })(knowledge, '');

    return out;
}

const hallazgos = [...auditarGuion(), ...auditarFuente()];

if (!hallazgos.length) {
    console.log('\n✅ Sin incumplimientos. El guion, los prompts y los mensajes automáticos están limpios.\n');
    process.exit(0);
}

console.log(`\n❌ ${hallazgos.length} incumplimiento(s):\n`);
for (const h of hallazgos) {
    console.log(`${h.donde}`);
    console.log(`   ${h.reglas}`);
    console.log(`   ${h.texto}\n`);
}
console.log('Reglas y base legal: src/services/compliance.ts\n');
process.exit(1);
