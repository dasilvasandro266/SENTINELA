const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'sentinela.db'));

async function importarLegislacao(arquivoJson) {
    console.log(`📥 Importando ${arquivoJson}...`);
    
    const dados = JSON.parse(fs.readFileSync(arquivoJson, 'utf8'));
    
    // Inserir legislação
    const legislacaoId = dados.id || uuidv4();
    
    await new Promise((resolve, reject) => {
        db.run(
            `INSERT OR REPLACE INTO legislacoes (id, nome, descricao) VALUES (?, ?, ?)`,
            [legislacaoId, dados.nome, dados.descricao || ''],
            (err) => err ? reject(err) : resolve()
        );
    });
    
    // Processar estrutura hierárquica
    let ordemGlobal = 0;
    for (const item of dados.estrutura) {
        await processarEstrutura(item, legislacaoId, null, 0, ordemGlobal++);
    }
    
    console.log(`✅ Legislação '${dados.nome}' importada com sucesso!`);
}

async function processarEstrutura(item, legislacaoId, parentId, nivel, ordem) {
    const estruturaId = uuidv4();
    
    // Inserir estrutura
    await new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO estruturas (id, legislacao_id, tipo, numero, titulo, parent_id, nivel, ordem) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [estruturaId, legislacaoId, item.tipo, item.numero, item.titulo, parentId, nivel, ordem],
            (err) => err ? reject(err) : resolve()
        );
    });
    
    // Processar artigos desta estrutura
    if (item.artigos) {
        for (const artigo of item.artigos) {
            await processarArtigo(artigo, legislacaoId, estruturaId);
        }
    }
    
    // Processar sub-estruturas
    if (item.subestruturas) {
        for (let i = 0; i < item.subestruturas.length; i++) {
            await processarEstrutura(item.subestruturas[i], legislacaoId, estruturaId, nivel + 1, i);
        }
    }
}

async function processarArtigo(artigo, legislacaoId, estruturaId) {
    const artigoId = uuidv4();
    
    await new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO artigos (id, legislacao_id, estrutura_id, numero, epigrafe, conteudo) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [artigoId, legislacaoId, estruturaId, artigo.numero, artigo.epigrafe || '', artigo.conteudo || ''],
            (err) => err ? reject(err) : resolve()
        );
    });
    
    // Processar parágrafos
    if (artigo.paragrafos) {
        for (let i = 0; i < artigo.paragrafos.length; i++) {
            await processarParagrafo(artigo.paragrafos[i], artigoId, i);
        }
    }
}

async function processarParagrafo(paragrafo, artigoId, ordem) {
    const paragrafoId = uuidv4();
    
    await new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO paragrafos (id, artigo_id, numero, conteudo, ordem) 
             VALUES (?, ?, ?, ?, ?)`,
            [paragrafoId, artigoId, paragrafo.numero || 'único', paragrafo.conteudo, ordem],
            (err) => err ? reject(err) : resolve()
        );
    });
    
    // Processar alíneas
    if (paragrafo.alineas) {
        for (let i = 0; i < paragrafo.alineas.length; i++) {
            await processarAlinea(paragrafo.alineas[i], artigoId, paragrafoId, i);
        }
    }
}

async function processarAlinea(alinea, artigoId, paragrafoId, ordem) {
    const alineaId = uuidv4();
    
    await new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO alineas (id, artigo_id, paragrafo_id, letra, conteudo, ordem) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [alineaId, artigoId, paragrafoId, alinea.letra, alinea.conteudo, ordem],
            (err) => err ? reject(err) : resolve()
        );
    });
}

// Executar importação
async function main() {
    const arquivos = process.argv.slice(2);
    
    if (arquivos.length === 0) {
        console.log('Uso: node importar-legislacao.js arquivo1.json arquivo2.json');
        return;
    }
    
    for (const arquivo of arquivos) {
        try {
            await importarLegislacao(arquivo);
        } catch (err) {
            console.error(`❌ Erro ao importar ${arquivo}:`, err);
        }
    }
    
    db.close();
}

main();