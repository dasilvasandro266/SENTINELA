const express = require('express');
require('dotenv').config();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('redis');
const sqlite3 = require('sqlite3');
const db = require('./database');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { authenticateToken } = require('./auth');
const { query: pgQuery, initAuthSchema, initHomeContentSchema, initLegislacaoSchema, initJurisprudenciaSchema } = require('./postgres');
const { importarLegislacaoJson } = require('./legislacao-import-service');
const apiRouter = require('./api');
const { createHiromiCognitiveSystem } = require('./hiromi-cognitive');
const {
  buscarUsuarioPorId,
  mapPgUser,
  gerarTokenUsuario,
  normalizarNomeUsuario,
  buscarUsuarioPorEmail,
  buscarUsuarioPorUsernameNormalizado
} = require('./services/user-service');

// ============================================
// ESTABILIDADE DO PROCESSO
// Captura rejeições e exceções não tratadas para
// evitar que o servidor encerre inesperadamente.
// ============================================
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Exceção não capturada — servidor mantido activo:', err?.message || err);
    console.error(err?.stack || '(sem stack)');
});

process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Promise rejeitada sem handler — servidor mantido activo:', reason?.message || reason);
    if (reason?.stack) console.error(reason.stack);
});

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.warn('⚠️ JWT_SECRET não definido. Configure a variável de ambiente para produção.');
}

const hiromiRateLimit = new Map();
const HIROMI_RATE_WINDOW_MS = 60 * 1000;
const HIROMI_RATE_MAX = 20;
const hiromiCognitive = createHiromiCognitiveSystem();
const hiromiSessionContext = new Map();
const HIROMI_SESSION_CONTEXT_TTL_MS = 20 * 60 * 1000;
const notificationStreams = new Map();
const notificationStreamTokens = new Map();
const NOTIFICATION_STREAM_COOKIE_NAME = 'sentinela_notif_stream';
const NOTIFICATION_STREAM_TOKEN_TTL_MS = 60 * 60 * 1000;
const NOTIFICATION_STREAM_PING_MS = 25 * 1000;

const REDIS_URL = process.env.REDIS_URL;
const corsOrigins = String(process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
let redisClient = null;
let redisReady = false;
let redisInitAttempted = false;
let redisDisabled = false;

async function initRedis() {
    if (!REDIS_URL || redisInitAttempted) return;
    redisInitAttempted = true;

    const disableRedis = (msg, err) => {
        if (!redisDisabled) {
            console.error(`${msg}${err ? `: ${err.message || err}` : ''}`);
        }
        redisDisabled = true;
        redisReady = false;
        if (redisClient) {
            redisClient.removeAllListeners();
            redisClient = null;
        }
    };

    redisClient = createClient({
        url: REDIS_URL,
        socket: {
            reconnectStrategy: () => false
        }
    });
    redisClient.on('error', (err) => {
        disableRedis('Erro Redis', err);
    });

    try {
        await redisClient.connect();
        redisReady = true;
        console.log('✅ Redis conectado para rate limit Hiromi');
    } catch (err) {
        disableRedis('Falha ao conectar ao Redis', err);
    }
}

async function logAudit(eventType, userId, ip, meta = {}) {
    try {
        await pgQuery(
            `INSERT INTO audit_logs (id, event_type, user_id, ip, meta, created_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
            [uuidv4(), eventType, userId || null, ip || null, JSON.stringify(meta || {})]
        );
    } catch (error) {
        console.error('Erro ao registrar auditoria:', error);
    }
}

function serializarNotificacaoStream(payload = {}) {
    return `event: notification\ndata: ${JSON.stringify(payload)}\n\n`;
}

function parseCookies(header = '') {
    return String(header || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((acc, part) => {
            const index = part.indexOf('=');
            if (index === -1) return acc;
            const key = part.slice(0, index).trim();
            const value = part.slice(index + 1).trim();
            if (key) acc[key] = decodeURIComponent(value || '');
            return acc;
        }, {});
}

function emitirAtualizacaoNotificacoes(userId, payload = { type: 'refresh' }) {
    const streams = notificationStreams.get(userId);
    if (!streams || streams.size === 0) return;

    const data = serializarNotificacaoStream(payload);
    for (const res of streams) {
        try {
            res.write(data);
        } catch (error) {
            console.error('Erro ao emitir atualização de notificações:', error);
        }
    }
}

function registarStreamNotificacoes(userId, res) {
    if (!notificationStreams.has(userId)) {
        notificationStreams.set(userId, new Set());
    }
    notificationStreams.get(userId).add(res);

    const cleanup = () => {
        const streams = notificationStreams.get(userId);
        if (streams) {
            streams.delete(res);
            if (streams.size === 0) {
                notificationStreams.delete(userId);
            }
        }
    };

    res.on('close', cleanup);
    res.on('error', cleanup);
    return cleanup;
}

function criarTokenStreamNotificacoes(userId) {
    for (const [existingToken, entry] of notificationStreamTokens.entries()) {
        if (Date.now() > entry.expiresAt) {
            notificationStreamTokens.delete(existingToken);
        }
    }

    const token = uuidv4();
    notificationStreamTokens.set(token, {
        userId,
        expiresAt: Date.now() + NOTIFICATION_STREAM_TOKEN_TTL_MS
    });
    return token;
}

function validarTokenStreamNotificacoes(token) {
    const entry = notificationStreamTokens.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        notificationStreamTokens.delete(token);
        return null;
    }
    return entry.userId;
}

async function rateLimitHiromi(req, res, next) {
    const now = Date.now();
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const key = `${req.user?.userId || 'anon'}:${ip}`;

    if (redisReady && redisClient) {
        try {
            const bucket = Math.floor(now / HIROMI_RATE_WINDOW_MS);
            const redisKey = `hiromi:${key}:${bucket}`;
            const count = await redisClient.incr(redisKey);
            if (count === 1) {
                await redisClient.expire(redisKey, Math.ceil(HIROMI_RATE_WINDOW_MS / 1000));
            }
            if (count > HIROMI_RATE_MAX) {
                const retryAfter = Math.ceil((((bucket + 1) * HIROMI_RATE_WINDOW_MS) - now) / 1000);
                res.set('Retry-After', String(retryAfter));
                await logAudit('hiromi_rate_limited', req.user?.userId, ip, { count, windowSec: HIROMI_RATE_WINDOW_MS / 1000 });
                return res.status(429).json({ error: 'Muitas requisições para a Hiromi. Aguarde e tente novamente.' });
            }
            return next();
        } catch (error) {
            console.warn('[hiromi] Falha no Redis, usando rate limit em memória:', error?.message || error);
        }
    }

    const entry = hiromiRateLimit.get(key) || { count: 0, resetAt: now + HIROMI_RATE_WINDOW_MS };
    if (now > entry.resetAt) {
        entry.count = 0;
        entry.resetAt = now + HIROMI_RATE_WINDOW_MS;
    }

    entry.count += 1;
    hiromiRateLimit.set(key, entry);

    if (entry.count > HIROMI_RATE_MAX) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        res.set('Retry-After', String(retryAfter));
        await logAudit('hiromi_rate_limited', req.user?.userId, ip, { count: entry.count, windowSec: HIROMI_RATE_WINDOW_MS / 1000 });
        return res.status(429).json({ error: 'Muitas requisições para a Hiromi. Aguarde e tente novamente.' });
    }

    return next();
}

function normalizarDisciplina(nome) {
    return String(nome || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function normalizarAutores(valor) {
    if (!valor) return [];
    if (Array.isArray(valor)) return valor.filter(Boolean);
    if (typeof valor === 'string') {
        try {
            const parsed = JSON.parse(valor);
            if (Array.isArray(parsed)) return parsed.filter(Boolean);
        } catch (error) {
            return valor
                .split(/[;,]+/)
                .map((item) => item.trim())
                .filter(Boolean);
        }
    }
    return [];
}

async function adicionarNotificacao(userId, titulo, mensagem = '') {
    const id = uuidv4();
    await pgQuery(
        `INSERT INTO notificacoes (id, usuario_id, titulo, mensagem, lida, created_at)
         VALUES ($1, $2, $3, $4, FALSE, NOW())`,
        [id, userId, titulo, mensagem || null]
    );
    emitirAtualizacaoNotificacoes(userId, { type: 'refresh', reason: 'new-notification' });
}

// Middlewares
app.use(cors(corsOrigins.length ? {
    origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
    credentials: true
} : undefined));
app.use(express.json({ limit: '50mb' }));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, '../node_modules/pdfjs-dist/build'), {
    index: false,
    immutable: true,
    maxAge: '1y',
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.mjs')) {
            res.type('application/javascript');
        }
    }
}));
app.use(express.static(path.join(__dirname, '../public'), { index: false }));
app.use('/api', apiRouter);

// Endpoint de diagnóstico simples
app.get('/api/ping', (req, res) => {
    res.json({ ok: true, ts: Date.now(), host: req.hostname });
});

// Serve app shell on root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/app-shell.html'));
});

// SPA fallback for /app/* (serve app shell)
app.get(/^\/app(\/.*)?$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/app-shell.html'));
});

async function initSchemas() {
    try {
        await initAuthSchema();
        await Promise.all([
            initHomeContentSchema(),
            initLegislacaoSchema(),
            initJurisprudenciaSchema()
        ]);
        console.log('✅ PostgreSQL (Auth + Home + Legislação + Jurisprudência) pronto para uso');
        await migrarUsuariosSQLiteParaPostgres();
    } catch (error) {
        console.error('⚠️ Não foi possível inicializar schemas no PostgreSQL:', error.message);
    }
}

initSchemas();
initRedis().catch((error) => {
    console.error('Erro ao iniciar Redis:', error);
});

function slugify(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 80);
}

function sanitizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanSnippet(value, maxLen = 260) {
    const raw = String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return '';
    if (raw.length <= maxLen) return raw;
    return `${raw.slice(0, maxLen - 1)}…`;
}

function buildSearchLikePattern(question) {
    const raw = String(question || '').trim();
    if (!raw) return '%';
    return `%${raw.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
}

function rewriteSearchQuery(question) {
    const cleaned = normalizeText(question)
        .replace(/\b(qual|quais|como|onde|quando|por que|porque|quem|me|nos|minha|meu|seu|sua|por favor|por favor|mostra|explica|explique|diga|liste|indique|analise|análise|sintetize|resuma)\b/g, '')
        .replace(/\b(o que e|o que é|defina|defini[cç][aã]o de|conceito de|significa|como funciona|quais s[oó]o)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const topic = extractAskedTopic(question);
    if (topic && topic.length >= 3) {
        return normalizeText(topic).split(' ').slice(0, 12).join(' ');
    }
    if (!cleaned) {
        return normalizeText(question).split(' ').slice(0, 12).join(' ');
    }
    return cleaned.split(' ').slice(0, 12).join(' ');
}

function compressContextText(value, maxLen = 800) {
    const raw = String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return '';

    const sentences = raw
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);

    const unique = [];
    const seen = new Set();
    let length = 0;

    for (const sentence of sentences) {
        if (seen.has(sentence)) continue;
        seen.add(sentence);
        if (length + sentence.length > maxLen) break;
        unique.push(sentence);
        length += sentence.length + 1;
    }

    const compressed = unique.join(' ');
    if (compressed.length <= maxLen) return compressed;
    return `${compressed.slice(0, maxLen - 1)}…`;
}

function normalizeContextQuestion(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isHiromiFollowUpQuestion(question) {
    const normalized = normalizeContextQuestion(question);
    if (!normalized) return false;
    return /^(e\s+)?(qual|quais|entao|então|mas|e)\b/.test(String(question || '').trim().toLowerCase())
        || /^(qual e a resposta|qual eh a resposta|qual seria a resposta|responde|explica melhor|continua|desenvolve|e a resposta)$/.test(normalized);
}

function resolveHiromiQuestionContext(userId, question) {
    const key = String(userId || 'anonymous');
    const state = hiromiSessionContext.get(key);
    if (!state || state.expiresAt <= Date.now()) {
        hiromiSessionContext.delete(key);
        return { effectiveQuestion: question, contextualized: false };
    }

    if (!isHiromiFollowUpQuestion(question) || !state.lastQuestion) {
        return { effectiveQuestion: question, contextualized: false };
    }

    return {
        effectiveQuestion: `${state.lastQuestion}. ${question}`,
        contextualized: true,
        previousQuestion: state.lastQuestion
    };
}

function rememberHiromiQuestion(userId, originalQuestion, effectiveQuestion) {
    const key = String(userId || 'anonymous');
    const question = isHiromiFollowUpQuestion(originalQuestion)
        ? String(effectiveQuestion || '').split('.').slice(0, -1).join('.').trim()
        : originalQuestion;
    if (!question) return;
    hiromiSessionContext.set(key, {
        lastQuestion: sanitizeText(question).slice(0, 600),
        expiresAt: Date.now() + HIROMI_SESSION_CONTEXT_TTL_MS
    });
}

function extractRelevantSnippet(value, terms = [], maxLen = 260) {
    const raw = String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return '';

    const haystack = raw.toLowerCase();
    const cleanTerms = [...new Set(
        (Array.isArray(terms) ? terms : [])
            .map((t) => String(t || '').toLowerCase().trim())
            .filter((t) => t.length >= 3)
    )];

    let idx = -1;
    cleanTerms.forEach((term) => {
        const pos = haystack.indexOf(term);
        if (pos >= 0 && (idx === -1 || pos < idx)) idx = pos;
    });

    if (idx === -1) {
        return cleanSnippet(raw, maxLen);
    }

    const start = Math.max(0, idx - 90);
    const end = Math.min(raw.length, idx + Math.max(maxLen - 60, 140));
    let snippet = raw.slice(start, end).trim();
    if (start > 0) snippet = `... ${snippet}`;
    if (end < raw.length) snippet = `${snippet} ...`;
    return snippet;
}

function extractAskedTopic(question) {
    const raw = String(question || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
    if (!raw) return '';

    const patterns = [
        /o que e\s+(?:a|o|os|as|um|uma)?\s*([^?.,;]+)/i,
        /explique\s+(?:a|o|os|as|um|uma)?\s*([^?.,;]+)/i,
        /defina\s+(?:a|o|os|as|um|uma)?\s*([^?.,;]+)/i,
        /resuma\s+(?:a|o|os|as|um|uma)?\s*([^?.,;]+)/i
    ];

    for (const re of patterns) {
        const m = raw.match(re);
        if (!m || !m[1]) continue;
        return m[1]
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .slice(0, 6)
            .join(' ');
    }
    return '';
}

function isIndexLikeSentence(sentence) {
    const s = String(sentence || '').trim();
    if (!s) return true;
    if (/^indice\b|^índice\b/i.test(s)) return true;
    if (/^\d+(\.\d+)+\s/.test(s)) return true;
    if ((s.match(/\bart(?:s?|igos?)?\.?\s*\d+/gi) || []).length >= 2 && s.length < 200) return true;
    if ((s.match(/\d+\.\d+/g) || []).length >= 2) return true;
    return false;
}

function buildDidacticExplanationFromText(value, question, terms = []) {
    const raw = String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return '';

    const askedTopic = extractAskedTopic(question);
    const normalizedTerms = [...new Set(
        (Array.isArray(terms) ? terms : [])
            .map((t) => String(t || '').toLowerCase().trim())
            .filter((t) => t.length >= 3)
    )];

    const candidates = raw
        .split(/(?<=[.!?;:])\s+/)
        .map((s) => s
            .replace(/^\s*[-•]\s*/, '')
            .replace(/^\s*\d+(\.\d+)*\s*[-.):]?\s*/, '')
            .replace(/\s+/g, ' ')
            .trim()
        )
        .filter((s) => s.length >= 40 && s.length <= 320)
        .filter((s) => !isIndexLikeSentence(s));

    if (!candidates.length) {
        const fallback = extractRelevantSnippet(raw, terms, 220);
        return fallback ? `Explicação: ${fallback}` : '';
    }

    const scoreSentence = (sentence) => {
        const lower = sentence.toLowerCase();
        let score = 0;
        normalizedTerms.forEach((t) => {
            if (lower.includes(t)) score += 3;
        });
        if (askedTopic && lower.includes(askedTopic)) score += 4;
        if (/\b(e|são|consiste|constitui|serve|visa|implica|deve|pode)\b/.test(lower)) score += 1;
        if (sentence.length >= 70 && sentence.length <= 220) score += 1;
        return score;
    };

    const ranked = candidates
        .map((s) => ({ s, score: scoreSentence(s) }))
        .sort((a, b) => b.score - a.score);

    const first = ranked[0]?.s || '';
    const second = ranked.find((x) => x.s !== first && x.score >= 1)?.s || '';
    if (!first) return '';

    const concise = (text, maxLen = 220) => {
        const t = String(text || '').trim();
        if (t.length <= maxLen) return t;
        const cut = t.slice(0, maxLen);
        const comma = cut.lastIndexOf(',');
        if (comma > 80) return `${cut.slice(0, comma)}.`;
        return `${cut.trim()}…`;
    };

    const q = String(question || '').toLowerCase();
    const definitionLike = /o que e|o que é|defina|conceito|significa|explique/.test(q);
    const s1 = concise(first);
    const s2 = second ? concise(second, 190) : '';

    if (definitionLike) {
        if (askedTopic) {
            return s2
                ? `${askedTopic.charAt(0).toUpperCase() + askedTopic.slice(1)}: ${s1} Em termos práticos, ${s2}`
                : `${askedTopic.charAt(0).toUpperCase() + askedTopic.slice(1)}: ${s1}`;
        }
        return s2 ? `Explicação: ${s1} Em termos práticos, ${s2}` : `Explicação: ${s1}`;
    }

    return s2 ? `Explicação: ${s1} Além disso, ${s2}` : `Explicação: ${s1}`;
}

function deriveEpigrafeFromConteudo(conteudo) {
    const raw = String(conteudo || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return '';
    const firstSentence = raw.split(/[.;:\n]/)[0].trim();
    return firstSentence.slice(0, 120);
}

function extractFormacaoPoints(html) {
    const raw = String(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    if (!raw) return [];

    const patterns = [
        'designação do tribunal',
        'identificação das partes',
        'indicação da forma do processo',
        'exposição dos factos',
        'fundamentos de direito',
        'pedido',
        'valor da causa',
        'provas'
    ];

    const found = [];
    patterns.forEach((p) => {
        if (raw.includes(p)) found.push(p);
    });

    const titleCase = (text) =>
        text
            .split(' ')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');

    return [...new Set(found)].map(titleCase);
}

function extractSearchTokens(question) {
    const stop = new Set([
        'a', 'o', 'os', 'as', 'um', 'uma', 'uns', 'umas',
        'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
        'por', 'para', 'com', 'sem', 'sobre', 'entre', 'e', 'ou', 'que',
        'qual', 'quais', 'quando', 'onde', 'como', 'porque', 'porquê',
        'ao', 'aos', 'à', 'às', 'se', 'sua', 'seu', 'suas', 'seus'
    ]);
    const generic = new Set([
        'direito', 'juridica', 'jurídica', 'juridico', 'jurídico',
        'angola', 'angolano', 'angolana', 'codigo', 'código',
        'processo', 'processual', 'civil', 'administrativo'
    ]);
    return String(question || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !stop.has(token) && !generic.has(token))
        .slice(0, 8);
}

function extractKeyPhrases(question) {
    const raw = String(question || '').toLowerCase();
    const phrases = [];
    const candidates = [
        'petição inicial',
        'peticao inicial',
        'norma juridica',
        'norma jurídica',
        'processo civil',
        'código de processo civil',
        'codigo de processo civil'
    ];
    candidates.forEach((p) => {
        if (raw.includes(p)) phrases.push(p);
    });
    return [...new Set(phrases)];
}

function detectLawFocus(question) {
    const raw = String(question || '').toLowerCase();
    if (raw.includes('codigo de processo civil') || raw.includes('código de processo civil')) {
        return 'codigo-de-processo-civil';
    }
    return null;
}

function questionWantsArticlesOnly(question) {
    const raw = String(question || '').toLowerCase();
    return /em que artigos|quais artigos|artigos .* encontra|artigos .* regulad/i.test(raw);
}

function questionWantsLegalBasis(question) {
    const raw = String(question || '').toLowerCase();
    return questionWantsArticlesOnly(raw)
        || /artigo|artigos|lei|leis|c[oó]digo|jurisprud[eê]ncia|ac[oó]rd[aã]o/.test(raw);
}

function extractConceptSignals(text) {
    const raw = String(text || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    if (!raw) return [];
    const signals = [
        { key: 'regra de conduta', match: /regra de conduta|regra jur[ií]dica/ },
        { key: 'generalidade e abstração', match: /generalidade|abstrat/ },
        { key: 'coercibilidade', match: /coerc|coac/ },
        { key: 'sanção', match: /san[cç][aã]o/ },
        { key: 'hipótese e consequência', match: /hip[oó]tese|consequ[eê]ncia/ },
        { key: 'ordenamento jurídico', match: /ordenamento jur[ií]dico/ },
        { key: 'legalidade', match: /legalidade/ },
        { key: 'direitos e deveres', match: /direitos|deveres|obriga[cç][aã]o/ }
    ];
    return signals.filter((s) => s.match.test(raw)).map((s) => s.key);
}

function scoreText(text, tokens, phrases) {
    const raw = String(text || '').toLowerCase();
    if (!raw) return 0;
    if (!tokens.length && !phrases.length) return 0;
    let score = 0;
    tokens.forEach((t) => {
        if (raw.includes(t)) score += 1;
    });
    phrases.forEach((p) => {
        if (raw.includes(p)) score += 3;
    });
    return score;
}

function orderConcepts(concepts) {
    const priority = [
        'regra de conduta',
        'generalidade e abstração',
        'hipótese e consequência',
        'direitos e deveres',
        'coercibilidade',
        'sanção',
        'ordenamento jurídico',
        'legalidade'
    ];
    const unique = [...new Set(concepts)];
    const ordered = priority.filter((p) => unique.includes(p));
    const rest = unique.filter((p) => !ordered.includes(p));
    return [...ordered, ...rest].slice(0, 6);
}

function detectFocusTerm(question) {
    const raw = String(question || '').toLowerCase();
    const m = raw.match(/o que e\s+(.+)|o que é\s+(.+)/i);
    const target = m ? (m[1] || m[2] || '') : '';
    const cleaned = target
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return '';
    const parts = cleaned.split(' ').filter(Boolean);
    const stopLead = new Set(['a', 'o', 'os', 'as', 'um', 'uma']);
    const first = parts[0] || '';
    if (stopLead.has(first) && parts[1]) return parts[1];
    return first;
}

function buildFocusedDefinition(term, concepts) {
    const ordered = orderConcepts(concepts);
    if (!term) return '';
    const t = term.toLowerCase();
    if (t === 'sancao' || t === 'sanção') {
        return 'Definição: a sanção é a consequência prevista pela norma para o caso de incumprimento, ligada à coercibilidade e à tutela do ordenamento.';
    }
    if (t === 'coercibilidade') {
        return 'Definição: a coercibilidade é a possibilidade de impor o cumprimento da norma jurídica mediante meios legítimos do Estado.';
    }
    if (t === 'norma') {
        return buildDefinitionParagraph(ordered);
    }
    if (t === 'hipotese' || t === 'hipótese') {
        return 'Definição: a hipótese é a parte da norma que descreve o facto ou situação cuja ocorrência desencadeia a consequência jurídica.';
    }
    if (t === 'consequencia' || t === 'consequência') {
        return 'Definição: a consequência é o efeito jurídico previsto pela norma quando a hipótese se verifica.';
    }
    return '';
}

function buildDefinitionParagraph(concepts) {
    const ordered = orderConcepts(concepts);
    if (!ordered.length) {
        return 'Definição: a norma jurídica é uma regra de conduta que integra o ordenamento e orienta comportamentos.';
    }
    const has = (key) => ordered.includes(key);
    let sentence = 'Definição: a norma jurídica é uma regra de conduta';
    if (has('generalidade e abstração')) sentence += ' geral e abstrata';
    if (has('hipótese e consequência')) sentence += ', estruturada em hipótese e consequência';
    if (has('direitos e deveres')) sentence += ', que cria direitos e deveres';
    if (has('ordenamento jurídico')) sentence += ' no ordenamento jurídico';
    if (has('coercibilidade')) sentence += ', dotada de coercibilidade';
    if (has('sanção')) sentence += ' e sanção';
    return `${sentence}.`;
}

function buildFunctionParagraph() {
    return 'Função: assegurar previsibilidade, disciplinar a convivência social e orientar a atuação dos sujeitos sob a tutela do Estado.';
}

// ============================================
// DOUTRINA INTERNA (APENAS PARA HIROMI)
// ============================================
const DOUTRINA_DB_PATH = path.join(__dirname, '../dados/doutrina/index.db');
let doutrinaDb = null;
let doutrinaDbDisabled = false;
let doutrinaDbRetryAt = 0;
const DOUTRINA_RETRY_INTERVAL_MS = 60 * 1000;
const HIROMI_KNOWLEDGE_CACHE_TTL_MS = 10 * 60 * 1000;
let hiromiKnowledgeCache = { expiresAt: 0, concepts: [] };

function invalidateHiromiKnowledgeCache() {
    hiromiKnowledgeCache = { expiresAt: 0, concepts: [] };
    hiromiCognitive.invalidateKnowledge();
}

/**
 * Obtém o handle da base de doutrina interna.
 * Retorna null sem lançar excepção se o ficheiro não existir ou
 * se a abertura falhar — a Hiromi continua a funcionar sem doutrina.
 */
function getDoutrinaDb() {
    if (doutrinaDb) return doutrinaDb;
    if (doutrinaDbDisabled && Date.now() < doutrinaDbRetryAt) return null;
    if (doutrinaDbDisabled) {
        // Reativa tentativa após intervalo para captar index.db criado posteriormente.
        doutrinaDbDisabled = false;
    }

    if (!fs.existsSync(DOUTRINA_DB_PATH)) {
        console.warn('[hiromi][doutrina] Base de doutrina interna não encontrada:', DOUTRINA_DB_PATH);
        console.warn('[hiromi][doutrina] Fallback activado — Hiromi usará apenas fontes PostgreSQL.');
        doutrinaDbDisabled = true;
        doutrinaDbRetryAt = Date.now() + DOUTRINA_RETRY_INTERVAL_MS;
        return null;
    }

    try {
        doutrinaDb = new sqlite3.Database(DOUTRINA_DB_PATH, sqlite3.OPEN_READONLY, (error) => {
            if (error) {
                console.warn('[hiromi][doutrina] Falha ao abrir base de doutrina interna:', error.message || error);
                console.warn('[hiromi][doutrina] Fallback activado — Hiromi continuará sem doutrina.');
                doutrinaDbDisabled = true;
                doutrinaDbRetryAt = Date.now() + DOUTRINA_RETRY_INTERVAL_MS;
                doutrinaDb = null;
            } else {
                console.log('[hiromi][doutrina] Base de doutrina interna carregada:', DOUTRINA_DB_PATH);
                doutrinaDbDisabled = false;
                doutrinaDbRetryAt = 0;
            }
        });

        // Evita que erros no handle SQLite encerrem o processo.
        doutrinaDb.on('error', (error) => {
            console.warn('[hiromi][doutrina] Erro no handle SQLite — doutrina desactivada:', error?.message || error);
            doutrinaDbDisabled = true;
            doutrinaDbRetryAt = Date.now() + DOUTRINA_RETRY_INTERVAL_MS;
            try { doutrinaDb && doutrinaDb.close(); } catch (_) {}
            doutrinaDb = null;
        });
    } catch (openErr) {
        console.warn('[hiromi][doutrina] Excepção ao inicializar SQLite:', openErr?.message || openErr);
        doutrinaDbDisabled = true;
        doutrinaDbRetryAt = Date.now() + DOUTRINA_RETRY_INTERVAL_MS;
        doutrinaDb = null;
    }

    return doutrinaDb;
}

function isLikelyDoctrineIndexPage(content) {
    const raw = String(content || '').replace(/\s+/g, ' ').trim();
    if (!raw) return true;
    const lower = raw.toLowerCase();
    const hasIndexTitle = /\bíndice\b|\bsum[aá]rio\b/.test(lower.slice(0, 500));
    const dottedLines = (raw.match(/\.{5,}/g) || []).length;
    const pageRefs = (raw.match(/\b\d{1,3}\b/g) || []).length;
    return hasIndexTitle || (dottedLines >= 3 && pageRefs >= 6);
}

function parseJsonArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch (_) {
        return [];
    }
}

function buildDoctrineFtsQuery(tokens) {
    return tokens
        .map((t) => String(t || '').replace(/[^\w\-]+/g, ''))
        .filter(Boolean)
        .join(' OR ');
}

function cognitiveDoctrineScore(row, tokens, keyPhrases = []) {
    const haystack = [
        row.conceito,
        row.explicacao,
        row.tema,
        row.subtema,
        row.embedding_text,
        row.raw_text
    ].join(' ').toLowerCase();
    let lexical = 0;
    tokens.forEach((token) => {
        if (haystack.includes(String(token).toLowerCase())) lexical += 1;
    });

    let phrase = 0;
    keyPhrases.forEach((item) => {
        if (haystack.includes(String(item).toLowerCase())) phrase += 3;
    });

    const structural =
        (row.definicoes_json && row.definicoes_json !== '[]' ? 2 : 0) +
        (row.fundamentacao_json && row.fundamentacao_json !== '[]' ? 1.5 : 0) +
        (row.excecoes_json && row.excecoes_json !== '[]' ? 1 : 0) +
        (row.distincao ? 1 : 0) +
        (row.exemplo ? 0.5 : 0);

    const hierarchy = row.subtema ? 1 : 0;
    const bm25Boost = Number.isFinite(Number(row.rank)) ? Math.max(0, Math.min(2, Math.abs(Number(row.rank)) * 100000)) : 0;
    return lexical + phrase + structural + hierarchy + bm25Boost;
}

function synthesizeDoctrineUnits(units, question) {
    const validUnits = Array.isArray(units) ? units : [];
    if (!validUnits.length) return { explanation: '', snippet: '', concepts: [] };

    const definitions = [];
    const fundamentos = [];
    const excecoes = [];
    const exemplos = [];
    const distincao = [];
    const concepts = [];

    validUnits.forEach((unit) => {
        const conceito = sanitizeText(unit.conceito);
        if (conceito) concepts.push(conceito);
        parseJsonArray(unit.definicoes_json).forEach((item) => definitions.push(item));
        if (!definitions.length && unit.explicacao) definitions.push(unit.explicacao);
        parseJsonArray(unit.fundamentacao_json).forEach((item) => fundamentos.push(item));
        parseJsonArray(unit.excecoes_json).forEach((item) => excecoes.push(item));
        if (unit.exemplo) exemplos.push(unit.exemplo);
        if (unit.distincao) distincao.push(unit.distincao);
    });

    const unique = (items, max) => [...new Set(items.map(sanitizeText).filter(Boolean))].slice(0, max);
    const partes = [];
    const topConcept = unique(concepts, 1)[0] || detectFocusTerm(question) || 'Tema';
    const def = unique(definitions, 2);
    const fund = unique(fundamentos, 2);
    const exc = unique(excecoes, 2);
    const ex = unique(exemplos, 1);
    const dist = unique(distincao, 1);

    if (def.length) partes.push(`Definição: ${def[0]}`);
    if (def[1]) partes.push(`Explicação: ${def[1]}`);
    if (fund.length) partes.push(`Fundamentação: ${fund.join(' ')}`);
    if (dist.length) partes.push(`Distinção: ${dist[0]}`);
    if (exc.length) partes.push(`Exceções: ${exc.join(' ')}`);
    if (ex.length) partes.push(`Exemplo prático: ${ex[0]}`);
    if (partes.length) partes.push(`Conclusão: em síntese, ${topConcept} deve ser compreendido a partir desses elementos, articulando conceito, fundamento e limites.`);

    return {
        explanation: partes.join(' '),
        snippet: unique(validUnits.map((unit) => unit.explicacao || unit.raw_text), 1)[0] || '',
        concepts: unique(concepts, 6)
    };
}

function searchDoctrineCognitiveUnits(tokens, keyPhrases = []) {
    if (!tokens.length) return Promise.resolve([]);
    const dbHandle = getDoutrinaDb();
    if (!dbHandle) return Promise.resolve([]);
    const queryStr = buildDoctrineFtsQuery(tokens);
    if (!queryStr) return Promise.resolve([]);

    return new Promise((resolve) => {
        try {
            dbHandle.all(
                `SELECT u.*, bm25(doutrina_units_fts) AS rank
                 FROM doutrina_units_fts f
                 JOIN doutrina_units u ON u.id = f.rowid
                 WHERE doutrina_units_fts MATCH ?
                 ORDER BY rank
                 LIMIT 3`,
                [queryStr],
                (err, rows) => {
                    if (err) {
                        if (!/no such table/i.test(err.message || '')) {
                            console.warn('[hiromi][doutrina] Falha na pesquisa cognitiva:', err.message || err);
                        }
                        return resolve([]);
                    }
                    const ranked = (rows || [])
                        .map((row) => ({ ...row, cognitiveScore: cognitiveDoctrineScore(row, tokens, keyPhrases) }))
                        .sort((a, b) => b.cognitiveScore - a.cognitiveScore)
                        .slice(0, 3);
                    resolve(ranked);
                }
            );
        } catch (syncErr) {
            console.warn('[hiromi][doutrina] Excepção síncrona na pesquisa cognitiva:', syncErr?.message || syncErr);
            resolve([]);
        }
    });
}

/**
 * Pesquisa na doutrina interna com tokens.
 * Resolve sempre para array (nunca rejeita).
 */
async function searchDoutrinaInternal(tokens, keyPhrases = []) {
    if (!tokens.length) return Promise.resolve([]);
    const cognitiveUnits = await searchDoctrineCognitiveUnits(tokens, keyPhrases);
    if (cognitiveUnits.length) {
        return {
            mode: 'cognitive-units',
            units: cognitiveUnits,
            synthesis: synthesizeDoctrineUnits(cognitiveUnits, tokens.join(' '))
        };
    }

    const dbHandle = getDoutrinaDb();
    if (!dbHandle) return Promise.resolve([]);

    const queryStr = buildDoctrineFtsQuery(tokens);
    if (!queryStr) return Promise.resolve([]);

    return new Promise((resolve) => {
        try {
            dbHandle.all(
                `SELECT source, page, content, bm25(doutrina_fts) AS rank
                 FROM doutrina_fts
                 WHERE doutrina_fts MATCH ?
                 ORDER BY rank
                 LIMIT 3`,
                [queryStr],
                (err, rows) => {
                    if (err) {
                        console.warn('[hiromi][doutrina] Falha na pesquisa FTS:', err.message || err);
                        return resolve([]);
                    }
                    const filtered = (rows || []).filter((row) => !isLikelyDoctrineIndexPage(row.content)).slice(0, 3);
                    const legacyRows = filtered.length ? filtered : (rows || []).slice(0, 3);
                    resolve({
                        mode: 'legacy-pages',
                        rows: legacyRows
                    });
                }
            );
        } catch (syncErr) {
            console.warn('[hiromi][doutrina] Excepção síncrona na pesquisa:', syncErr?.message || syncErr);
            resolve({ mode: 'legacy-pages', rows: [] });
        }
    });
}

/**
 * Carrega conceitos globais da doutrina interna.
 * Resolve sempre para array (nunca rejeita).
 */
function loadDoutrinaInternalConcepts() {
    const dbHandle = getDoutrinaDb();
    if (!dbHandle) return Promise.resolve([]);

    return new Promise((resolve) => {
        try {
            dbHandle.all(
                `SELECT content FROM doutrina_fts LIMIT 1200`,
                [],
                (err, rows) => {
                    if (err) {
                        console.warn('[hiromi][doutrina] Falha ao carregar conceitos:', err.message || err);
                        return resolve([]);
                    }
                    resolve(rows || []);
                }
            );
        } catch (syncErr) {
            console.warn('[hiromi][doutrina] Excepção síncrona ao carregar conceitos:', syncErr?.message || syncErr);
            resolve([]);
        }
    });
}

/**
 * Monta o pool de conhecimento da Hiromi a partir de todas as fontes.
 * Doutrina interna é opcional — se falhar, as restantes fontes são usadas.
 * Resolve sempre para array (nunca rejeita).
 */
async function loadHiromiKnowledgeConceptPool() {
    const now = Date.now();
    if (hiromiKnowledgeCache.expiresAt > now && Array.isArray(hiromiKnowledgeCache.concepts)) {
        return hiromiKnowledgeCache.concepts;
    }

    try {
        // Cada fonte é isolada para que a falha de uma não afecte as outras.
        const [formacaoRows, legislacaoRows, jurisprudenciaRows, doutrinaRows] = await Promise.all([
            pgQuery(`SELECT conteudo_html FROM home_fase_conteudos`).catch((e) => {
                console.warn('[hiromi][pool] Falha ao carregar formação:', e?.message);
                return { rows: [] };
            }),
            pgQuery(`SELECT nome, descricao, fundamentacao FROM legislacoes`).catch((e) => {
                console.warn('[hiromi][pool] Falha ao carregar legislação:', e?.message);
                return { rows: [] };
            }),
            pgQuery(`SELECT nome, referencias, conteudo_html FROM jurisprudencias`).catch((e) => {
                console.warn('[hiromi][pool] Falha ao carregar jurisprudência:', e?.message);
                return { rows: [] };
            }),
            loadDoutrinaInternalConcepts() // já trata os seus próprios erros
        ]);

        const conceptSet = new Set();
        const appendConcepts = (text) => {
            extractConceptSignals(text).forEach((c) => conceptSet.add(c));
        };

        formacaoRows.rows.forEach((row) => {
            appendConcepts(`${row.conteudo_html || ''}`);
        });
        legislacaoRows.rows.forEach((row) => {
            appendConcepts(`${row.nome || ''} ${row.descricao || ''} ${row.fundamentacao || ''}`);
        });
        jurisprudenciaRows.rows.forEach((row) => {
            appendConcepts(`${row.nome || ''} ${row.referencias || ''} ${row.conteudo_html || ''}`);
        });
        doutrinaRows.forEach((row) => {
            appendConcepts(row.content || '');
        });

        const concepts = orderConcepts([...conceptSet]);
        hiromiKnowledgeCache = {
            expiresAt: now + HIROMI_KNOWLEDGE_CACHE_TTL_MS,
            concepts
        };

        const doutrinaAtiva = !doutrinaDbDisabled && doutrinaRows.length > 0;
        console.log(
            `[hiromi][pool] Cache actualizado — ${concepts.length} conceito(s). ` +
            `Fontes: formação(${formacaoRows.rows.length}) legislação(${legislacaoRows.rows.length}) ` +
            `jurisprudência(${jurisprudenciaRows.rows.length}) doutrina(${doutrinaAtiva ? doutrinaRows.length : 'inactiva/ausente'})`
        );

        return concepts;
    } catch (error) {
        console.warn('[hiromi][pool] Falha ao montar pool de conhecimento:', error?.message || error);
        return [];
    }
}

function buildTokenWhere(tokens, columns, paramStart) {
    if (!tokens.length) {
        return { clause: '', params: [] };
    }
    const params = [];
    const clauseParts = tokens.map((token, idx) => {
        params.push(`%${token}%`);
        const paramRef = `$${paramStart + idx}`;
        const colParts = columns.map((col) => `${col} ILIKE ${paramRef}`);
        return `(${colParts.join(' OR ')})`;
    });
    return { clause: clauseParts.join(' OR '), params };
}

function buildHiromiAnswer(question, sources) {
    if (!sources.length) {
        return `Não encontrei conteúdo relacionado a "${question}". Tente usar termos mais específicos (ex.: artigo, tribunal, disciplina).`;
    }
    const tipos = [...new Set(sources.map((s) => s.tipo).filter(Boolean))];
    const tiposTexto = tipos.length ? ` (${tipos.join(', ')})` : '';

    const respostaPartes = [];
    const artigos = sources.filter((s) => s.tipo === 'artigo');
    const leis = sources.filter((s) => s.tipo === 'legislacao');
    const jurisprudencias = sources.filter((s) => s.tipo === 'jurisprudencia');
    const formacao = sources.filter((s) => s.tipo === 'formacao');
    const formacaoPoints = formacao.flatMap((s) => s.points || []);
    const internos = sources.filter((s) => s.tipo === 'internal');
    const knowledge = sources.filter((s) => s.tipo === 'knowledge');
    const conceptSignals = [
        ...formacao.flatMap((s) => s.concepts || []),
        ...internos.flatMap((s) => s.concepts || []),
        ...knowledge.flatMap((s) => s.concepts || [])
    ];
    const focusTerm = detectFocusTerm(question);
    const focusedDefinition = buildFocusedDefinition(focusTerm, conceptSignals);
    const hasNormaLikeFocus = /(norma|sancao|sanção|coercibilidade|hipotese|hipótese|consequencia|consequência)/i.test(focusTerm || '');
    const genericDefinitionAllowed =
        hasNormaLikeFocus
        || /norma jur[ií]dica|coercibilidade|san[cç][aã]o|hip[oó]tese|consequ[eê]ncia|ordenamento jur[ií]dico/i.test(String(question || ''));
    const wantsLegalBasis = questionWantsLegalBasis(question);
    const explicacaoPreferencial =
        (wantsLegalBasis ? '' : formacao.find((s) => s.explanation)?.explanation) ||
        internos.find((s) => s.explanation)?.explanation ||
        jurisprudencias.find((s) => s.explanation)?.explanation ||
        leis.find((s) => s.explanation)?.explanation ||
        '';
    const snippetPreferencial =
        (wantsLegalBasis ? '' : formacao.find((s) => s.snippet)?.snippet) ||
        internos.find((s) => s.snippet)?.snippet ||
        jurisprudencias.find((s) => s.snippet)?.snippet ||
        leis.find((s) => s.snippet)?.snippet ||
        '';

    const articlesOnly = questionWantsArticlesOnly(question);

    const legalSummary = wantsLegalBasis && (artigos.length || leis.length || jurisprudencias.length)
        ? buildLegalBasisSummary(question, artigos, leis, jurisprudencias, snippetPreferencial)
        : '';

    if (!articlesOnly) {
        if (legalSummary) {
            respostaPartes.push(legalSummary);
        } else if (explicacaoPreferencial) {
            respostaPartes.push(explicacaoPreferencial);
        } else if (snippetPreferencial) {
            respostaPartes.push(`Síntese: ${snippetPreferencial}`);
        } else if (conceptSignals.length) {
            const sinaisUnicos = [...new Set(conceptSignals)];
            if (focusedDefinition) {
                respostaPartes.push(focusedDefinition);
            } else if (genericDefinitionAllowed) {
                respostaPartes.push(buildDefinitionParagraph(sinaisUnicos));
                respostaPartes.push(buildFunctionParagraph());
            }
        } else if (formacaoPoints.length) {
            respostaPartes.push('Síntese: o conteúdo formativo descreve o tema com foco nos elementos essenciais e estrutura normativa.');
            respostaPartes.push(`Pontos centrais: ${formacaoPoints.slice(0, 8).join(', ')}.`);
        } else {
            respostaPartes.push(`Encontrei ${sources.length} conteúdos relevantes${tiposTexto} para a tua pergunta.`);
        }
    }

    if (wantsLegalBasis) {
        if (artigos.length) {
            const artigosEnumerados = artigos.slice(0, 6).map((s, idx) => `${idx + 1}. ${s.label}`);
            respostaPartes.push(`Base legal explícita (artigos): ${artigosEnumerados.join(' ')}`);
        } else if (leis.length) {
            const lista = leis.slice(0, 3).map((s) => s.label).join('; ');
            respostaPartes.push(`Base legal explícita: ${lista}.`);
        } else {
            respostaPartes.push('Base legal explícita: não encontrei artigos associados no banco. Confirma se a legislação foi importada para a tabela de artigos.');
        }
    }

    if (!respostaPartes.length) {
        respostaPartes.push(`Encontrei ${sources.length} conteúdos relevantes${tiposTexto} para a tua pergunta.`);
    }

    return `${respostaPartes.join(' ')}`;
}

function buildLegalBasisSummary(question, artigos, leis, jurisprudencias, snippetPreferencial) {
    if (artigos.length) {
        return `Para esta pergunta, a base legal mais direta está nos artigos listados abaixo. Eles devem ser consultados primeiro como suporte jurídico principal.`;
    }
    if (leis.length) {
        return `Esta questão depende da legislação indicada abaixo. Use essas leis como fundamento normativo, complementando com a interpretação jurídica disponível.`;
    }
    if (jurisprudencias.length) {
        return `A base normativa mais forte aqui é jurisprudencial. Use as decisões listadas para apoiar a interpretação dos conceitos jurídicos.`;
    }
    if (snippetPreferencial) {
        return `Em síntese: ${snippetPreferencial}`;
    }
    return '';
}

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function countWords(text) {
    const clean = sanitizeText(text);
    if (!clean) return 0;
    return clean.split(/\s+/).length;
}

function hashAdminKey(chave) {
    return crypto.createHash('sha256').update(String(chave || '')).digest('hex');
}

const ADMIN_CAPABILITIES = {
    CONTENT: 'content.manage',
    ADMINS: 'admins.manage'
};

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

function normalizarAdminRole(role) {
    const clean = String(role || '').trim().toLowerCase();
    if (clean === 'bootstrap') return 'bootstrap';
    if (clean === 'content') return 'content';
    return 'general';
}

function capacidadesPorRole(role) {
    const normalized = normalizarAdminRole(role);
    if (normalized === 'content') return [ADMIN_CAPABILITIES.CONTENT];
    return [ADMIN_CAPABILITIES.CONTENT, ADMIN_CAPABILITIES.ADMINS];
}

function normalizarCapacidades(role, rawCapabilities) {
    const allowed = new Set(capacidadesPorRole(role));
    const requested = parseJsonArray(rawCapabilities)
        .map((item) => String(item || '').trim())
        .filter((item) => allowed.has(item));
    return requested.length ? [...new Set(requested)] : [...allowed];
}

function isAdminAtivo(row) {
    if (!row || row.is_admin !== true) return false;
    if (row.admin_revoked_at) return false;
    if (row.admin_expires_at && new Date(row.admin_expires_at).getTime() <= Date.now()) return false;
    return true;
}

function adminProfileFromRow(row) {
    if (!isAdminAtivo(row)) {
        return {
            active: false,
            role: null,
            capabilities: [],
            promotedBy: row?.admin_promoted_by || null,
            expiresAt: row?.admin_expires_at || null,
            revokedAt: row?.admin_revoked_at || null
        };
    }
    const role = normalizarAdminRole(row.admin_role || 'general');
    return {
        active: true,
        role,
        capabilities: normalizarCapacidades(role, row.admin_capabilities),
        promotedBy: row.admin_promoted_by || null,
        expiresAt: row.admin_expires_at || null,
        revokedAt: null
    };
}

async function buscarAdminAtivoOuFalhar(req, res, capability = null) {
    const userRow = await buscarUsuarioPorId(req.user.userId);
    const admin = adminProfileFromRow(userRow);
    if (!admin.active) {
        res.status(403).json({ error: 'Apenas administradores ativos podem executar esta ação' });
        return null;
    }
    if (capability && !admin.capabilities.includes(capability)) {
        res.status(403).json({ error: 'Administrador sem capacidade para esta ação' });
        return null;
    }
    req.adminUser = userRow;
    req.adminProfile = admin;
    return userRow;
}

function requireAdminCapability(capability) {
    return async (req, res, next) => {
        try {
            const admin = await buscarAdminAtivoOuFalhar(req, res, capability);
            if (!admin) return;
            next();
        } catch (error) {
            console.error('Erro ao verificar capacidade admin:', error);
            res.status(500).json({ error: 'Erro ao verificar permissões administrativas' });
        }
    };
}

function requireActiveAdmin(req, res, next) {
    buscarAdminAtivoOuFalhar(req, res)
        .then((admin) => {
            if (admin) next();
        })
        .catch((error) => {
            console.error('Erro ao verificar admin ativo:', error);
            res.status(500).json({ error: 'Erro ao verificar permissões administrativas' });
        });
}

async function contarAdminsAtivos() {
    const { rows } = await pgQuery(
        `SELECT COUNT(1)::int AS total
         FROM users
         WHERE is_admin = TRUE
           AND admin_revoked_at IS NULL
           AND (admin_expires_at IS NULL OR admin_expires_at > NOW())`
    );
    return rows[0]?.total || 0;
}

async function buscarUltimoUploadAudit(contentId, eventTypes = []) {
    if (!contentId || !eventTypes.length) return null;
    const placeholders = eventTypes.map((_, index) => `$${index + 2}`).join(', ');
    const { rows } = await pgQuery(
        `SELECT a.user_id, a.meta, a.created_at, u.username
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE a.meta->>'id' = $1
           AND a.event_type IN (${placeholders})
         ORDER BY a.created_at DESC
         LIMIT 1`,
        [contentId, ...eventTypes]
    );
    return rows[0] || null;
}

async function migrarUsuariosSQLiteParaPostgres() {
    const { rows } = await pgQuery('SELECT COUNT(1)::int AS total FROM users');
    if ((rows[0]?.total || 0) > 0) return;

    const usuariosSqlite = await new Promise((resolve) => {
        db.all(
            `SELECT id, email, username, username_normalized, password_hash, nome_completo, isAdmin, created_at
             FROM users`,
            [],
            (err, data) => {
                if (err) {
                    console.warn('⚠️ Falha ao ler usuários do SQLite para migração:', err.message);
                    return resolve([]);
                }
                resolve(data || []);
            }
        );
    });

    if (!usuariosSqlite.length) return;

    for (const user of usuariosSqlite) {
        await pgQuery(
            `INSERT INTO users
             (id, email, username, username_normalized, password_hash, nome_completo, is_admin, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamp, NOW()), NOW())
             ON CONFLICT (id) DO NOTHING`,
            [
                user.id,
                user.email,
                user.username,
                user.username_normalized,
                user.password_hash,
                user.nome_completo || '',
                user.isAdmin === 1,
                user.created_at || null
            ]
        );
    }

    console.log(`✅ Migração inicial SQLite -> PostgreSQL concluída (${usuariosSqlite.length} usuários)`);
}

app.post('/api/admin/redeem-key', authenticateToken, async (req, res) => {
    const accessKey = String(req.body?.accessKey || '').trim();
    if (!accessKey) {
        return res.status(400).json({ error: 'Chave de acesso obrigatória' });
    }

    const keyHash = hashAdminKey(accessKey);
    try {
        const { rows } = await pgQuery(
            `SELECT id, created_by, target_role, target_capabilities, expires_at
             FROM admin_access_keys
             WHERE key_hash = $1
               AND revoked = FALSE
               AND used_by IS NULL
               AND (expires_at IS NULL OR expires_at > NOW())
             LIMIT 1`,
            [keyHash]
        );
        const key = rows[0];
        if (!key) {
            return res.status(400).json({ error: 'Chave inválida, expirada ou já utilizada' });
        }
        const role = normalizarAdminRole(key.target_role);
        const capabilities = normalizarCapacidades(role, key.target_capabilities);

        await pgQuery(
            `UPDATE users
             SET is_admin = TRUE,
                 admin_role = $2,
                 admin_capabilities = $3::jsonb,
                 admin_promoted_by = $4,
                 admin_expires_at = $5,
                 admin_revoked_at = NULL,
                 admin_revoked_by = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [
                req.user.userId,
                role,
                JSON.stringify(capabilities),
                key.created_by || null,
                key.expires_at || null
            ]
        );
        await pgQuery(
            `UPDATE admin_access_keys
             SET used_by = $1, used_at = NOW()
             WHERE id = $2`,
            [req.user.userId, key.id]
        );
        await logAudit('admin_promoted', req.user.userId, req.ip, {
            actorId: key.created_by || null,
            targetUserId: req.user.userId,
            role,
            capabilities,
            expiresAt: key.expires_at || null,
            via: 'access_key',
            keyId: key.id
        });

        const userRow = await buscarUsuarioPorId(req.user.userId);
        const token = gerarTokenUsuario(userRow);
        res.json({
            success: true,
            message: 'Conta promovida para administrador',
            token,
            user: mapPgUser(userRow)
        });
    } catch (error) {
        console.error('Erro ao resgatar chave admin:', error);
        res.status(500).json({ error: 'Erro ao resgatar chave admin' });
    }
});

app.post('/api/admin/bootstrap', authenticateToken, async (req, res) => {
    const bootstrapKey = String(req.body?.bootstrapKey || '').trim();
    const expectedKey = String(process.env.ADMIN_BOOTSTRAP_KEY || '').trim();

    if (!expectedKey) {
        return res.status(400).json({ error: 'ADMIN_BOOTSTRAP_KEY não configurada no servidor' });
    }
    if (!bootstrapKey || bootstrapKey !== expectedKey) {
        return res.status(403).json({ error: 'Chave de bootstrap inválida' });
    }

    try {
        const totalAdmins = await contarAdminsAtivos();
        if (totalAdmins > 0) {
            return res.status(409).json({ error: 'Bootstrap disponível apenas enquanto não existir admin' });
        }

        await pgQuery(
            `UPDATE users
             SET is_admin = TRUE,
                 admin_role = 'bootstrap',
                 admin_capabilities = $2::jsonb,
                 admin_promoted_by = NULL,
                 admin_expires_at = NULL,
                 admin_revoked_at = NULL,
                 admin_revoked_by = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [req.user.userId, JSON.stringify(capacidadesPorRole('bootstrap'))]
        );
        await logAudit('admin_bootstrap', req.user.userId, req.ip, {
            targetUserId: req.user.userId,
            role: 'bootstrap'
        });
        const userRow = await buscarUsuarioPorId(req.user.userId);
        const token = gerarTokenUsuario(userRow);
        return res.json({
            success: true,
            message: 'Bootstrap concluído. Conta promovida para administrador.',
            token,
            user: mapPgUser(userRow)
        });
    } catch (error) {
        console.error('Erro no bootstrap admin:', error);
        return res.status(500).json({ error: 'Erro no bootstrap admin' });
    }
});

app.get('/api/admin/status', authenticateToken, async (req, res) => {
    try {
        const [userRow, totalAdmins] = await Promise.all([
            buscarUsuarioPorId(req.user.userId),
            contarAdminsAtivos()
        ]);
        res.json({
            bootstrapAvailable: totalAdmins === 0,
            totalActiveAdmins: totalAdmins,
            user: mapPgUser(userRow)
        });
    } catch (error) {
        console.error('Erro ao carregar status admin:', error);
        res.status(500).json({ error: 'Erro ao carregar status admin' });
    }
});

app.get('/api/admin/users', authenticateToken, requireAdminCapability(ADMIN_CAPABILITIES.ADMINS), async (req, res) => {
    try {
        const { rows } = await pgQuery(
            `SELECT u.id, u.email, u.username, u.nome_completo, u.is_admin, u.admin_role,
                    u.admin_capabilities, u.admin_promoted_by, u.admin_expires_at,
                    u.admin_revoked_at, u.admin_revoked_by, u.created_at, u.updated_at,
                    promoter.username AS promoted_by_username,
                    revoker.username AS revoked_by_username
             FROM users u
             LEFT JOIN users promoter ON promoter.id = u.admin_promoted_by
             LEFT JOIN users revoker ON revoker.id = u.admin_revoked_by
             WHERE u.is_admin = TRUE OR u.admin_role IS NOT NULL
             ORDER BY u.admin_revoked_at NULLS FIRST, u.admin_role, u.username`
        );
        res.json({
            admins: rows.map((row) => ({
                ...mapPgUser(row),
                email: row.email,
                promotedByUsername: row.promoted_by_username || null,
                revokedByUsername: row.revoked_by_username || null,
                canRevoke: adminProfileFromRow(req.adminUser).role === 'bootstrap'
                    || row.admin_promoted_by === req.user.userId
            }))
        });
    } catch (error) {
        console.error('Erro ao listar administradores:', error);
        res.status(500).json({ error: 'Erro ao listar administradores' });
    }
});

app.post('/api/admin/users/:userId/revoke', authenticateToken, requireAdminCapability(ADMIN_CAPABILITIES.ADMINS), async (req, res) => {
    const targetUserId = String(req.params.userId || '').trim();
    const reason = sanitizeText(req.body?.reason || '');
    if (!targetUserId) {
        return res.status(400).json({ error: 'ID do administrador é obrigatório' });
    }
    if (targetUserId === req.user.userId) {
        return res.status(400).json({ error: 'Não pode retirar os próprios privilégios por esta rota' });
    }

    try {
        const target = await buscarUsuarioPorId(targetUserId);
        if (!target || !isAdminAtivo(target)) {
            return res.status(404).json({ error: 'Administrador ativo não encontrado' });
        }
        const actorProfile = adminProfileFromRow(req.adminUser);
        const canRevoke = actorProfile.role === 'bootstrap' || target.admin_promoted_by === req.user.userId;
        if (!canRevoke) {
            return res.status(403).json({ error: 'Só o promotor original ou o admin bootstrap pode retirar estes privilégios' });
        }

        const { rows } = await pgQuery(
            `UPDATE users
             SET is_admin = FALSE,
                 admin_revoked_at = NOW(),
                 admin_revoked_by = $2,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING id, email, username, nome_completo, instituicao, nivel_academico, is_admin,
                       admin_role, admin_capabilities, admin_promoted_by, admin_expires_at, admin_revoked_at`,
            [targetUserId, req.user.userId]
        );
        await logAudit('admin_revoked', req.user.userId, req.ip, {
            targetUserId,
            previousRole: target.admin_role,
            reason: reason || null
        });
        res.json({ success: true, user: mapPgUser(rows[0]) });
    } catch (error) {
        console.error('Erro ao retirar privilégios admin:', error);
        res.status(500).json({ error: 'Erro ao retirar privilégios admin' });
    }
});

app.get('/api/admin/audit-logs', authenticateToken, requireAdminCapability(ADMIN_CAPABILITIES.ADMINS), async (req, res) => {
    try {
        const { rows } = await pgQuery(
            `SELECT a.id, a.event_type, a.user_id, a.ip, a.meta, a.created_at, u.username
             FROM audit_logs a
             LEFT JOIN users u ON u.id = a.user_id
             WHERE a.event_type LIKE 'admin_%'
                OR a.event_type LIKE 'content_%'
                OR a.event_type LIKE 'legislacao_%'
                OR a.event_type LIKE 'jurisprudencia_%'
             ORDER BY a.created_at DESC
             LIMIT 80`
        );
        res.json({ logs: rows });
    } catch (error) {
        console.error('Erro ao carregar auditoria admin:', error);
        res.status(500).json({ error: 'Erro ao carregar auditoria admin' });
    }
});

app.post('/api/admin/access-keys', authenticateToken, requireAdminCapability(ADMIN_CAPABILITIES.ADMINS), async (req, res) => {
    const ttlHoursRaw = req.body?.ttlHours;
    const indefinite = req.body?.indefinite === true;
    const ttlHours = Number(ttlHoursRaw || 24);
    const descricao = String(req.body?.descricao || '').trim();
    const role = normalizarAdminRole(req.body?.role || 'general');
    const capabilities = normalizarCapacidades(role, req.body?.capabilities);
    const keyPlain = crypto.randomBytes(24).toString('hex');
    const keyHash = hashAdminKey(keyPlain);
    const keyId = uuidv4();
    const expiresAt = indefinite
        ? null
        : Number.isFinite(ttlHours) && ttlHours > 0
        ? new Date(Date.now() + ttlHours * 60 * 60 * 1000)
        : null;

    try {
        await pgQuery(
            `INSERT INTO admin_access_keys
             (id, key_hash, descricao, created_by, target_role, target_capabilities, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
            [keyId, keyHash, descricao || null, req.user.userId, role, JSON.stringify(capabilities), expiresAt]
        );
        await logAudit('admin_access_key_created', req.user.userId, req.ip, {
            keyId,
            role,
            capabilities,
            expiresAt,
            indefinite
        });
        res.status(201).json({
            success: true,
            keyId,
            accessKey: keyPlain,
            role,
            capabilities,
            expiresAt
        });
    } catch (error) {
        console.error('Erro ao gerar chave admin:', error);
        res.status(500).json({ error: 'Erro ao gerar chave admin' });
    }
});

// ============================================
// ROTAS DE JURISPRUDÊNCIA
// ============================================
app.get('/api/jurisprudencias', async (req, res) => {
    try {
        const { rows } = await pgQuery(
            `SELECT id, tribunal, ano, nome, referencias, updated_at
             FROM jurisprudencias
             ORDER BY updated_at DESC`
        );
        res.json(rows);
    } catch (error) {
        console.error('Erro ao listar jurisprudências:', error);
        res.status(500).json({ error: 'Erro ao listar jurisprudências' });
    }
});

app.get('/api/jurisprudencias/lookup', async (req, res) => {
    const tribunal = sanitizeText(req.query.tribunal);
    const anoRaw = sanitizeText(req.query.ano);
    const id = sanitizeText(req.query.id);
    const ano = Number.parseInt(anoRaw, 10);

    if (!tribunal || !ano || !id) {
        return res.status(400).json({ error: 'tribunal, ano e id são obrigatórios' });
    }

    try {
        const { rows } = await pgQuery(
            `SELECT id, tribunal, ano, nome, referencias, conteudo_html, updated_at
             FROM jurisprudencias
             WHERE id = $1 AND tribunal = $2 AND ano = $3
             LIMIT 1`,
            [id, tribunal, ano]
        );

        if (!rows.length) {
            return res.status(404).json({ error: 'Jurisprudência não encontrada' });
        }

        const item = rows[0];
        res.json({
            id: item.id,
            tribunal: item.tribunal,
            ano: item.ano,
            nome: item.nome,
            referencias: item.referencias,
            conteudoHtml: item.conteudo_html,
            updatedAt: item.updated_at
        });
    } catch (error) {
        console.error('Erro ao buscar jurisprudência:', error);
        res.status(500).json({ error: 'Erro ao buscar jurisprudência' });
    }
});

app.post('/api/jurisprudencias', authenticateToken, requireAdminCapability(ADMIN_CAPABILITIES.CONTENT), async (req, res) => {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Payload JSON inválido' });
    }

    const tribunal = sanitizeText(payload.tribunal);
    const anoRaw = sanitizeText(payload.ano);
    const ano = Number.parseInt(anoRaw, 10);
    const nome = sanitizeText(payload.nome || payload.titulo);
    const referencias = sanitizeText(payload.referencias);
    const conteudoHtml = String(payload.conteudoHtml || '').trim();

    if (!tribunal || !ano || !nome || !conteudoHtml) {
        return res.status(400).json({ error: 'tribunal, ano, nome e conteudoHtml são obrigatórios' });
    }

    const id = sanitizeText(payload.id) || slugify(`${tribunal}-${ano}-${nome}`) || uuidv4();

    try {
        await pgQuery(
            `INSERT INTO jurisprudencias
             (id, tribunal, ano, nome, referencias, conteudo_html, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (id) DO UPDATE SET
               tribunal = EXCLUDED.tribunal,
               ano = EXCLUDED.ano,
               nome = EXCLUDED.nome,
               referencias = EXCLUDED.referencias,
               conteudo_html = EXCLUDED.conteudo_html,
               updated_at = NOW()`,
            [id, tribunal, ano, nome, referencias || null, conteudoHtml]
        );
        invalidateHiromiKnowledgeCache();
        await logAudit('content_jurisprudencia_upserted', req.user.userId, req.ip, {
            action: 'upload',
            id,
            titulo: nome,
            tribunal,
            ano,
            uploadedAt: new Date().toISOString()
        });

        res.status(201).json({
            success: true,
            jurisprudencia: { id, tribunal, ano, nome }
        });
    } catch (error) {
        console.error('Erro ao guardar jurisprudência:', error);
        res.status(500).json({ error: 'Erro ao guardar jurisprudência' });
    }
});

app.put('/api/jurisprudencias/:id', authenticateToken, requireAdminCapability(ADMIN_CAPABILITIES.CONTENT), async (req, res) => {
    const idParam = sanitizeText(req.params.id);
    const payload = req.body || {};

    if (!idParam) {
        return res.status(400).json({ error: 'ID da jurisprudência é obrigatório' });
    }

    const tribunal = sanitizeText(payload.tribunal);
    const anoRaw = sanitizeText(payload.ano);
    const ano = Number.parseInt(anoRaw, 10);
    const nome = sanitizeText(payload.nome || payload.titulo);
    const referencias = sanitizeText(payload.referencias);
    const conteudoHtml = String(payload.conteudoHtml || '').trim();

    if (!tribunal || !ano || !nome || !conteudoHtml) {
        return res.status(400).json({ error: 'tribunal, ano, nome e conteudoHtml são obrigatórios' });
    }

    try {
        const { rowCount } = await pgQuery(
            `UPDATE jurisprudencias
             SET tribunal = $1, ano = $2, nome = $3, referencias = $4,
                 conteudo_html = $5, updated_at = NOW()
             WHERE id = $6`,
            [tribunal, ano, nome, referencias || null, conteudoHtml, idParam]
        );
        invalidateHiromiKnowledgeCache();

        if (!rowCount) {
            return res.status(404).json({ error: 'Jurisprudência não encontrada' });
        }
        await logAudit('content_jurisprudencia_updated', req.user.userId, req.ip, {
            action: 'upload',
            id: idParam,
            titulo: nome,
            tribunal,
            ano,
            uploadedAt: new Date().toISOString()
        });

        res.json({ success: true, id: idParam });
    } catch (error) {
        console.error('Erro ao atualizar jurisprudência:', error);
        res.status(500).json({ error: 'Erro ao atualizar jurisprudência' });
    }
});

app.delete('/api/jurisprudencias/:id', authenticateToken, requireAdminCapability(ADMIN_CAPABILITIES.CONTENT), async (req, res) => {
    const idParam = sanitizeText(req.params.id);
    const reason = sanitizeText(req.body?.reason || req.body?.fundamentacao || '');
    if (!idParam) {
        return res.status(400).json({ error: 'ID da jurisprudência é obrigatório' });
    }
    if (!reason) {
        return res.status(400).json({ error: 'Fundamentação da eliminação é obrigatória' });
    }

    try {
        const { rows: existingRows } = await pgQuery(
            `SELECT id, nome, tribunal, ano, updated_at
             FROM jurisprudencias
             WHERE id = $1
             LIMIT 1`,
            [idParam]
        );
        const existing = existingRows[0];
        if (!existing) {
            return res.status(404).json({ error: 'Jurisprudência não encontrada' });
        }
        const uploadAudit = await buscarUltimoUploadAudit(idParam, [
            'content_jurisprudencia_upserted',
            'content_jurisprudencia_updated'
        ]);
        const { rowCount } = await pgQuery('DELETE FROM jurisprudencias WHERE id = $1', [idParam]);
        if (!rowCount) {
            return res.status(404).json({ error: 'Jurisprudência não encontrada' });
        }
        invalidateHiromiKnowledgeCache();
        await logAudit('content_jurisprudencia_deleted', req.user.userId, req.ip, {
            action: 'delete',
            id: idParam,
            titulo: existing.nome,
            tribunal: existing.tribunal,
            ano: existing.ano,
            uploadedAt: uploadAudit?.meta?.uploadedAt || uploadAudit?.created_at || existing.updated_at,
            uploadedBy: uploadAudit?.username || uploadAudit?.user_id || null,
            deletedAt: new Date().toISOString(),
            reason
        });
        res.json({ success: true, id: idParam });
    } catch (error) {
        console.error('Erro ao eliminar jurisprudência:', error);
        res.status(500).json({ error: 'Erro ao eliminar jurisprudência' });
    }
});

// ============================================
// ROTAS DE LEGISLAÇÃO
// ============================================

app.get('/api/legislacoes', async (req, res) => {
    try {
        const { rows } = await pgQuery(
            'SELECT id, nome, descricao FROM legislacoes ORDER BY nome'
        );
        res.json(rows);
    } catch (err) {
        console.error("Erro ao buscar legislações:", err);
        res.status(500).json({ error: 'Erro ao buscar legislações' });
    }
});

app.post('/api/legislacoes/importar', authenticateToken, requireAdminCapability(ADMIN_CAPABILITIES.CONTENT), async (req, res) => {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Payload JSON inválido' });
    }

    try {
        const result = await importarLegislacaoJson(payload);
        invalidateHiromiKnowledgeCache();
        await logAudit('content_legislacao_imported', req.user.userId, req.ip, {
            action: 'upload',
            id: result?.id || null,
            titulo: result?.nome || payload?.nome || null,
            uploadedAt: new Date().toISOString()
        });
        return res.status(201).json({
            success: true,
            message: 'Legislação importada com sucesso',
            legislacao: result
        });
    } catch (error) {
        console.error('Erro ao importar legislação via API:', error);
        return res.status(400).json({ error: error.message || 'Falha ao importar legislação' });
    }
});

app.delete('/api/legislacoes/:id', authenticateToken, requireAdminCapability(ADMIN_CAPABILITIES.CONTENT), async (req, res) => {
    const legislacaoId = String(req.params.id || '').trim();
    const reason = sanitizeText(req.body?.reason || req.body?.fundamentacao || '');
    if (!legislacaoId) {
        return res.status(400).json({ error: 'ID da legislação é obrigatório' });
    }
    if (!reason) {
        return res.status(400).json({ error: 'Fundamentação da eliminação é obrigatória' });
    }

    try {
        const { rows: existingRows } = await pgQuery(
            `SELECT id, nome, created_at
             FROM legislacoes
             WHERE id = $1
             LIMIT 1`,
            [legislacaoId]
        );
        const existing = existingRows[0];
        if (!existing) {
            return res.status(404).json({ error: 'Legislação não encontrada' });
        }
        const uploadAudit = await buscarUltimoUploadAudit(legislacaoId, ['content_legislacao_imported']);
        const { rowCount } = await pgQuery('DELETE FROM legislacoes WHERE id = $1', [legislacaoId]);
        if (!rowCount) {
            return res.status(404).json({ error: 'Legislação não encontrada' });
        }
        invalidateHiromiKnowledgeCache();
        await logAudit('content_legislacao_deleted', req.user.userId, req.ip, {
            action: 'delete',
            id: legislacaoId,
            titulo: existing.nome,
            uploadedAt: uploadAudit?.meta?.uploadedAt || uploadAudit?.created_at || existing.created_at,
            uploadedBy: uploadAudit?.username || uploadAudit?.user_id || null,
            deletedAt: new Date().toISOString(),
            reason
        });
        return res.json({ success: true, id: legislacaoId });
    } catch (error) {
        console.error('Erro ao eliminar legislação:', error);
        return res.status(500).json({ error: 'Erro ao eliminar legislação' });
    }
});

app.get('/api/legislacoes/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const { rows: legislacoesRows } = await pgQuery(
            'SELECT * FROM legislacoes WHERE id = $1 LIMIT 1',
            [id]
        );
        const legislacao = legislacoesRows[0];
        
        if (!legislacao) {
            return res.status(404).json({ error: 'Legislação não encontrada' });
        }
        
        const { rows: estruturas } = await pgQuery(
            `WITH RECURSIVE estrutura_tree AS (
                SELECT * FROM estruturas WHERE legislacao_id = $1 AND parent_id IS NULL
                UNION ALL
                SELECT e.*
                FROM estruturas e
                JOIN estrutura_tree et ON e.parent_id = et.id
             )
             SELECT * FROM estrutura_tree ORDER BY nivel, ordem`,
            [id]
        );

        const { rows: artigos } = await pgQuery(
            `SELECT *
             FROM artigos
             WHERE legislacao_id = $1
             ORDER BY
               CASE WHEN numero ~ '^[0-9]+$' THEN 0 ELSE 1 END,
               CASE WHEN numero ~ '^[0-9]+$' THEN CAST(numero AS INTEGER) ELSE 0 END,
               numero`,
            [id]
        );

        const artigoIds = artigos.map((a) => a.id);
        const { rows: paragrafos } = artigoIds.length
            ? await pgQuery(
                `SELECT *
                 FROM paragrafos
                 WHERE artigo_id = ANY($1::text[])
                 ORDER BY artigo_id,
                   CASE WHEN ordem IS NULL THEN 1 ELSE 0 END, ordem,
                   CASE WHEN numero = 'caput' THEN -1 ELSE 0 END, numero`,
                [artigoIds]
            )
            : { rows: [] };

        const paragrafoIds = paragrafos.map((p) => p.id);
        const { rows: alineasDeParagrafos } = paragrafoIds.length
            ? await pgQuery(
                `SELECT *
                 FROM alineas
                 WHERE paragrafo_id = ANY($1::text[])
                 ORDER BY paragrafo_id,
                   CASE WHEN ordem IS NULL THEN 1 ELSE 0 END, ordem, letra`,
                [paragrafoIds]
            )
            : { rows: [] };

        const { rows: alineasArtigo } = artigoIds.length
            ? await pgQuery(
                `SELECT *
                 FROM alineas
                 WHERE artigo_id = ANY($1::text[])
                 ORDER BY artigo_id,
                   CASE WHEN ordem IS NULL THEN 1 ELSE 0 END, ordem, letra`,
                [artigoIds]
            )
            : { rows: [] };

        const paragrafosPorArtigo = new Map();
        paragrafos.forEach((p) => {
            if (!paragrafosPorArtigo.has(p.artigo_id)) paragrafosPorArtigo.set(p.artigo_id, []);
            paragrafosPorArtigo.get(p.artigo_id).push({
                id: p.id, numero: p.numero, conteudo: p.conteudo, ordem: p.ordem, alineas: []
            });
        });

        const paragrafosIndex = new Map();
        paragrafosPorArtigo.forEach((items) => {
            items.forEach((p) => paragrafosIndex.set(p.id, p));
        });

        alineasDeParagrafos.forEach((a) => {
            const alvo = paragrafosIndex.get(a.paragrafo_id);
            if (alvo) {
                alvo.alineas.push({ id: a.id, letra: a.letra, conteudo: a.conteudo, ordem: a.ordem });
            }
        });

        const alineasPorArtigo = new Map();
        alineasArtigo.forEach((a) => {
            if (!alineasPorArtigo.has(a.artigo_id)) alineasPorArtigo.set(a.artigo_id, []);
            alineasPorArtigo.get(a.artigo_id).push({ id: a.id, letra: a.letra, conteudo: a.conteudo, ordem: a.ordem });
        });

        const resposta = {
            ...legislacao,
            estruturas,
            artigos: artigos.map((art) => ({
                ...art,
                paragrafos: paragrafosPorArtigo.get(art.id) || [],
                alineas: alineasPorArtigo.get(art.id) || []
            }))
        };
        
        res.json(resposta);
        
    } catch (err) {
        console.error('Erro ao buscar legislação:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

app.get('/api/legislacoes/:id/artigos/:numero', async (req, res) => {
    const { id, numero } = req.params;

    try {
        const { rows: artigosRows } = await pgQuery(
            `SELECT * FROM artigos WHERE legislacao_id = $1 AND numero = $2 LIMIT 1`,
            [id, numero]
        );
        const artigo = artigosRows[0];

        if (!artigo) {
            return res.status(404).json({ error: 'Artigo não encontrado' });
        }

        const { rows } = await pgQuery(
            `SELECT p.*, al.id as alinea_id, al.letra, al.conteudo as alinea_conteudo, al.ordem as alinea_ordem
             FROM paragrafos p
             LEFT JOIN alineas al ON al.paragrafo_id = p.id
             WHERE p.artigo_id = $1
             ORDER BY
               CASE WHEN p.ordem IS NULL THEN 1 ELSE 0 END, p.ordem,
               CASE WHEN al.ordem IS NULL THEN 1 ELSE 0 END, al.ordem`,
            [artigo.id]
        );

        const paragrafosMap = new Map();
        rows.forEach((r) => {
            if (!paragrafosMap.has(r.id)) {
                paragrafosMap.set(r.id, { id: r.id, numero: r.numero, conteudo: r.conteudo, ordem: r.ordem, alineas: [] });
            }
            if (r.alinea_id) {
                paragrafosMap.get(r.id).alineas.push({
                    id: r.alinea_id, letra: r.letra, conteudo: r.alinea_conteudo, ordem: r.alinea_ordem
                });
            }
        });

        res.json({ ...artigo, paragrafos: Array.from(paragrafosMap.values()) });
    } catch (error) {
        console.error('Erro ao buscar artigo:', error);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

// ============================================
// ROTAS DE HISTÓRICO
// ============================================

app.post('/api/historico/legislacoes', authenticateToken, async (req, res) => {
    const { legislacaoId, titulo } = req.body;
    const usuarioId = req.user.userId;
    const historicoId = uuidv4();

    try {
        await pgQuery(
            `INSERT INTO historico_legislacoes (id, usuario_id, legislacao_id, titulo, timestamp)
             VALUES ($1, $2, $3, $4, NOW())`,
            [historicoId, usuarioId, legislacaoId, titulo || null]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Erro ao salvar histórico:", err);
        res.status(500).json({ error: 'Erro ao salvar histórico' });
    }
});

app.post('/api/historico/jurisprudencias', authenticateToken, async (req, res) => {
    const { jurisprudenciaId, tribunal, ano, titulo } = req.body;
    const usuarioId = req.user.userId;
    const historicoId = uuidv4();

    if (!jurisprudenciaId || !tribunal || !ano) {
        return res.status(400).json({ error: 'jurisprudenciaId, tribunal e ano são obrigatórios' });
    }

    try {
        await pgQuery(
            `INSERT INTO historico_jurisprudencias
             (id, usuario_id, jurisprudencia_id, tribunal, ano, titulo, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [historicoId, usuarioId, jurisprudenciaId, tribunal, Number.parseInt(ano, 10), titulo || null]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Erro ao salvar histórico de jurisprudência:', err);
        res.status(500).json({ error: 'Erro ao salvar histórico de jurisprudência' });
    }
});

app.get('/api/historico/legislacoes/:usuarioId', authenticateToken, async (req, res) => {
    const { usuarioId } = req.params;
    
    if (req.user.userId !== usuarioId && !req.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }

    try {
        const { rows } = await pgQuery(
            `SELECT * FROM historico_legislacoes
             WHERE usuario_id = $1 ORDER BY timestamp DESC LIMIT 20`,
            [usuarioId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/historico/jurisprudencias/:usuarioId', authenticateToken, async (req, res) => {
    const { usuarioId } = req.params;

    if (req.user.userId !== usuarioId && !req.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }

    try {
        const { rows } = await pgQuery(
            `SELECT * FROM historico_jurisprudencias
             WHERE usuario_id = $1 ORDER BY timestamp DESC LIMIT 20`,
            [usuarioId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// ROTAS DE NOTIFICAÇÕES
// ============================================
app.get('/api/notificacoes', authenticateToken, (req, res) => {
    const usuarioId = req.user.userId;
    pgQuery(
        `SELECT id, titulo, mensagem, lida, created_at
         FROM notificacoes
         WHERE usuario_id = $1
         ORDER BY created_at DESC LIMIT 50`,
        [usuarioId]
    ).then(({ rows }) => {
        const payload = rows.map((row) => ({
            id: row.id,
            titulo: row.titulo,
            mensagem: row.mensagem || '',
            lida: row.lida === true,
            data: row.created_at
        }));
        res.json(payload);
    }).catch((error) => {
        console.error('Erro ao listar notificações:', error);
        res.status(500).json({ error: 'Erro ao listar notificações' });
    });
});

app.get('/api/notificacoes/stream-token', authenticateToken, (req, res) => {
    const token = criarTokenStreamNotificacoes(req.user.userId);
    const maxAgeSeconds = Math.max(1, Math.floor(NOTIFICATION_STREAM_TOKEN_TTL_MS / 1000));
    const cookieParts = [
        `${NOTIFICATION_STREAM_COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/api/notificacoes/stream',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAgeSeconds}`
    ];
    if (req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https')) {
        cookieParts.push('Secure');
    }

    res.setHeader('Set-Cookie', cookieParts.join('; '));
    res.json({
        token,
        expiresAt: Date.now() + NOTIFICATION_STREAM_TOKEN_TTL_MS
    });
});

app.get('/api/notificacoes/stream', (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = String(req.query.token || cookies[NOTIFICATION_STREAM_COOKIE_NAME] || '').trim();
    if (!token) {
        return res.status(401).json({ error: 'Token de stream em falta' });
    }

    const userId = validarTokenStreamNotificacoes(token);
    if (!userId) {
        return res.status(401).json({ error: 'Token de stream inválido ou expirado' });
    }

    res.status(200);
    res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    res.write('retry: 15000\n\n');
    res.write(serializarNotificacaoStream({ type: 'connected' }));

    const cleanup = registarStreamNotificacoes(userId, res);
    const ping = setInterval(() => {
        try {
            res.write(': ping\n\n');
        } catch (error) {
            clearInterval(ping);
            cleanup();
        }
    }, NOTIFICATION_STREAM_PING_MS);

    req.on('close', () => {
        clearInterval(ping);
        cleanup();
    });
});

app.post('/api/notificacoes/marcar-lida/:id', authenticateToken, (req, res) => {
    const usuarioId = req.user.userId;
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'ID da notificação é obrigatório' });

    pgQuery(
        `UPDATE notificacoes SET lida = TRUE WHERE id = $1 AND usuario_id = $2`,
        [id, usuarioId]
    ).then(() => {
        emitirAtualizacaoNotificacoes(usuarioId, { type: 'refresh', reason: 'mark-read' });
        res.json({ success: true });
    })
        .catch((error) => {
            console.error('Erro ao marcar notificação como lida:', error);
            res.status(500).json({ error: 'Erro ao marcar notificação' });
        });
});

app.post('/api/notificacoes/apagar-vistas', authenticateToken, (req, res) => {
    const usuarioId = req.user.userId;
    pgQuery(
        `DELETE FROM notificacoes WHERE usuario_id = $1 AND lida = TRUE`,
        [usuarioId]
    ).then(({ rowCount }) => {
        emitirAtualizacaoNotificacoes(usuarioId, { type: 'refresh', reason: 'delete-seen' });
        res.json({ success: true, removidas: rowCount || 0 });
    })
        .catch((error) => {
            console.error('Erro ao apagar notificações vistas:', error);
            res.status(500).json({ error: 'Erro ao apagar notificações vistas' });
        });
});

// ============================================
// ROTAS DE DISCIPLINAS SEGUIDAS
// ============================================
app.get('/api/disciplinas/seguindo', authenticateToken, (req, res) => {
    const usuarioId = req.user.userId;
    pgQuery(
        `SELECT disciplina FROM disciplinas_seguidas
         WHERE usuario_id = $1 ORDER BY created_at DESC`,
        [usuarioId]
    ).then(({ rows }) => {
        res.json({ disciplinas: rows.map((row) => row.disciplina) });
    }).catch((error) => {
        console.error('Erro ao listar disciplinas seguidas:', error);
        res.status(500).json({ error: 'Erro ao listar disciplinas seguidas' });
    });
});

app.post('/api/disciplinas/seguir', authenticateToken, (req, res) => {
    const usuarioId = req.user.userId;
    const disciplina = String(req.body?.disciplina || '').trim();
    if (!disciplina) {
        return res.status(400).json({ error: 'Disciplina é obrigatória' });
    }
    const key = normalizarDisciplina(disciplina);
    if (!key) {
        return res.status(400).json({ error: 'Disciplina inválida' });
    }

    const id = uuidv4();
    pgQuery(
        `INSERT INTO disciplinas_seguidas (id, usuario_id, disciplina, disciplina_normalized)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (usuario_id, disciplina_normalized) DO NOTHING`,
        [id, usuarioId, disciplina, key]
    ).then(() => res.json({ success: true, seguindo: true }))
        .catch((error) => {
            console.error('Erro ao seguir disciplina:', error);
            res.status(500).json({ error: 'Erro ao seguir disciplina' });
        });
});

app.delete('/api/disciplinas/seguir', authenticateToken, (req, res) => {
    const usuarioId = req.user.userId;
    const disciplina = String(req.body?.disciplina || '').trim();
    if (!disciplina) {
        return res.status(400).json({ error: 'Disciplina é obrigatória' });
    }
    const key = normalizarDisciplina(disciplina);
    if (!key) {
        return res.status(400).json({ error: 'Disciplina inválida' });
    }

    pgQuery(
        `DELETE FROM disciplinas_seguidas
         WHERE usuario_id = $1 AND disciplina_normalized = $2`,
        [usuarioId, key]
    ).then(() => res.json({ success: true, seguindo: false }))
        .catch((error) => {
            console.error('Erro ao deixar de seguir disciplina:', error);
            res.status(500).json({ error: 'Erro ao deixar de seguir disciplina' });
        });
});

// ============================================
// ROTAS DE REMISSÕES
// ============================================
app.post('/api/remissoes', authenticateToken, async (req, res) => {
    const usuarioId = req.user.userId;
    const {
        legislacaoOrigemId, artigoOrigem,
        legislacaoDestinoId, artigoDestino, comentario
    } = req.body;

    if (!legislacaoOrigemId || !artigoOrigem || !legislacaoDestinoId || !artigoDestino) {
        return res.status(400).json({
            error: 'legislacaoOrigemId, artigoOrigem, legislacaoDestinoId e artigoDestino são obrigatórios'
        });
    }

    const id = uuidv4();
    try {
        await pgQuery(
            `INSERT INTO remissoes
             (id, usuario_id, legislacao_origem_id, artigo_origem, legislacao_destino_id, artigo_destino, comentario, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [id, usuarioId, legislacaoOrigemId, String(artigoOrigem),
             legislacaoDestinoId, String(artigoDestino), comentario || '']
        );
        res.status(201).json({ success: true, id });
    } catch (err) {
        console.error('Erro ao criar remissão:', err);
        res.status(500).json({ error: 'Erro ao criar remissão' });
    }
});

app.get('/api/remissoes/me', authenticateToken, async (req, res) => {
    const usuarioId = req.user.userId;
    const { legislacaoId, artigoOrigem } = req.query;

    const params = [usuarioId];
    const where = ['r.usuario_id = $1'];

    if (legislacaoId) {
        params.push(legislacaoId);
        where.push(`r.legislacao_origem_id = $${params.length}`);
    }
    if (artigoOrigem) {
        params.push(String(artigoOrigem));
        where.push(`r.artigo_origem = $${params.length}`);
    }

    const limit = artigoOrigem ? 200 : 20;
    params.push(limit);
    try {
        const sql = `
            SELECT r.*, lo.nome AS lei_origem, ld.nome AS lei_destino
            FROM remissoes r
            LEFT JOIN legislacoes lo ON lo.id = r.legislacao_origem_id
            LEFT JOIN legislacoes ld ON ld.id = r.legislacao_destino_id
            WHERE ${where.join(' AND ')}
            ORDER BY r.timestamp DESC
            LIMIT $${params.length}
        `;
        const { rows } = await pgQuery(sql, params);
        res.json(rows);
    } catch (err) {
        console.error('Erro ao buscar remissões:', err);
        res.status(500).json({ error: 'Erro ao buscar remissões' });
    }
});

app.get('/api/remissoes/:usuarioId', authenticateToken, async (req, res) => {
    const { usuarioId } = req.params;
    const { legislacaoId, artigoOrigem } = req.query;

    if (req.user.userId !== usuarioId && !req.user.isAdmin) {
        return res.status(403).json({ error: 'Acesso negado' });
    }

    const params = [usuarioId];
    const where = ['r.usuario_id = $1'];

    if (legislacaoId) {
        params.push(legislacaoId);
        where.push(`r.legislacao_origem_id = $${params.length}`);
    }
    if (artigoOrigem) {
        params.push(String(artigoOrigem));
        where.push(`r.artigo_origem = $${params.length}`);
    }

    const limit = artigoOrigem ? 200 : 20;
    params.push(limit);
    try {
        const sql = `
            SELECT r.*, lo.nome AS lei_origem, ld.nome AS lei_destino
            FROM remissoes r
            LEFT JOIN legislacoes lo ON lo.id = r.legislacao_origem_id
            LEFT JOIN legislacoes ld ON ld.id = r.legislacao_destino_id
            WHERE ${where.join(' AND ')}
            ORDER BY r.timestamp DESC
            LIMIT $${params.length}
        `;
        const { rows } = await pgQuery(sql, params);
        res.json(rows);
    } catch (err) {
        console.error('Erro ao buscar remissões:', err);
        res.status(500).json({ error: 'Erro ao buscar remissões' });
    }
});

// ============================================
// ROTAS HOME (POSTGRESQL)
// ============================================
app.get('/api/home/dashboard-content', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pgQuery(
            `SELECT id, tribunal, ano, nome, referencias, updated_at, created_at
             FROM jurisprudencias
             ORDER BY updated_at DESC, created_at DESC
             LIMIT 6`
        );

        const jurisprudencias = rows.map((item) => {
            const titulo = String(item.nome || '').trim() || `${item.tribunal} - ${item.ano}`;
            const subtituloPartes = [item.tribunal, item.ano].filter(Boolean);
            if (item.referencias) {
                subtituloPartes.push(item.referencias);
            }

            return {
                id: item.id,
                titulo,
                subtitulo: subtituloPartes.join(' • '),
                link: `/app/reader?jurisprudencia=${encodeURIComponent(item.id)}`,
                updated_at: item.updated_at || item.created_at || null
            };
        });

        res.json({ jurisprudencias });
    } catch (error) {
        console.error('Erro ao carregar conteúdo do dashboard (PostgreSQL):', error);
        res.status(500).json({ error: 'Erro ao carregar dashboard da Home' });
    }
});

app.get('/api/home/fase-conteudo', authenticateToken, async (req, res) => {
    const disciplina = req.query.disciplina;
    const nome = req.query.nome || req.query.tema;
    const subtema = req.query.subtema || req.query.fase;

    if (!disciplina || !nome || !subtema) {
        return res.status(400).json({
            error: 'disciplina, nome e subtema são obrigatórios (tema/fase também são aceitos)',
        });
    }

    try {
        const { rows } = await pgQuery(
            `SELECT disciplina, tema, fase, conteudo_html, autores, updated_at
             FROM home_fase_conteudos
             WHERE disciplina = $1 AND tema = $2 AND fase = $3
             LIMIT 1`,
            [disciplina, nome, subtema]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Conteúdo da fase não encontrado' });
        }

        const item = rows[0];
        res.json({
            disciplina: item.disciplina,
            nome: item.tema,
            subtema: item.fase,
            tema: item.tema,
            fase: item.fase,
            conteudoHtml: item.conteudo_html,
            autores: normalizarAutores(item.autores),
            updatedAt: item.updated_at,
        });
    } catch (error) {
        console.error('Erro ao carregar conteúdo da fase (PostgreSQL):', error);
        res.status(500).json({ error: 'Erro ao carregar conteúdo da fase' });
    }
});

app.post('/api/home/fase-conteudo', authenticateToken, requireAdminCapability(ADMIN_CAPABILITIES.CONTENT), async (req, res) => {
    const disciplina = req.body.disciplina;
    const nome = req.body.nome || req.body.tema;
    const subtema = req.body.subtema || req.body.fase;
    const conteudoHtml = req.body.conteudoHtml;
    const autoresRaw = req.body.autores;
    const autores = normalizarAutores(autoresRaw);

    if (!disciplina || !nome || !subtema) {
        return res.status(400).json({
            error: 'disciplina, nome e subtema são obrigatórios (tema/fase também são aceitos)',
        });
    }

    if (conteudoHtml === undefined) {
        return res.status(400).json({
            error: 'Forneça conteudoHtml',
        });
    }

    try {
        const { rows: existentes } = await pgQuery(
            `SELECT * FROM home_fase_conteudos WHERE disciplina = $1 AND tema = $2 AND fase = $3`,
            [disciplina, nome, subtema]
        );

        let query, params;

        if (existentes.length === 0) {
            query = `INSERT INTO home_fase_conteudos
                (disciplina, tema, fase, conteudo_html, autores, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
             RETURNING disciplina, tema, fase, conteudo_html, autores, updated_at`;
            
            params = [
                disciplina, nome, subtema,
                conteudoHtml || '',
                autores.length ? JSON.stringify(autores) : null
            ];
        } else {
            const updates = [];
            const values = [];
            let paramIndex = 1;

            if (conteudoHtml !== undefined) {
                updates.push(`conteudo_html = $${paramIndex}`);
                values.push(conteudoHtml);
                paramIndex++;
            }

            if (autoresRaw !== undefined && autoresRaw !== null) {
                updates.push(`autores = $${paramIndex}::jsonb`);
                values.push(autores.length ? JSON.stringify(autores) : null);
                paramIndex++;
            }

            updates.push(`updated_at = NOW()`);
            values.push(disciplina, nome, subtema);

            query = `UPDATE home_fase_conteudos
             SET ${updates.join(', ')}
             WHERE disciplina = $${paramIndex} AND tema = $${paramIndex + 1} AND fase = $${paramIndex + 2}
             RETURNING disciplina, tema, fase, conteudo_html, autores, updated_at`;

            params = values;
        }

        const { rows } = await pgQuery(query, params);
        invalidateHiromiKnowledgeCache();
        await logAudit('content_home_fase_saved', req.user.userId, req.ip, {
            action: 'upload',
            disciplina,
            tema: nome,
            subtema,
            fase: subtema,
            autores
        });

        res.json({
            success: true,
            message: 'Conteúdo da fase salvo com sucesso',
            item: {
                ...rows[0],
                nome: rows[0].tema,
                subtema: rows[0].fase,
                conteudoHtml: rows[0].conteudo_html,
                autores: rows[0].autores
                    ? (typeof rows[0].autores === 'string' ? JSON.parse(rows[0].autores) : rows[0].autores)
                    : [],
            },
        });

        // Notificar seguidores (falha aqui não afecta a resposta já enviada)
        try {
            if (conteudoHtml !== undefined && conteudoHtml !== '') {
                const disciplinaKey = normalizarDisciplina(disciplina);
                const { rows: seguidoresRows } = await pgQuery(
                    `SELECT usuario_id FROM disciplinas_seguidas WHERE disciplina_normalized = $1`,
                    [disciplinaKey]
                );
                if (seguidoresRows.length) {
                    const tituloNotificacao = `Novo conteúdo em ${disciplina}`;
                    const msg = `${nome} • ${subtema}`;
                    await Promise.all(
                        seguidoresRows.map((row) => adicionarNotificacao(row.usuario_id, tituloNotificacao, msg))
                    );
                }
            }
        } catch (notifError) {
            console.error('Erro ao enviar notificações:', notifError.message);
        }
    } catch (error) {
        console.error('Erro ao salvar conteúdo da fase (PostgreSQL):', error.message, error.stack);
        res.status(500).json({ error: 'Erro ao salvar conteúdo da fase' });
    }
});

app.get('/api/home/conteudos-autores', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pgQuery(
            `SELECT disciplina, tema, fase, autores, updated_at
             FROM home_fase_conteudos
             WHERE autores IS NOT NULL
             ORDER BY updated_at DESC`
        );
        const payload = rows.map((row) => ({
            disciplina: row.disciplina,
            tema: row.tema,
            fase: row.fase,
            autores: normalizarAutores(row.autores),
            updatedAt: row.updated_at,
        }));
        res.json({ items: payload });
    } catch (error) {
        console.error('Erro ao listar conteúdos por autor:', error);
        res.status(500).json({ error: 'Erro ao listar conteúdos por autor' });
    }
});

// ============================================
// HIROMI (ASSISTENTE JURÍDICA)
// ============================================
app.post('/api/hiromi/ask', authenticateToken, requireActiveAdmin, rateLimitHiromi, async (req, res) => {
    const originalQuestion = sanitizeText(req.body?.question);

    if (!originalQuestion || originalQuestion.length < 3) {
        return res.status(400).json({ error: 'Pergunta muito curta. Tente com pelo menos 3 caracteres.' });
    }

    if (originalQuestion.length > 600) {
        return res.status(400).json({ error: 'Pergunta muito longa. Limite de 600 caracteres.' });
    }

    const contextQuestion = resolveHiromiQuestionContext(req.user?.userId, originalQuestion);
    const question = contextQuestion.effectiveQuestion;

    // Todas as variáveis de extracção são calculadas uma única vez.
    const tokens = extractSearchTokens(question);
    const keyPhrases = extractKeyPhrases(question);
    const lawFocusId = detectLawFocus(question);
    const articlesOnly = questionWantsArticlesOnly(question);
    const wantsLegalBasis = questionWantsLegalBasis(question);
    const searchQuery = rewriteSearchQuery(question);
    const likeQuery = buildSearchLikePattern(question);

    try {
        const tokenLeg = buildTokenWhere(tokens, ['nome', 'descricao', 'fundamentacao'], 3);
        const tokenJuris = buildTokenWhere(tokens, ['nome', 'referencias', 'conteudo_html'], 3);
        const tokenForm = buildTokenWhere(tokens, ['disciplina', 'tema', 'fase', 'conteudo_html'], 3);
        const tokenArt = buildTokenWhere(tokens, ['a.numero', 'a.epigrafe', 'a.conteudo'], 3);

        const tools = [
            {
                name: 'legislation-retrieval',
                category: 'legislation',
                cacheKey: { question, tokens, keyPhrases, lawFocusId },
                run: () => pgQuery(
                    `SELECT id, nome, descricao, fundamentacao, data_publicacao
                     FROM legislacoes
                     WHERE (
                         to_tsvector('portuguese', coalesce(nome,'') || ' ' || coalesce(descricao,'') || ' ' || coalesce(fundamentacao,''))
                         @@ websearch_to_tsquery('portuguese', $1)
                     )
                     OR nome ILIKE $2 OR descricao ILIKE $2 OR fundamentacao ILIKE $2
                     ${tokenLeg.clause ? `OR (${tokenLeg.clause})` : ''}
                     ORDER BY data_publicacao DESC NULLS LAST, created_at DESC
                     LIMIT 3`,
                    [searchQuery, likeQuery, ...tokenLeg.params]
                )
            },
            {
                name: 'jurisprudence-analysis',
                category: 'jurisprudence',
                cacheKey: { question, tokens, keyPhrases },
                run: () => pgQuery(
                    `SELECT id, tribunal, ano, nome, referencias, conteudo_html, updated_at
                     FROM jurisprudencias
                     WHERE (
                         to_tsvector('portuguese', coalesce(nome,'') || ' ' || coalesce(referencias,'') || ' ' || coalesce(conteudo_html,''))
                         @@ websearch_to_tsquery('portuguese', $1)
                     )
                     OR nome ILIKE $2 OR referencias ILIKE $2 OR conteudo_html ILIKE $2
                     ${tokenJuris.clause ? `OR (${tokenJuris.clause})` : ''}
                     ORDER BY updated_at DESC
                     LIMIT 3`,
                    [searchQuery, likeQuery, ...tokenJuris.params]
                )
            },
            {
                name: 'formation-summarization',
                category: 'formation',
                required: true,
                cacheKey: { question, tokens, keyPhrases },
                run: () => pgQuery(
                    `SELECT disciplina, tema, fase, conteudo_html, updated_at
                     FROM home_fase_conteudos
                     WHERE (
                         to_tsvector('portuguese', coalesce(disciplina,'') || ' ' || coalesce(tema,'') || ' ' || coalesce(fase,'') || ' ' || coalesce(conteudo_html,''))
                         @@ websearch_to_tsquery('portuguese', $1)
                     )
                     OR disciplina ILIKE $2 OR tema ILIKE $2 OR fase ILIKE $2 OR conteudo_html ILIKE $2
                     ${tokenForm.clause ? `OR (${tokenForm.clause})` : ''}
                     ORDER BY updated_at DESC
                     LIMIT 3`,
                    [searchQuery, likeQuery, ...tokenForm.params]
                )
            },
            {
                name: 'legal-article-search',
                category: 'legislation',
                required: wantsLegalBasis,
                cacheKey: { question, tokens, keyPhrases, lawFocusId },
                run: () => pgQuery(
                    `SELECT a.id, a.numero, a.epigrafe, a.conteudo,
                            l.id AS legislacao_id, l.nome AS legislacao_nome,
                            ts_rank(
                                to_tsvector('portuguese', coalesce(a.numero,'') || ' ' || coalesce(a.epigrafe,'') || ' ' || coalesce(a.conteudo,'')),
                                websearch_to_tsquery('portuguese', $1)
                            ) AS rank
                     FROM artigos a
                     JOIN legislacoes l ON l.id = a.legislacao_id
                     WHERE (
                         to_tsvector('portuguese', coalesce(a.numero,'') || ' ' || coalesce(a.epigrafe,'') || ' ' || coalesce(a.conteudo,''))
                         @@ websearch_to_tsquery('portuguese', $1)
                     )
                     OR a.numero ILIKE $2 OR a.epigrafe ILIKE $2 OR a.conteudo ILIKE $2
                     ${tokenArt.clause ? `OR (${tokenArt.clause})` : ''}
                     ORDER BY rank DESC NULLS LAST, l.nome ASC
                     LIMIT 6`,
                    [searchQuery, likeQuery, ...tokenArt.params]
                )
            },
            {
                name: 'doctrine-semantic-memory',
                category: 'doctrine',
                required: true,
                cacheKey: { tokens, keyPhrases },
                run: () => searchDoutrinaInternal(tokens, keyPhrases)
            },
            {
                name: 'knowledge-graph-concepts',
                category: 'knowledge',
                required: true,
                cacheKey: { version: 'concept-pool' },
                run: () => loadHiromiKnowledgeConceptPool()
            }
        ];

        const cognitiveRun = await hiromiCognitive.run({
            question,
            userId: req.user?.userId,
            context: {
                contextualized: contextQuestion.contextualized
            },
            tools,
            synthesize: async ({ toolResults }) => {
                const resultByName = (name, fallback) => {
                    const result = toolResults.find((item) => item.name === name);
                    return result && result.ok ? result.data : fallback;
                };

            // --- FASE 6: Tool Orchestration ---
            // 1. Planner
            const planStep = {
                step: 'planner',
                description: 'Plano de ferramentas definido para a questão.',
                toolPlan: tools.map(t => t.name)
            };

            // 2. Search tool
            const searchStep = {
                step: 'search',
                description: 'Busca executada em todas as fontes.',
                results: {
                    legislacoes: resultByName('legislation-retrieval', { rows: [] }),
                    jurisprudencias: resultByName('jurisprudence-analysis', { rows: [] }),
                    formacoes: resultByName('formation-summarization', { rows: [] }),
                    artigos: resultByName('legal-article-search', { rows: [] }),
                    doutrina: resultByName('doctrine-semantic-memory', []),
                    knowledge: resultByName('knowledge-graph-concepts', [])
                }
            };

            // 3. Reranker
            // (mantém lógica de score e deduplicação)
            const sources = [];
            const minScore = tokens.length <= 1 ? 1 : 2;
            const contentScore = (text) => scoreText(text, tokens, keyPhrases);
            const hasKeyPhrase = (text) => {
                if (!keyPhrases.length) return false;
                const hay = String(text || '').toLowerCase();
                return keyPhrases.some((p) => hay.includes(p));
            };
            const artigosResult = searchStep.results.artigos;
            const legislacoesResult = searchStep.results.legislacoes;
            const jurisprudenciasResult = searchStep.results.jurisprudencias;
            const formacoesResult = searchStep.results.formacoes;
            const doutrinaInterna = searchStep.results.doutrina;
            const knowledgePoolConcepts = searchStep.results.knowledge;

            const artigosFiltrados = artigosResult.rows
                .filter((row) => (!lawFocusId || row.legislacao_id === lawFocusId))
                .map((row) => ({
                    ...row,
                    _score: contentScore(`${row.epigrafe || ''} ${row.conteudo || ''}`),
                    _phrase: hasKeyPhrase(`${row.epigrafe || ''} ${row.conteudo || ''}`)
                }))
                .filter((row) => (keyPhrases.length ? row._phrase : row._score >= minScore))
                .slice(0, 6);

            const doutrinaMode = doutrinaInterna?.mode || 'none';
            const doutrinaUnits = Array.isArray(doutrinaInterna?.units) ? doutrinaInterna.units : [];
            const doutrinaRows = Array.isArray(doutrinaInterna?.rows)
                ? doutrinaInterna.rows
                : (Array.isArray(doutrinaInterna) ? doutrinaInterna : []);
            const doutrinaSynthesis = asObject(doutrinaInterna?.synthesis);
            const doutrinaInternaConcepts = doutrinaMode === 'cognitive-units'
                ? [
                    ...(doutrinaSynthesis.concepts || []),
                    ...doutrinaUnits.flatMap((row) => parseJsonArray(row.keywords_json))
                ]
                : doutrinaRows.flatMap((row) => extractConceptSignals(row.content || ''));
            const doutrinaInternaTexto = compressContextText(
                doutrinaMode === 'cognitive-units'
                    ? doutrinaUnits.map((row) => row.raw_text || row.embedding_text || row.explicacao || '').filter(Boolean).join(' ')
                    : doutrinaRows.map((row) => row.content || '').filter(Boolean).join(' '),
                900
            );
            const doutrinaInternaExplanation = doutrinaMode === 'cognitive-units'
                ? sanitizeText(doutrinaSynthesis.explanation)
                : (doutrinaInternaTexto
                    ? buildDidacticExplanationFromText(doutrinaInternaTexto, question, [...keyPhrases, ...tokens])
                    : '');
            const doutrinaInternaSnippet = doutrinaMode === 'cognitive-units'
                ? sanitizeText(doutrinaSynthesis.snippet)
                : (doutrinaInternaTexto
                    ? extractRelevantSnippet(doutrinaInternaTexto, [...keyPhrases, ...tokens], 320)
                    : '');
            const globalConceptFallback = Array.isArray(knowledgePoolConcepts) ? knowledgePoolConcepts : [];
            const legislacoesComArtigos = new Set(artigosFiltrados.map((r) => r.legislacao_id));

            if (!articlesOnly && wantsLegalBasis) {
                legislacoesResult.rows
                    .filter((row) => legislacoesComArtigos.size === 0 || legislacoesComArtigos.has(row.id))
                    .filter((row) => !lawFocusId || row.id === lawFocusId)
                    .filter((row) => contentScore(`${row.nome} ${row.descricao || ''} ${row.fundamentacao || ''}`) >= minScore || legislacoesComArtigos.has(row.id))
                    .slice(0, 3)
                    .forEach((row) => {
                        const texto = `${row.nome} ${row.descricao || ''} ${row.fundamentacao || ''}`;
                        sources.push({
                            tipo: 'legislacao',
                            label: `Lei: ${row.nome}`,
                            display: `[legislacao] ${row.nome}`,
                            link: `leitor.html?legislacao=${encodeURIComponent(row.id)}`,
                            _score: contentScore(texto)
                        });
                    });
            }

            if (!articlesOnly && wantsLegalBasis) {
                jurisprudenciasResult.rows
                    .filter((row) => contentScore(`${row.nome} ${row.referencias || ''} ${row.conteudo_html || ''}`) >= minScore)
                    .slice(0, 3)
                    .forEach((row) => {
                        const label = `${row.tribunal} ${row.ano} — ${row.nome}`;
                        const texto = `${row.nome} ${row.referencias || ''} ${row.conteudo_html || ''}`;
                        sources.push({
                            tipo: 'jurisprudencia',
                            label,
                            display: `[jurisprudencia] ${label}`,
                            link: '/app/jurisprudencia',
                            _score: contentScore(texto)
                        });
                    });
            }

            if (!articlesOnly) {
                formacoesResult.rows
                    .filter((row) => contentScore(`${row.disciplina} ${row.tema} ${row.fase} ${row.conteudo_html || ''}`) >= minScore)
                    .slice(0, 1)
                    .forEach((row) => {
                        const label = `${row.disciplina} - ${row.tema} - ${row.fase}`;
                        const conteudoFonte = compressContextText(row.conteudo_html, 560);
                        const terms = [...keyPhrases, ...tokens];
                        sources.push({
                            tipo: 'formacao',
                            label,
                            display: `[formacao] ${label}`,
                            _score: contentScore(conteudoFonte),
                            points: extractFormacaoPoints(conteudoFonte),
                            concepts: extractConceptSignals(conteudoFonte),
                            snippet: extractRelevantSnippet(conteudoFonte, terms, 260),
                            explanation: buildDidacticExplanationFromText(conteudoFonte, question, terms)
                        });
                    });
            }

            if (wantsLegalBasis) {
                artigosFiltrados.forEach((row) => {
                    const numero = row.numero ? `Art. ${row.numero}` : 'Artigo';
                    const epigrafeFinal = row.epigrafe || deriveEpigrafeFromConteudo(row.conteudo);
                    const label = epigrafeFinal
                        ? `${row.legislacao_nome} — ${numero} (${epigrafeFinal})`
                        : `${row.legislacao_nome} — ${numero}`;
                    const texto = `${row.epigrafe || ''} ${row.conteudo || ''}`;
                    sources.push({
                        tipo: 'artigo',
                        label,
                        display: `[legislacao] ${label}`,
                        link: `leitor.html?legislacao=${encodeURIComponent(row.legislacao_id)}`,
                        _score: contentScore(texto)
                    });
                });
            }

            // Deduplicação e reranking
            const seen = new Set();
            const dedupedSources = sources.filter((item) => {
                const key = item.display || item.label || JSON.stringify(item);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            const selectedSources = dedupedSources
                .map((item) => ({
                    ...item,
                    _priorityScore: (item._score || 0) + ((wantsLegalBasis && ['artigo', 'legislacao', 'jurisprudencia'].includes(item.tipo)) ? 3 : 0)
                }))
                .sort((a, b) => (b._priorityScore || 0) - (a._priorityScore || 0))
                .slice(0, 3);
            const rerankStep = {
                step: 'reranker',
                description: 'Fontes reordenadas por relevância e deduplicadas.',
                selectedSources
            };

            // 4. Summarizer
            const answer = buildHiromiAnswer(question, [
                ...selectedSources,
                ...(doutrinaInternaConcepts.length || doutrinaInternaExplanation || doutrinaInternaSnippet
                    ? [{
                        tipo: 'internal',
                        concepts: doutrinaInternaConcepts,
                        explanation: doutrinaInternaExplanation,
                        snippet: doutrinaInternaSnippet
                    }]
                    : []),
                ...(!doutrinaInternaConcepts.length && globalConceptFallback.length
                    ? [{ tipo: 'knowledge', concepts: globalConceptFallback }]
                    : [])
            ]);
            const summarizerStep = {
                step: 'summarizer',
                description: 'Resposta sintetizada a partir das fontes selecionadas.',
                answerPreview: answer.slice(0, 320)
            };

            // 5. Reasoning engine (placeholder)
            const reasoningStep = {
                step: 'reasoning',
                description: 'Raciocínio e comparação entre fontes executados.',
                notes: []
            };

            // 6. Validator (placeholder)
            const validatorStep = {
                step: 'validator',
                description: 'Validação de consistência e confiança.',
                confidence: 0.95,
                contradictions: []
            };

            // 7. Response generator
            return {
                answer,
                sources: selectedSources,
                totalHits: selectedSources.length,
                steps: [planStep, searchStep, rerankStep, summarizerStep, reasoningStep, validatorStep],
                contradictions: [],
                confidence: 0.95,
                workingMemory: hiromiSessionContext.get(String(req.user?.userId || 'anonymous'))?.workingMemory || {},
                semanticMemory: hiromiSessionContext.get(String(req.user?.userId || 'anonymous'))?.semanticMemory || {}
            };
            }
        });

        rememberHiromiQuestion(req.user?.userId, originalQuestion, question);
        res.json(cognitiveRun.response);
    } catch (error) {
        // Este catch é o último recurso — garante que qualquer erro inesperado
        // retorna 500 em vez de derrubar o servidor.
        console.error('[hiromi] Erro inesperado ao gerar resposta:', error?.message || error);
        if (error?.stack) console.error(error.stack);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Erro ao consultar conteúdo para a Hiromi. Tente novamente.' });
        }
    }
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, HOST, () => {
    console.log(`Servidor rodando em http://${HOST}:${PORT}`);
    try {
        const nets = os.networkInterfaces();
        const addresses = [];
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                // Skip over non-IPv4 and internal (i.e. 127.0.0.1)
                if (net.family === 'IPv4' && !net.internal) {
                    addresses.push(net.address);
                }
            }
        }
        if (addresses.length) {
            addresses.forEach(addr => console.log(`Acesse SENTINELA na rede local: http://${addr}:${PORT}`));
        } else {
            console.log('Nenhum endereço de rede local detectado (interface pode estar desativada)');
        }
    } catch (err) {
        console.log('Erro ao detectar endereços de rede:', err?.message || err);
    }
});
