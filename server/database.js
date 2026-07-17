const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'sentinela.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Erro ao conectar ao SQLite:', err);
    } else {
        console.log('Conectado ao SQLite com sucesso!');
        db.run('PRAGMA foreign_keys = ON');
        initDatabase();
    }
});

function initDatabase() {
    db.serialize(() => {
        // Tabela de usuários (já existente)
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                username TEXT UNIQUE NOT NULL,
                username_normalized TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                nome_completo TEXT,
                isAdmin INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Índices para busca rápida
        db.run(`CREATE INDEX IF NOT EXISTS idx_email ON users(email)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_username_normalized ON users(username_normalized)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_isAdmin ON users(isAdmin)`);

        // Índices para usuários
        db.run(`CREATE INDEX IF NOT EXISTS idx_email ON users(email)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_username_normalized ON users(username_normalized)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_isAdmin ON users(isAdmin)`);

        // ============================================
        // NOVAS TABELAS PARA LEGISLAÇÃO
        // ============================================

        // Tabela de legislações
        db.run(`
            CREATE TABLE IF NOT EXISTS legislacoes (
                id TEXT PRIMARY KEY,
                nome TEXT NOT NULL,
                descricao TEXT,
                fundamentacao TEXT,
                data_publicacao DATE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de estruturas (Livros, Títulos, Capítulos, etc)
        db.run(`
            CREATE TABLE IF NOT EXISTS estruturas (
                id TEXT PRIMARY KEY,
                legislacao_id TEXT NOT NULL,
                tipo TEXT NOT NULL,
                numero TEXT,
                titulo TEXT,
                parent_id TEXT,
                ordem INTEGER,
                nivel INTEGER,
                FOREIGN KEY (legislacao_id) REFERENCES legislacoes(id) ON DELETE CASCADE,
                FOREIGN KEY (parent_id) REFERENCES estruturas(id) ON DELETE CASCADE
            )
        `);

        // Índices para estruturas
        db.run(`CREATE INDEX IF NOT EXISTS idx_estruturas_legislacao ON estruturas(legislacao_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_estruturas_parent ON estruturas(parent_id)`);

        // Tabela de artigos
        db.run(`
            CREATE TABLE IF NOT EXISTS artigos (
                id TEXT PRIMARY KEY,
                legislacao_id TEXT NOT NULL,
                estrutura_id TEXT,
                numero TEXT NOT NULL,
                epigrafe TEXT,
                conteudo TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (legislacao_id) REFERENCES legislacoes(id) ON DELETE CASCADE,
                FOREIGN KEY (estrutura_id) REFERENCES estruturas(id) ON DELETE SET NULL
            )
        `);

        // Índices para artigos
        db.run(`CREATE INDEX IF NOT EXISTS idx_artigos_legislacao ON artigos(legislacao_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_artigos_estrutura ON artigos(estrutura_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_artigos_numero ON artigos(numero)`);

        // Tabela de parágrafos
        db.run(`
            CREATE TABLE IF NOT EXISTS paragrafos (
                id TEXT PRIMARY KEY,
                artigo_id TEXT NOT NULL,
                numero TEXT,
                conteudo TEXT NOT NULL,
                ordem INTEGER,
                FOREIGN KEY (artigo_id) REFERENCES artigos(id) ON DELETE CASCADE
            )
        `);

        // Tabela de alíneas
        db.run(`
            CREATE TABLE IF NOT EXISTS alineas (
                id TEXT PRIMARY KEY,
                artigo_id TEXT,
                paragrafo_id TEXT,
                letra TEXT NOT NULL,
                conteudo TEXT NOT NULL,
                ordem INTEGER,
                FOREIGN KEY (artigo_id) REFERENCES artigos(id) ON DELETE CASCADE,
                FOREIGN KEY (paragrafo_id) REFERENCES paragrafos(id) ON DELETE CASCADE,
                CHECK ((artigo_id IS NOT NULL AND paragrafo_id IS NULL) OR 
                       (artigo_id IS NULL AND paragrafo_id IS NOT NULL))
            )
        `);

        // Tabela de histórico de legislações visitadas
        db.run(`
            CREATE TABLE IF NOT EXISTS historico_legislacoes (
                id TEXT PRIMARY KEY,
                usuario_id TEXT NOT NULL,
                legislacao_id TEXT NOT NULL,
                titulo TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (usuario_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (legislacao_id) REFERENCES legislacoes(id) ON DELETE CASCADE
            )
        `);

        // Tabela de remissões entre artigos
        db.run(`
            CREATE TABLE IF NOT EXISTS remissoes (
                id TEXT PRIMARY KEY,
                usuario_id TEXT NOT NULL,
                legislacao_origem_id TEXT NOT NULL,
                artigo_origem TEXT NOT NULL,
                legislacao_destino_id TEXT NOT NULL,
                artigo_destino TEXT NOT NULL,
                comentario TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (usuario_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (legislacao_origem_id) REFERENCES legislacoes(id) ON DELETE CASCADE,
                FOREIGN KEY (legislacao_destino_id) REFERENCES legislacoes(id) ON DELETE CASCADE
            )
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_remissoes_usuario ON remissoes(usuario_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_remissoes_leg_origem ON remissoes(legislacao_origem_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_remissoes_artigo_origem ON remissoes(artigo_origem)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_remissoes_timestamp ON remissoes(timestamp DESC)`);

        console.log("✅ Todas as tabelas verificadas/criadas com sucesso");
    });
}
module.exports = db;
