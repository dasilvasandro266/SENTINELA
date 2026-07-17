const crypto = require('crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const RESPONSE_CACHE_TTL_MS = 10 * 60 * 1000;
const SEMANTIC_CACHE_TTL_MS = 20 * 60 * 1000;
const TOOL_CACHE_TTL_MS = 10 * 60 * 1000;
const CONTEXT_CACHE_TTL_MS = 30 * 60 * 1000;
const SEMANTIC_RESPONSE_THRESHOLD = 0.88;

function nowMs() {
    return Date.now();
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hash(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(value) {
    const stop = new Set([
        'a', 'o', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das',
        'e', 'ou', 'para', 'por', 'com', 'sem', 'em', 'no', 'na', 'nos', 'nas',
        'que', 'qual', 'quais', 'como', 'quando', 'onde'
    ]);
    return normalizeText(value)
        .split(/\s+/)
        .filter((token) => token.length >= 3 && !stop.has(token));
}

function cosineLikeSimilarity(a, b) {
    const aTokens = tokenize(a);
    const bTokens = tokenize(b);
    if (!aTokens.length || !bTokens.length) return 0;
    const aFreq = new Map();
    const bFreq = new Map();
    aTokens.forEach((token) => aFreq.set(token, (aFreq.get(token) || 0) + 1));
    bTokens.forEach((token) => bFreq.set(token, (bFreq.get(token) || 0) + 1));
    const keys = new Set([...aFreq.keys(), ...bFreq.keys()]);
    let dot = 0;
    let aNorm = 0;
    let bNorm = 0;
    keys.forEach((key) => {
        const av = aFreq.get(key) || 0;
        const bv = bFreq.get(key) || 0;
        dot += av * bv;
        aNorm += av * av;
        bNorm += bv * bv;
    });
    if (!aNorm || !bNorm) return 0;
    return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

class TtlCache {
    constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = 200 } = {}) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.items = new Map();
    }

    get(key) {
        const entry = this.items.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= nowMs()) {
            this.items.delete(key);
            return null;
        }
        entry.hits += 1;
        entry.lastAccessedAt = nowMs();
        return entry.value;
    }

    set(key, value, ttlMs = this.ttlMs) {
        this.items.set(key, {
            value,
            expiresAt: nowMs() + ttlMs,
            hits: 0,
            lastAccessedAt: nowMs()
        });
        this.prune();
    }

    invalidate(predicate) {
        if (typeof predicate !== 'function') {
            this.items.clear();
            return;
        }
        [...this.items.entries()].forEach(([key, entry]) => {
            if (predicate(key, entry.value)) this.items.delete(key);
        });
    }

    prune() {
        const current = nowMs();
        [...this.items.entries()].forEach(([key, entry]) => {
            if (entry.expiresAt <= current) this.items.delete(key);
        });
        if (this.items.size <= this.maxEntries) return;
        const sorted = [...this.items.entries()]
            .sort((a, b) => {
                const scoreA = a[1].hits * 1000 + a[1].lastAccessedAt;
                const scoreB = b[1].hits * 1000 + b[1].lastAccessedAt;
                return scoreA - scoreB;
            });
        sorted.slice(0, this.items.size - this.maxEntries).forEach(([key]) => this.items.delete(key));
    }
}

class SemanticCache {
    constructor({ ttlMs = SEMANTIC_CACHE_TTL_MS, threshold = SEMANTIC_RESPONSE_THRESHOLD, maxEntries = 100 } = {}) {
        this.ttlMs = ttlMs;
        this.threshold = threshold;
        this.maxEntries = maxEntries;
        this.items = [];
    }

    get(text, namespace = 'global') {
        const current = nowMs();
        this.items = this.items.filter((entry) => entry.expiresAt > current);
        let best = null;
        this.items.forEach((entry) => {
            if (entry.namespace !== namespace) return;
            const similarity = cosineLikeSimilarity(text, entry.text);
            if (similarity >= this.threshold && (!best || similarity > best.similarity)) {
                best = { value: entry.value, similarity };
            }
        });
        return best;
    }

    set(text, value, namespace = 'global') {
        this.items.push({
            namespace,
            text,
            value,
            expiresAt: nowMs() + this.ttlMs
        });
        if (this.items.length > this.maxEntries) {
            this.items = this.items.slice(this.items.length - this.maxEntries);
        }
    }

    invalidate(namespace) {
        if (!namespace) {
            this.items = [];
            return;
        }
        this.items = this.items.filter((entry) => entry.namespace !== namespace);
    }
}

class ContextMemory {
    constructor({ ttlMs = CONTEXT_CACHE_TTL_MS, maxSessions = 250, maxItemsPerSession = 8 } = {}) {
        this.cache = new TtlCache({ ttlMs, maxEntries: maxSessions });
        this.maxItemsPerSession = maxItemsPerSession;
    }

    recall(sessionId) {
        return this.cache.get(sessionId) || { recentTurns: [], working: [] };
    }

    remember(sessionId, item) {
        const state = this.recall(sessionId);
        const recentTurns = [item, ...state.recentTurns].slice(0, this.maxItemsPerSession);
        this.cache.set(sessionId, { ...state, recentTurns });
    }
}

class ToolRegistry {
    constructor(toolResultCache) {
        this.toolResultCache = toolResultCache;
    }

    async execute(tool, executionContext) {
        const cacheKey = `${tool.name}:${hash(stableStringify(tool.cacheKey || executionContext.cacheKey || {}))}`;
        if (tool.cacheable !== false) {
            const cached = this.toolResultCache.get(cacheKey);
            if (cached) return { ...cached, cache: 'hit' };
        }

        const startedAt = nowMs();
        let attempt = 0;
        const maxRetries = Number.isInteger(tool.retries) ? tool.retries : 1;
        while (attempt <= maxRetries) {
            attempt += 1;
            try {
                const data = await tool.run(executionContext);
                const result = {
                    name: tool.name,
                    category: tool.category,
                    confidence: tool.confidence,
                    ok: true,
                    data,
                    attempts: attempt,
                    latencyMs: nowMs() - startedAt
                };
                if (tool.cacheable !== false) this.toolResultCache.set(cacheKey, result, tool.ttlMs || TOOL_CACHE_TTL_MS);
                return result;
            } catch (error) {
                if (attempt > maxRetries) {
                    return {
                        name: tool.name,
                        category: tool.category,
                        confidence: 0,
                        ok: false,
                        error: error?.message || 'Falha ao executar ferramenta',
                        attempts: attempt,
                        latencyMs: nowMs() - startedAt
                    };
                }
            }
        }
        return { name: tool.name, ok: false, error: 'Falha desconhecida na ferramenta', confidence: 0 };
    }
}

function analyzeIntent(question) {
    const normalized = normalizeText(question);
    const tokens = tokenize(question);
    const wantsComparison = /\b(compara|comparar|diferen[cç]a|versus|vs\.?|confronta)\b/i.test(question);
    const wantsStrategy = /\b(estrat[eé]gia|argumento|defesa|risco|probabilidade|tese)\b/i.test(question);
    const wantsLegalBasis = /\b(artigo|artigos|lei|c[oó]digo|legisla[cç][aã]o|jurisprud[eê]ncia|ac[oó]rd[aã]o)\b/i.test(question);
    const ambiguity = tokens.length <= 2 || /\b(depende|amb[ií]guo|conflito|contradi[cç][aã]o|interpreta[cç][aã]o)\b/i.test(question);
    const complexity = tokens.length + (wantsComparison ? 4 : 0) + (wantsStrategy ? 4 : 0) + (wantsLegalBasis ? 2 : 0);
    return {
        normalized,
        tokens,
        wantsComparison,
        wantsStrategy,
        wantsLegalBasis,
        ambiguity,
        complexity
    };
}

function shouldDeepThink(intent, context = {}) {
    return Boolean(
        context.forceDeepThink
        || intent.complexity >= 9
        || intent.wantsComparison
        || intent.wantsStrategy
        || intent.ambiguity
    );
}

function routeModels(intent, deepThink) {
    return {
        orchestrator: 'medium-orchestration',
        reasoning: deepThink ? 'large-reasoning-on-demand' : 'medium-reasoning',
        embeddings: 'lightweight-lexical-semantic',
        retrieval: 'database-fts',
        ocr: 'vision-model-when-document-image-is-present'
    };
}

function selectTools(tools, intent, deepThink) {
    return tools
        .map((tool) => {
            const categoryBoost = {
                legislation: intent.wantsLegalBasis ? 0.18 : 0.06,
                jurisprudence: intent.wantsLegalBasis || intent.wantsComparison ? 0.14 : 0.04,
                doctrine: deepThink ? 0.18 : 0.08,
                formation: intent.ambiguity ? 0.14 : 0.07,
                knowledge: deepThink ? 0.12 : 0.04
            }[tool.category] || 0.02;
            return {
                ...tool,
                confidence: Math.min(0.99, (tool.baseConfidence || 0.72) + categoryBoost)
            };
        })
        .filter((tool) => tool.required || tool.confidence >= 0.7)
        .sort((a, b) => b.confidence - a.confidence);
}

function validateResponse(response, toolResults) {
    const answer = String(response?.answer || '').trim();
    const sources = Array.isArray(response?.sources) ? response.sources : [];
    const successfulTools = toolResults.filter((result) => result.ok);
    const failedTools = toolResults.filter((result) => !result.ok);
    const contradictions = [];
    if (sources.length === 0 && /artigo|lei|jurisprud/i.test(answer)) {
        contradictions.push('Resposta menciona base jurídica sem fontes visíveis.');
    }
    return {
        ok: Boolean(answer),
        confidence: Math.max(0.2, Math.min(0.98, 0.58 + successfulTools.length * 0.08 - failedTools.length * 0.12 - contradictions.length * 0.18)),
        contradictions,
        failedTools: failedTools.map((result) => ({ name: result.name, error: result.error }))
    };
}

function createHiromiCognitiveSystem() {
    const responseCache = new TtlCache({ ttlMs: RESPONSE_CACHE_TTL_MS, maxEntries: 180 });
    const semanticCache = new SemanticCache();
    const toolResultCache = new TtlCache({ ttlMs: TOOL_CACHE_TTL_MS, maxEntries: 500 });
    const contextMemory = new ContextMemory();
    const registry = new ToolRegistry(toolResultCache);
    let knowledgeVersion = 1;

    function invalidateKnowledge() {
        knowledgeVersion += 1;
        responseCache.invalidate();
        semanticCache.invalidate('hiromi-knowledge');
        toolResultCache.invalidate();
    }

    async function run({ question, userId, context = {}, tools = [], synthesize }) {
        const sessionId = String(userId || 'anonymous');
        const startedAt = nowMs();
        const intent = analyzeIntent(question);
        const deepThink = shouldDeepThink(intent, context);
        const modelRoute = routeModels(intent, deepThink);
        const memory = contextMemory.recall(sessionId);
        const responseKey = `${knowledgeVersion}:${hash(intent.normalized)}`;

        const exactCached = responseCache.get(responseKey);
        if (exactCached) {
            return {
                response: {
                    ...exactCached,
                    cache: { response: 'hit', semantic: 'miss', tool: 'skipped' },
                    cognitive: { ...exactCached.cognitive, latencyMs: nowMs() - startedAt }
                },
                cognitive: exactCached.cognitive
            };
        }

        const semanticCached = semanticCache.get(question, 'hiromi-knowledge');
        if (semanticCached) {
            const value = {
                ...semanticCached.value,
                cache: { response: 'miss', semantic: 'hit', similarity: Number(semanticCached.similarity.toFixed(3)), tool: 'skipped' },
                cognitive: { ...semanticCached.value.cognitive, latencyMs: nowMs() - startedAt }
            };
            responseCache.set(responseKey, value);
            return { response: value, cognitive: value.cognitive };
        }

        const selectedTools = selectTools(tools, intent, deepThink);
        const executionContext = {
            question,
            userId,
            intent,
            deepThink,
            memory,
            cacheKey: { question: intent.normalized, knowledgeVersion }
        };

        const toolResults = await Promise.all(selectedTools.map((tool) => registry.execute(tool, executionContext)));
        const synthesis = await synthesize({
            question,
            intent,
            deepThink,
            memory,
            toolResults,
            modelRoute
        });
        const validation = validateResponse(synthesis, toolResults);
        const cognitive = {
            mode: deepThink ? 'DEEP_THINK' : 'FAST_REASON',
            phases: ['planning', 'reasoning', 'execution', 'validation', 'response'],
            modelRoute,
            toolPlan: selectedTools.map((tool) => ({
                name: tool.name,
                category: tool.category,
                confidence: Number(tool.confidence.toFixed(2))
            })),
            validation,
            memory: {
                recalledTurns: memory.recentTurns.length,
                stored: true
            },
            latencyMs: nowMs() - startedAt
        };
        const response = {
            ...synthesis,
            cache: {
                response: 'miss',
                semantic: 'miss',
                tool: toolResults.some((result) => result.cache === 'hit') ? 'partial-hit' : 'miss'
            },
            cognitive
        };

        responseCache.set(responseKey, response);
        semanticCache.set(question, response, 'hiromi-knowledge');
        contextMemory.remember(sessionId, {
            question: intent.normalized,
            mode: cognitive.mode,
            confidence: validation.confidence,
            at: new Date().toISOString()
        });
        return { response, cognitive };
    }

    return {
        run,
        invalidateKnowledge
    };
}

module.exports = {
    createHiromiCognitiveSystem,
    normalizeText,
    cosineLikeSimilarity
};
