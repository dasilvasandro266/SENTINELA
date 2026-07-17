require('dotenv').config();
const { Pool } = require("pg");

function buildPoolConfig() {
    const connectionString = (process.env.DATABASE_URL || '').trim();
    if (connectionString) {
        return { connectionString };
    }

    const requiredKeys = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
    const missingKeys = requiredKeys.filter((key) => !String(process.env[key] || '').trim());
    if (missingKeys.length > 0) {
        throw new Error(`Configuração PostgreSQL incompleta. Defina ${missingKeys.join(', ')} ou DATABASE_URL em .env.`);
    }

    const poolConfig = {
        host: process.env.PGHOST.trim(),
        port: Number(process.env.PGPORT),
        database: process.env.PGDATABASE.trim(),
        user: process.env.PGUSER.trim(),
        password: process.env.PGPASSWORD
    };

    const sslMode = String(process.env.PGSSLMODE || '').trim().toLowerCase();
    if (sslMode && sslMode !== 'disable') {
        poolConfig.ssl = {
            rejectUnauthorized: sslMode === 'verify-full'
        };
    }

    return poolConfig;
}

const pool = new Pool(buildPoolConfig());

async function query(text, params = []) {
    return pool.query(text, params);
}

async function initHomeContentSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS home_dashboard_items (
            id SERIAL PRIMARY KEY,
            tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('jurisprudencia')),
            titulo TEXT NOT NULL,
            link TEXT NOT NULL,
            subtitulo TEXT,
            ordem INTEGER NOT NULL DEFAULT 0,
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS home_fase_conteudos (
            id SERIAL PRIMARY KEY,
            disciplina TEXT NOT NULL,
            tema TEXT NOT NULL,
            fase TEXT NOT NULL,
            conteudo_html TEXT NOT NULL,
            autores JSONB,
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_home_fase UNIQUE (disciplina, tema, fase)
        )
    `);

    await query(`
        ALTER TABLE home_fase_conteudos
        ADD COLUMN IF NOT EXISTS autores JSONB
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS disciplinas_seguidas (
            id TEXT PRIMARY KEY,
            usuario_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            disciplina TEXT NOT NULL,
            disciplina_normalized TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_disciplina_usuario UNIQUE (usuario_id, disciplina_normalized)
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS notificacoes (
            id TEXT PRIMARY KEY,
            usuario_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            titulo TEXT NOT NULL,
            mensagem TEXT,
            lida BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_home_dashboard_tipo_ordem
        ON home_dashboard_items (tipo, ordem)
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_home_fase_lookup
        ON home_fase_conteudos (disciplina, tema, fase)
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_home_fase_fts
        ON home_fase_conteudos
        USING GIN (to_tsvector('portuguese', coalesce(disciplina, '') || ' ' || coalesce(tema, '') || ' ' || coalesce(fase, '') || ' ' || coalesce(conteudo_html, '')))
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_disciplinas_usuario
        ON disciplinas_seguidas (usuario_id, disciplina_normalized)
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_notificacoes_usuario
        ON notificacoes (usuario_id, created_at DESC)
    `);

}

async function initAuthSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            username TEXT UNIQUE NOT NULL,
            username_normalized TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            nome_completo TEXT,
            instituicao TEXT,
            nivel_academico TEXT,
            is_admin BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS admin_access_keys (
            id TEXT PRIMARY KEY,
            key_hash TEXT UNIQUE NOT NULL,
            descricao TEXT,
            created_by TEXT,
            target_role TEXT NOT NULL DEFAULT 'general',
            target_capabilities JSONB,
            used_by TEXT,
            used_at TIMESTAMP,
            expires_at TIMESTAMP,
            revoked BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY,
            event_type TEXT NOT NULL,
            user_id TEXT,
            ip TEXT,
            meta JSONB,
            created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_role TEXT`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_capabilities JSONB`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_promoted_by TEXT REFERENCES users(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_expires_at TIMESTAMP`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_revoked_at TIMESTAMP`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE admin_access_keys ADD COLUMN IF NOT EXISTS target_role TEXT NOT NULL DEFAULT 'general'`);
    await query(`ALTER TABLE admin_access_keys ADD COLUMN IF NOT EXISTS target_capabilities JSONB`);

    await query(`
        UPDATE users
        SET admin_role = COALESCE(admin_role, 'general'),
            admin_capabilities = COALESCE(admin_capabilities, '["content.manage","admins.manage"]'::jsonb)
        WHERE is_admin = TRUE
          AND admin_role IS NULL
          AND admin_revoked_at IS NULL
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_users_username_normalized ON users(username_normalized)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_users_admin_role ON users(admin_role)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_users_admin_promoted_by ON users(admin_promoted_by)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_admin_keys_used ON admin_access_keys(used_by, used_at)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event_type, created_at DESC)`);
}

async function initLegislacaoSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS legislacoes (
            id TEXT PRIMARY KEY,
            nome TEXT NOT NULL,
            descricao TEXT,
            fundamentacao TEXT,
            data_publicacao DATE,
            created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS estruturas (
            id TEXT PRIMARY KEY,
            legislacao_id TEXT NOT NULL REFERENCES legislacoes(id) ON DELETE CASCADE,
            tipo TEXT NOT NULL,
            numero TEXT,
            titulo TEXT,
            parent_id TEXT REFERENCES estruturas(id) ON DELETE CASCADE,
            ordem INTEGER,
            nivel INTEGER
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS artigos (
            id TEXT PRIMARY KEY,
            legislacao_id TEXT NOT NULL REFERENCES legislacoes(id) ON DELETE CASCADE,
            estrutura_id TEXT REFERENCES estruturas(id) ON DELETE SET NULL,
            numero TEXT NOT NULL,
            epigrafe TEXT,
            conteudo TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS paragrafos (
            id TEXT PRIMARY KEY,
            artigo_id TEXT NOT NULL REFERENCES artigos(id) ON DELETE CASCADE,
            numero TEXT,
            conteudo TEXT NOT NULL,
            ordem INTEGER
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS alineas (
            id TEXT PRIMARY KEY,
            artigo_id TEXT REFERENCES artigos(id) ON DELETE CASCADE,
            paragrafo_id TEXT REFERENCES paragrafos(id) ON DELETE CASCADE,
            letra TEXT NOT NULL,
            conteudo TEXT NOT NULL,
            ordem INTEGER,
            CHECK (
                (artigo_id IS NOT NULL AND paragrafo_id IS NULL)
                OR
                (artigo_id IS NULL AND paragrafo_id IS NOT NULL)
            )
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS historico_legislacoes (
            id TEXT PRIMARY KEY,
            usuario_id TEXT NOT NULL,
            legislacao_id TEXT NOT NULL,
            titulo TEXT,
            timestamp TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS remissoes (
            id TEXT PRIMARY KEY,
            usuario_id TEXT NOT NULL,
            legislacao_origem_id TEXT NOT NULL,
            artigo_origem TEXT NOT NULL,
            legislacao_destino_id TEXT NOT NULL,
            artigo_destino TEXT NOT NULL,
            comentario TEXT,
            timestamp TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_estruturas_legislacao ON estruturas(legislacao_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_estruturas_parent ON estruturas(parent_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_artigos_legislacao ON artigos(legislacao_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_artigos_estrutura ON artigos(estrutura_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_artigos_numero ON artigos(numero)`);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_artigos_fts
        ON artigos
        USING GIN (to_tsvector('portuguese', coalesce(numero, '') || ' ' || coalesce(epigrafe, '') || ' ' || coalesce(conteudo, '')))
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_paragrafos_artigo ON paragrafos(artigo_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_alineas_paragrafo ON alineas(paragrafo_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_alineas_artigo ON alineas(artigo_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_historico_usuario ON historico_legislacoes(usuario_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_historico_timestamp ON historico_legislacoes(timestamp DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_remissoes_usuario ON remissoes(usuario_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_remissoes_origem ON remissoes(legislacao_origem_id, artigo_origem)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_remissoes_timestamp ON remissoes(timestamp DESC)`);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_legislacoes_fts
        ON legislacoes
        USING GIN (to_tsvector('portuguese', coalesce(nome, '') || ' ' || coalesce(descricao, '') || ' ' || coalesce(fundamentacao, '')))
    `);
}

async function initJurisprudenciaSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS jurisprudencias (
            id TEXT PRIMARY KEY,
            tribunal TEXT NOT NULL,
            ano INTEGER NOT NULL,
            nome TEXT NOT NULL,
            referencias TEXT,
            conteudo_html TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS historico_jurisprudencias (
            id TEXT PRIMARY KEY,
            usuario_id TEXT NOT NULL,
            jurisprudencia_id TEXT NOT NULL,
            tribunal TEXT NOT NULL,
            ano INTEGER NOT NULL,
            titulo TEXT,
            timestamp TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_jurisprudencias_tribunal_ano ON jurisprudencias(tribunal, ano)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_jurisprudencias_updated_at ON jurisprudencias(updated_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_hist_juris_usuario ON historico_jurisprudencias(usuario_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_hist_juris_timestamp ON historico_jurisprudencias(timestamp DESC)`);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_jurisprudencias_fts
        ON jurisprudencias
        USING GIN (to_tsvector('portuguese', coalesce(nome, '') || ' ' || coalesce(referencias, '') || ' ' || coalesce(conteudo_html, '')))
    `);
}

module.exports = {
    pool,
    query,
    initAuthSchema,
    initHomeContentSchema,
    initLegislacaoSchema,
    initJurisprudenciaSchema,
};
