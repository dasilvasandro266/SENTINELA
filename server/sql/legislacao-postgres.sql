-- Opcional: execute no pgAdmin 4, database juridico_db.
-- O backend também cria estas tabelas automaticamente no npm start.

CREATE TABLE IF NOT EXISTS legislacoes (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    descricao TEXT,
    fundamentacao TEXT,
    data_publicacao DATE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS estruturas (
    id TEXT PRIMARY KEY,
    legislacao_id TEXT NOT NULL REFERENCES legislacoes(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    numero TEXT,
    titulo TEXT,
    parent_id TEXT REFERENCES estruturas(id) ON DELETE CASCADE,
    ordem INTEGER,
    nivel INTEGER
);

CREATE TABLE IF NOT EXISTS artigos (
    id TEXT PRIMARY KEY,
    legislacao_id TEXT NOT NULL REFERENCES legislacoes(id) ON DELETE CASCADE,
    estrutura_id TEXT REFERENCES estruturas(id) ON DELETE SET NULL,
    numero TEXT NOT NULL,
    epigrafe TEXT,
    conteudo TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paragrafos (
    id TEXT PRIMARY KEY,
    artigo_id TEXT NOT NULL REFERENCES artigos(id) ON DELETE CASCADE,
    numero TEXT,
    conteudo TEXT NOT NULL,
    ordem INTEGER
);

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
);

CREATE TABLE IF NOT EXISTS historico_legislacoes (
    id TEXT PRIMARY KEY,
    usuario_id TEXT NOT NULL,
    legislacao_id TEXT NOT NULL,
    titulo TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remissoes (
    id TEXT PRIMARY KEY,
    usuario_id TEXT NOT NULL,
    legislacao_origem_id TEXT NOT NULL,
    artigo_origem TEXT NOT NULL,
    legislacao_destino_id TEXT NOT NULL,
    artigo_destino TEXT NOT NULL,
    comentario TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT NOW()
);
