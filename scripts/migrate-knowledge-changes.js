/**
 * migrate-knowledge-changes.js
 *
 * Aplica los cambios de Sprint 1 a los archivos de conocimiento personalizados
 * por vendedor (data/knowledge_v*_${sellerId}.json). Es idempotente y seguro:
 * solo reemplaza las respuestas si el contenido viejo está presente — si el
 * vendedor ya editó una respuesta diferente, se respeta.
 *
 * Uso (local):    node scripts/migrate-knowledge-changes.js
 * Uso (railway):  railway run --service MainHerbalisBot node scripts/migrate-knowledge-changes.js
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Cada cambio define qué reemplazar dentro del JSON parseado.
// El "where" es la ruta dentro del objeto (ej: flow.preference_capsulas.response)
// El "matchOldContains" es un fragmento del valor viejo que confirma que vamos a
// reemplazar el contenido oficial (no una customización del vendedor).
const CHANGES_V4 = [
    {
        where: ['flow', 'recommendation', 'response'],
        matchOldContains: 'Quedate tranqui que ese objetivo es re posible',
        newValue: 'Genial 👌\n\nEse objetivo es totalmente posible — lo logramos con miles de clientes 🙂\n\n¿Cuál te gustaría probar?\n\n1️⃣ Cápsulas (lo más efectivo y práctico)\n2️⃣ Semillas/Infusión (más natural)\n3️⃣ Gotas (para +70 años o pocos kilos)',
    },
    {
        where: ['flow', 'preference_capsulas', 'response'],
        matchOldContains: 'OPCIÓN RECOMENDADA (120 días)',
        newValue: 'Dale, excelente elección 👍\n\n💊 Se toma 1 cápsula al día, 30 min antes de la comida principal.\n\n🏆 *Plan 120 días — ${{PRICE_CAPSULAS_120}}*\n_Envío gratis + pago a domicilio bonificado_ ✅\n\n🔸 Plan 60 días — ${{PRICE_CAPSULAS_60}}\n_+${{ADICIONAL_MAX}} si pagás contra reembolso_\n\n👉 ¿Te reservo el de 120 o arrancamos con 60?',
    },
    {
        where: ['flow', 'preference_semillas', 'response'],
        matchOldContains: 'La semilla natural es la clásica',
        newValue: 'Dale, excelente elección 🌿\n\n🌿 Se prepara como infusión cada noche, re fácil.\n\n🏆 *Plan 120 días — ${{PRICE_SEMILLAS_120}}*\n_Envío gratis + pago a domicilio bonificado_ ✅\n\n🔸 Plan 60 días — ${{PRICE_SEMILLAS_60}}\n_+${{ADICIONAL_MAX}} si pagás contra reembolso_\n\n💡 _Tip: con 3 unidades tenés 30% OFF._\n\n👉 ¿Le metemos con 120 o arrancamos con 60?',
    },
    {
        where: ['flow', 'preference_gotas', 'response'],
        matchOldContains: 'Las gotas son discretas y se absorben rápido',
        newValue: 'Dale, excelente elección 🌿\n\n💧 Se absorben rápido y son discretas.\n\n🏆 *Plan 120 días — ${{PRICE_GOTAS_120}}*\n_Envío gratis + pago a domicilio bonificado_ ✅\n\n🔸 Plan 60 días — ${{PRICE_GOTAS_60}}\n_+${{ADICIONAL_MAX}} si pagás contra reembolso_\n\n👉 ¿Le metemos con 120 o arrancamos con 60?',
    },
];

const CHANGES_V3 = [
    {
        where: ['flow', 'recommendation', 'response'],
        matchOldContains: 'Ese objetivo es totalmente posible. Pasemos directo',
        newValue: 'Perfecto 👌\n\nEse objetivo es totalmente posible — lo logramos con miles de clientes 🙂\n\n¿Cuál te gustaría probar?\n\n1️⃣ Cápsulas (lo más efectivo y práctico)\n2️⃣ Semillas/Infusión (más natural)\n3️⃣ Gotas (para +70 años o pocos kilos)',
    },
    {
        where: ['flow', 'preference_capsulas', 'response'],
        matchOldContains: 'El servicio de pago contra entrega tiene un adicional',
        newValue: 'Genial 👍 Excelente elección.\n\n💊 Se toma 1 cápsula al día, 30 min antes de la comida principal.\n\n🏆 *Plan 120 días — ${{PRICE_CAPSULAS_120}}*\n_Envío gratis + pago a domicilio bonificado_ ✅\n\n🔸 Plan 60 días — ${{PRICE_CAPSULAS_60}}\n_+$6.000 si pagás contra reembolso_\n\n👉 ¿Avanzamos con 120 o 60 días?',
    },
    {
        where: ['flow', 'preference_semillas', 'response'],
        matchOldContains: 'La semilla en estado natural es la opción más elegida',
        newValue: 'Genial 🌿 Las semillas son la opción más elegida.\n\n🌿 Se prepara como infusión cada noche.\n\n🏆 *Plan 120 días — ${{PRICE_SEMILLAS_120}}*\n_Envío gratis + pago a domicilio bonificado_ ✅\n\n🔸 Plan 60 días — ${{PRICE_SEMILLAS_60}}\n_+$6.000 si pagás contra reembolso_\n\n👉 ¿Avanzamos con 120 o 60 días?',
    },
    {
        where: ['flow', 'preference_gotas', 'response'],
        matchOldContains: 'Las gotas son prácticas y discretas',
        newValue: 'Genial 🌿 Las gotas son prácticas y discretas.\n\n💧 Se absorben rápido, sin preparar nada.\n\n🏆 *Plan 120 días — ${{PRICE_GOTAS_120}}*\n_Envío gratis + pago a domicilio bonificado_ ✅\n\n🔸 Plan 60 días — ${{PRICE_GOTAS_60}}\n_+$6.000 si pagás contra reembolso_\n\n👉 ¿Avanzamos con 120 o 60 días?',
    },
];

// Faq update: improve "como funciona" answer for both versions
const FAQ_COMO_FUNCIONA_NEW = {
    keywords: ['como funciona', 'como actua', 'explicame', 'explicar', 'que es eso', 'como hace efecto'],
    response: 'La Nuez de la India activa el metabolismo y ayuda al cuerpo a eliminar grasas y toxinas de forma natural y progresiva, sin rebote 🌿\n\nEs 100% natural — trabajamos con este producto hace más de 13 años con miles de clientes.\n\n¿Buscás algo práctico o más natural?',
};

function getNested(obj, path) {
    return path.reduce((cur, k) => (cur && cur[k] != null ? cur[k] : null), obj);
}

function setNested(obj, path, value) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
        if (!cur[path[i]]) return false;
        cur = cur[path[i]];
    }
    cur[path[path.length - 1]] = value;
    return true;
}

function applyChanges(filePath, changes, label) {
    if (!fs.existsSync(filePath)) {
        console.log(`  - [skip] ${path.basename(filePath)} no existe`);
        return { applied: 0, skipped: 0 };
    }

    let json;
    try {
        json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.log(`  - [error] ${path.basename(filePath)}: JSON inválido (${e.message})`);
        return { applied: 0, skipped: 0 };
    }

    let applied = 0, skipped = 0;
    for (const ch of changes) {
        const cur = getNested(json, ch.where);
        if (cur == null) {
            skipped++;
            continue;
        }
        if (cur === ch.newValue) {
            skipped++;
            continue;
        }
        if (typeof cur === 'string' && cur.includes(ch.matchOldContains)) {
            setNested(json, ch.where, ch.newValue);
            applied++;
        } else {
            skipped++;
        }
    }

    // Update FAQ "como funciona" if exists
    if (Array.isArray(json.faq)) {
        const idx = json.faq.findIndex(f =>
            Array.isArray(f.keywords) && f.keywords.includes('como funciona')
            && f.response && !f.response.includes('activa el metabolismo'));
        if (idx >= 0) {
            json.faq[idx] = FAQ_COMO_FUNCIONA_NEW;
            applied++;
        }
    }

    if (applied > 0) {
        // Backup before write
        const backup = filePath + '.bak.' + Date.now();
        fs.copyFileSync(filePath, backup);
        fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
        console.log(`  ✓ [${label}] ${path.basename(filePath)} → ${applied} cambios aplicados (backup: ${path.basename(backup)})`);
    } else {
        console.log(`  - [${label}] ${path.basename(filePath)} → ningún cambio (ya actualizado o customizado)`);
    }
    return { applied, skipped };
}

function main() {
    console.log(`\n=== MIGRACIÓN DE KNOWLEDGE FILES ===`);
    console.log(`Buscando archivos en: ${DATA_DIR}\n`);

    if (!fs.existsSync(DATA_DIR)) {
        console.log('  No existe data/ — no hay nada que migrar.');
        return;
    }

    const files = fs.readdirSync(DATA_DIR);
    let totalApplied = 0;

    for (const f of files) {
        const full = path.join(DATA_DIR, f);
        if (f.startsWith('knowledge_v3') && f.endsWith('.json')) {
            const r = applyChanges(full, CHANGES_V3, 'v3');
            totalApplied += r.applied;
        } else if (f.startsWith('knowledge_v4') && f.endsWith('.json')) {
            const r = applyChanges(full, CHANGES_V4, 'v4');
            totalApplied += r.applied;
        }
    }

    console.log(`\nTotal: ${totalApplied} cambios aplicados en archivos por-vendedor.`);
    console.log(`Los archivos source (knowledge_v3.json y knowledge_v4.json en root) ya están actualizados.`);
}

main();
