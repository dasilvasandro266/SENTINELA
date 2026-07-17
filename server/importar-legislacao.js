require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./postgres');
const { importarLegislacaoJson } = require('./legislacao-import-service');

async function importarArquivoJson(arquivoJson) {
    const arquivoAbsoluto = path.resolve(process.cwd(), arquivoJson);
    if (!fs.existsSync(arquivoAbsoluto)) {
        throw new Error(`Arquivo não encontrado: ${arquivoAbsoluto}`);
    }

    const dados = JSON.parse(fs.readFileSync(arquivoAbsoluto, 'utf8'));
    return importarLegislacaoJson(dados);
}

async function main() {
    const arquivos = process.argv.slice(2);
    if (arquivos.length === 0) {
        console.log('Uso: node server/importar-legislacao.js dados/codigo-civil.json');
        return;
    }

    for (const arquivo of arquivos) {
        try {
            const result = await importarArquivoJson(arquivo);
            console.log(`✅ Legislação importada no PostgreSQL: ${result.nome} (${result.id})`);
        } catch (error) {
            console.error(`❌ Erro ao importar ${arquivo}:`, error.message);
        }
    }

    await pool.end();
}

main().catch((err) => {
    console.error('❌ Falha na importação:', err.message);
    process.exit(1);
});
