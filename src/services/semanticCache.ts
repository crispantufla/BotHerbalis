/**
 * semanticCache.ts
 *
 * Semantic cache for AI chat responses. Uses OpenAI `text-embedding-3-small`
 * (1536 dims, $0.02 / 1M tokens ≈ $0.000001 per lookup) to fingerprint user
 * messages and serve previously-generated replies for near-duplicate FAQs.
 *
 * How it works:
 *   1. Before calling the chat completion, compute an embedding for the user
 *      text and search a small per-step candidate window in the DB.
 *   2. If any candidate scores cosine similarity ≥ SIM_THRESHOLD, return the
 *      cached response verbatim. Hit counter and `lastHit` get bumped.
 *   3. On a miss, after the real AI responds, the caller writes back the pair
 *      (embedding, response) — but only when the turn did NOT advance the flow
 *      (goalMet === false and extractedData is empty). This keeps the cache
 *      restricted to pure FAQ-style exchanges.
 *
 * Why not pgvector? The DB is shared Railway Postgres and adding the extension
 * requires ops work. For the cache sizes we care about (≤ a few thousand rows
 * per step), in-process cosine is fast enough: a single query fetches the
 * most-recently-hit N rows for the step, parses the JSON embeddings, and
 * scores them. An LRU in memory avoids repeat parses.
 */

import OpenAI from 'openai';
import NodeCache from 'node-cache';
import logger from '../utils/logger';

const EMBEDDING_MODEL = 'text-embedding-3-small';
// 0.92 era demasiado laxo: en el audit del 15-may-2026 encontramos rows con
// respuestas específicas del cliente original (mencionan "tu objetivo de bajar
// 20 kilos", "tenés 44 años") que podrían matchear con otros clientes y
// devolverles esa misma respuesta contaminada. Subido a 0.94 para reducir el
// riesgo de mismatch contextual entre clientes.
const SIM_THRESHOLD = 0.94;
const CANDIDATE_WINDOW = 50; // rows per step to score in-memory
const MEMORY_TTL_SECONDS = 10 * 60; // in-memory LRU for candidate rows
const WRITE_MIN_USER_CHARS = 6; // don't cache ultra-short noise like "ok", "??"

// Steps where FAQ-style repetition is common. Steps that collect data
// (waiting_data, waiting_mp_payment, waiting_final_confirmation) are excluded
// because answers there are conversation-specific and can leak across users.
const CACHEABLE_STEPS = new Set([
    'waiting_weight',
    'waiting_preference',
    'waiting_preference_consultation',
    'waiting_plan_choice',
    'waiting_price_confirmation',
    'waiting_ok',
]);

interface CandidateRow {
    id: string;
    embedding: number[];
    response: string;
}

// In-memory cache of candidate rows per step. Avoids re-parsing JSON on
// every lookup. Invalidated on every successful write.
const candidateCache = new NodeCache({ stdTTL: MEMORY_TTL_SECONDS, checkperiod: 120, useClones: false });

function _cosine(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function _embed(openai: OpenAI, text: string): Promise<number[] | null> {
    try {
        const r = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: text.slice(0, 500), // truncate long transcriptions
        });
        return r.data?.[0]?.embedding || null;
    } catch (e: any) {
        logger.warn(`[SEM-CACHE] Embedding failed: ${e.message}`);
        return null;
    }
}

async function _getCandidates(step: string): Promise<CandidateRow[]> {
    const cached = candidateCache.get<CandidateRow[]>(step);
    if (cached) return cached;

    try {
        const { prisma } = require('../../db');
        const rows = await prisma.aiSemanticCache.findMany({
            where: { step },
            orderBy: { lastHit: 'desc' },
            take: CANDIDATE_WINDOW,
            select: { id: true, embedding: true, response: true },
        });
        const parsed: CandidateRow[] = rows.map((r: any) => {
            try {
                return { id: r.id, embedding: JSON.parse(r.embedding), response: r.response };
            } catch {
                return null;
            }
        }).filter(Boolean);
        candidateCache.set(step, parsed);
        return parsed;
    } catch (e: any) {
        logger.warn(`[SEM-CACHE] Candidate query failed: ${e.message}`);
        return [];
    }
}

/**
 * Look up a cached response for the given step + user text. Returns null on miss.
 * Safe to call even when the step is not cacheable — just returns null immediately.
 */
export async function lookupSemanticCache(
    openai: OpenAI,
    step: string,
    userText: string,
    engine: string = 'openai'
): Promise<{ response: string; similarity: number } | null> {
    if (!CACHEABLE_STEPS.has(step)) return null;
    if (!userText || userText.trim().length < WRITE_MIN_USER_CHARS) return null;

    const embedding = await _embed(openai, userText);
    if (!embedding) return null;

    // Namespaceamos por engine: una respuesta generada por GPT NO debe servirse
    // a una conversación que ahora corre sobre Claude (y viceversa). Reusa la
    // columna `step` (sin migración): las filas viejas de GPT quedan huérfanas
    // bajo el namespace 'openai:' y caen fuera de la ventana por lastHit.
    const nsStep = `${engine}:${step}`;
    const candidates = await _getCandidates(nsStep);
    if (candidates.length === 0) return null;

    let best: { row: CandidateRow; sim: number } | null = null;
    for (const row of candidates) {
        const sim = _cosine(embedding, row.embedding);
        if (!best || sim > best.sim) best = { row, sim };
    }

    if (!best || best.sim < SIM_THRESHOLD) return null;

    // Async bump — don't block the caller.
    (async () => {
        try {
            const { prisma } = require('../../db');
            await prisma.aiSemanticCache.update({
                where: { id: best!.row.id },
                data: { hits: { increment: 1 }, lastHit: new Date() },
            });
        } catch {
            /* best effort */
        }
    })();

    logger.info(`[SEM-CACHE] HIT step=${step} sim=${best.sim.toFixed(3)}`);
    return { response: best.row.response, similarity: best.sim };
}

/**
 * Persist a new (userText, response) pair for the given step. No-op when the
 * step is not cacheable or the text is too short.
 */
export async function storeSemanticCache(
    openai: OpenAI,
    step: string,
    userText: string,
    response: string,
    engine: string = 'openai'
): Promise<void> {
    if (!CACHEABLE_STEPS.has(step)) return;
    if (!userText || userText.trim().length < WRITE_MIN_USER_CHARS) return;
    if (!response || response.trim().length < 10) return;

    const embedding = await _embed(openai, userText);
    if (!embedding) return;

    const nsStep = `${engine}:${step}`;
    try {
        const { prisma } = require('../../db');
        await prisma.aiSemanticCache.create({
            data: {
                step: nsStep,
                userText: userText.slice(0, 500),
                embedding: JSON.stringify(embedding),
                response,
            },
        });
        candidateCache.del(nsStep); // force refresh on next lookup
        logger.info(`[SEM-CACHE] STORED step=${step} len=${response.length}`);
    } catch (e: any) {
        logger.warn(`[SEM-CACHE] Store failed: ${e.message}`);
    }
}

/**
 * Testing/debug helper — exposed so admin endpoints can show cache stats.
 */
export async function getSemanticCacheStats(): Promise<{
    total: number;
    perStep: Record<string, { count: number; hits: number }>;
}> {
    try {
        const { prisma } = require('../../db');
        const rows = await prisma.aiSemanticCache.findMany({
            select: { step: true, hits: true },
        });
        const perStep: Record<string, { count: number; hits: number }> = {};
        for (const r of rows) {
            if (!perStep[r.step]) perStep[r.step] = { count: 0, hits: 0 };
            perStep[r.step].count++;
            perStep[r.step].hits += r.hits;
        }
        return { total: rows.length, perStep };
    } catch {
        return { total: 0, perStep: {} };
    }
}
