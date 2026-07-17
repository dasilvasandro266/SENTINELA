-- Execute este script no pgAdmin 4 (Query Tool), no banco "sentinela".

CREATE TABLE IF NOT EXISTS home_dashboard_items (
    id SERIAL PRIMARY KEY,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('jurisprudencia')),
    titulo TEXT NOT NULL,
    link TEXT NOT NULL,
    subtitulo TEXT,
    ordem INTEGER NOT NULL DEFAULT 0,
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS home_fase_conteudos (
    id SERIAL PRIMARY KEY,
    disciplina TEXT NOT NULL,
    tema TEXT NOT NULL,
    fase TEXT NOT NULL,
    conteudo_html TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_home_fase UNIQUE (disciplina, tema, fase)
);

CREATE INDEX IF NOT EXISTS idx_home_dashboard_tipo_ordem
ON home_dashboard_items (tipo, ordem);

CREATE INDEX IF NOT EXISTS idx_home_fase_lookup
ON home_fase_conteudos (disciplina, tema, fase);

INSERT INTO home_dashboard_items (tipo, titulo, link, subtitulo, ordem, ativo)
VALUES
    ('jurisprudencia', 'STF - Recurso Extraordinário 123456', '/app/jurisprudencia', NULL, 1, TRUE),
    ('jurisprudencia', 'STJ - Súmula 345', '/app/jurisprudencia', NULL, 2, TRUE),
    ('jurisprudencia', 'TST - Recurso de Revista 78901', '/app/jurisprudencia', NULL, 3, TRUE)
ON CONFLICT DO NOTHING;

-- Exemplo: conteúdo de uma fase (ajuste disciplina/tema/fase conforme dadosDisciplinas.json)
INSERT INTO home_fase_conteudos (disciplina, tema, fase, conteudo_html)
VALUES (
    'Introdução ao Estudo do Direito',
    'Noções Gerais',
    'Conceito de Direito',
    '<div class="sentinela-bold">Conceito de Direito</div><p>Direito é um conjunto de normas...</p>'
)
ON CONFLICT (disciplina, tema, fase) DO UPDATE
SET conteudo_html = EXCLUDED.conteudo_html,
    updated_at = NOW();
