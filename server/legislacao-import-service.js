const { v4: uuidv4 } = require('uuid');
const { pool, initLegislacaoSchema } = require('./postgres');

function toArray(input) {
    if (!input) return [];
    return Array.isArray(input) ? input : [input];
}

function limparTextoBase(texto) {
    return String(texto || '')
        .replace(/\u0007/g, ' ')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
}

function linhaEhCabecalhoRodape(line) {
    const txt = String(line || '').trim();
    if (!txt) return false;

    if (/^produzido pela\b/i.test(txt)) return true;
    if (/^p[aá]gina\s+\d+\b/i.test(txt)) return true;
    if (/^\d{1,4}$/.test(txt)) return true;
    if (/^minist[ée]rio\b/i.test(txt)) return true;
    if (/^assembleia nacional\b/i.test(txt)) return true;
    if (/^rep[úu]blica de angola\b/i.test(txt)) return true;
    if (/^lei\b.*\bn[.ºo]/i.test(txt) && txt.length <= 120) return true;

    return false;
}

function limparCabecalhosRodapes(texto) {
    const linhas = limparTextoBase(texto).split('\n');
    const filtradas = linhas.filter((line) => !linhaEhCabecalhoRodape(line));
    return filtradas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function epigrafeInvalida(epigrafe) {
    const txt = String(epigrafe || '').trim();
    if (!txt) return true;
    if (/^[º.\-–—\s]+$/.test(txt)) return true;
    if (txt.length < 2) return true;
    return false;
}

function separarEpigrafeEConteudo(artigo) {
    let epigrafe = String(artigo?.epigrafe || '').trim();
    let conteudo = limparCabecalhosRodapes(artigo?.conteudo || '');

    // Muitos arquivos vêm com "º" em epigrafe e a epigrafe real dentro do conteúdo.
    const matchTitulo = conteudo.match(/^\s*º?\s*\n?\s*\(([^)\n]{2,220})\)\s*\n?/);
    if (matchTitulo) {
        const epigrafeDoConteudo = String(matchTitulo[1] || '').trim();
        if (epigrafeInvalida(epigrafe) && epigrafeDoConteudo) {
            epigrafe = epigrafeDoConteudo;
        }
        conteudo = conteudo.slice(matchTitulo[0].length).trim();
    }

    if (!epigrafeInvalida(epigrafe)) {
        const escaped = epigrafe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regexInicio = new RegExp(`^\\s*\\(?${escaped}\\)?\\s*\\n?`, 'i');
        conteudo = conteudo.replace(regexInicio, '').trim();
    } else {
        epigrafe = '';
    }

    conteudo = conteudo.replace(/^\s*º\s*\n?/, '').trim();
    return { epigrafe, conteudo };
}

function normalizarAlineas(alineas) {
    if (!alineas) return [];

    if (Array.isArray(alineas)) {
        return alineas
            .map((item) => {
                if (!item) return null;
                if (typeof item === 'string') {
                    const m = item.match(/^([a-z])\)\s*(.*)$/i);
                    if (!m) return null;
                    return { letra: m[1].toLowerCase(), conteudo: m[2].trim() };
                }
                const letra = String(item.letra || item.key || '').toLowerCase().trim();
                const conteudo = String(item.conteudo || item.texto || '').trim();
                if (!letra || !conteudo) return null;
                return { letra, conteudo };
            })
            .filter(Boolean);
    }

    if (typeof alineas === 'object') {
        return Object.entries(alineas)
            .map(([letra, conteudo]) => {
                const letraNorm = String(letra || '').toLowerCase().trim();
                const conteudoNorm = String(conteudo || '').trim();
                if (!letraNorm || !conteudoNorm) return null;
                return { letra: letraNorm, conteudo: conteudoNorm };
            })
            .filter(Boolean);
    }

    return [];
}

function normalizarParagrafos(artigo) {
    const paragrafos = toArray(artigo?.paragrafos)
        .map((p) => {
            if (!p || typeof p !== 'object') return null;
            const numero = p.numero !== undefined && p.numero !== null ? String(p.numero) : 'caput';
            const conteudo = limparCabecalhosRodapes(p.conteudo || '');
            return {
                numero: numero || 'caput',
                conteudo,
                alineas: normalizarAlineas(p.alineas)
            };
        })
        .filter(Boolean);

    if (paragrafos.length > 0) return paragrafos;

    const conteudoArtigo = limparCabecalhosRodapes(artigo?.conteudo || '');
    if (!conteudoArtigo) return [];

    return [{ numero: 'caput', conteudo: conteudoArtigo, alineas: [] }];
}

async function processarAlinea(client, letra, conteudo, paragrafoId, ordem) {
    await client.query(
        `INSERT INTO alineas (id, paragrafo_id, letra, conteudo, ordem)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), paragrafoId, letra, conteudo, ordem]
    );
}

async function processarParagrafo(client, paragrafo, artigoId, ordem) {
    const paragrafoId = uuidv4();
    await client.query(
        `INSERT INTO paragrafos (id, artigo_id, numero, conteudo, ordem)
         VALUES ($1, $2, $3, $4, $5)`,
        [paragrafoId, artigoId, paragrafo.numero || 'caput', paragrafo.conteudo || '', ordem]
    );

    const alineas = normalizarAlineas(paragrafo.alineas);
    for (let i = 0; i < alineas.length; i++) {
        await processarAlinea(client, alineas[i].letra, alineas[i].conteudo, paragrafoId, i);
    }
}

async function processarArtigo(client, artigo, legislacaoId, estruturaId) {
    const numeroArtigo = String(artigo?.numero || '').trim();
    if (!numeroArtigo) return;
    const { epigrafe, conteudo } = separarEpigrafeEConteudo(artigo);

    const artigoId = uuidv4();
    await client.query(
        `INSERT INTO artigos (id, legislacao_id, estrutura_id, numero, epigrafe, conteudo)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [artigoId, legislacaoId, estruturaId, numeroArtigo, epigrafe || '', conteudo || '']
    );

    const artigoNormalizado = { ...artigo, epigrafe, conteudo };
    const paragrafos = normalizarParagrafos(artigoNormalizado);
    for (let i = 0; i < paragrafos.length; i++) {
        await processarParagrafo(client, paragrafos[i], artigoId, i);
    }
}

async function processarEstrutura(client, item, legislacaoId, parentId, nivel, ordem) {
    const estruturaId = uuidv4();
    await client.query(
        `INSERT INTO estruturas (id, legislacao_id, tipo, numero, titulo, parent_id, nivel, ordem)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
            estruturaId,
            legislacaoId,
            item.tipo || 'GERAL',
            item.numero || '',
            item.titulo || '',
            parentId,
            nivel,
            ordem
        ]
    );

    const artigos = toArray(item.artigos);
    for (const artigo of artigos) {
        await processarArtigo(client, artigo, legislacaoId, estruturaId);
    }

    const subestruturas = toArray(item.subestruturas);
    for (let i = 0; i < subestruturas.length; i++) {
        await processarEstrutura(client, subestruturas[i], legislacaoId, estruturaId, nivel + 1, i);
    }
}

async function limparLegislacaoAnterior(client, legislacaoId) {
    await client.query(`DELETE FROM alineas WHERE paragrafo_id IN (
        SELECT p.id FROM paragrafos p
        JOIN artigos a ON a.id = p.artigo_id
        WHERE a.legislacao_id = $1
    )`, [legislacaoId]);
    await client.query(`DELETE FROM alineas WHERE artigo_id IN (
        SELECT id FROM artigos WHERE legislacao_id = $1
    )`, [legislacaoId]);
    await client.query(`DELETE FROM paragrafos WHERE artigo_id IN (
        SELECT id FROM artigos WHERE legislacao_id = $1
    )`, [legislacaoId]);
    await client.query(`DELETE FROM artigos WHERE legislacao_id = $1`, [legislacaoId]);
    await client.query(`DELETE FROM estruturas WHERE legislacao_id = $1`, [legislacaoId]);
    await client.query(`DELETE FROM legislacoes WHERE id = $1`, [legislacaoId]);
}

function extrairEstruturas(dados) {
    if (Array.isArray(dados?.estrutura)) return dados.estrutura;
    if (Array.isArray(dados?.estruturas)) return dados.estruturas;
    if (Array.isArray(dados?.conteudo?.estrutura)) return dados.conteudo.estrutura;
    if (Array.isArray(dados?.conteudo?.estruturas)) return dados.conteudo.estruturas;
    if (Array.isArray(dados?.indice)) return converterIndiceParaEstruturas(dados.indice);
    if (Array.isArray(dados?.índice)) return converterIndiceParaEstruturas(dados.índice);
    if (Array.isArray(dados?.conteudo?.indice)) return converterIndiceParaEstruturas(dados.conteudo.indice);
    if (Array.isArray(dados?.conteudo?.índice)) return converterIndiceParaEstruturas(dados.conteudo.índice);
    return [];
}

function tipoIndiceNormalizado(tipo) {
    const raw = String(tipo || 'INDICE')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .trim();

    if (raw.includes('LIVRO')) return 'LIVRO';
    if (raw.includes('TITULO')) return 'TITULO';
    if (raw.includes('CAPITULO')) return 'CAPITULO';
    if (raw.includes('SECAO')) return 'SECAO';
    if (raw.includes('SUBSECAO')) return 'SUBSECAO';
    if (raw.includes('DIVISAO')) return 'DIVISAO';
    if (raw.includes('PARTE')) return 'PARTE';
    return raw || 'INDICE';
}

function parseIndiceLinha(line) {
    const txt = String(line || '').trim();
    if (!txt) return null;
    const m = txt.match(/^(LIVRO|T[IÍ]TULO|CAP[IÍ]TULO|SEC[CÇ][AÃ]O|SUBSEC[CÇ][AÃ]O|DIVIS[AÃ]O|PARTE)\s+([IVXLCDM0-9]+)\s*[-:–—.]?\s*(.*)$/i);
    if (!m) {
        return { tipo: 'INDICE', numero: '', titulo: txt, artigos: [], subestruturas: [] };
    }
    return {
        tipo: tipoIndiceNormalizado(m[1]),
        numero: String(m[2] || '').trim(),
        titulo: String(m[3] || '').trim(),
        artigos: [],
        subestruturas: []
    };
}

function normalizarIndiceItem(item) {
    if (!item) return null;

    if (typeof item === 'string') {
        return parseIndiceLinha(item);
    }

    if (typeof item === 'object') {
        const tipo = tipoIndiceNormalizado(item.tipo || item.level || item.nivel || item.kind || 'INDICE');
        const numero = String(item.numero || item.num || item.id || '').trim();
        const titulo = String(item.titulo || item.nome || item.texto || item.label || '').trim();
        const filhos = toArray(item.subestruturas || item.subitens || item.filhos || item.items)
            .map(normalizarIndiceItem)
            .filter(Boolean);

        if (!tipo && !titulo && !filhos.length) return null;
        return {
            tipo: tipo || 'INDICE',
            numero,
            titulo,
            artigos: [],
            subestruturas: filhos
        };
    }

    return null;
}

function converterIndiceParaEstruturas(indice) {
    return toArray(indice).map(normalizarIndiceItem).filter(Boolean);
}

function mapIndicePorChave(estruturasIndice) {
    const map = new Map();
    const visitar = (items) => {
        for (const item of items) {
            const tipo = tipoIndiceNormalizado(item.tipo || '');
            const numero = String(item.numero || '').trim().toUpperCase();
            const titulo = String(item.titulo || '').trim();
            if (tipo && numero && titulo) {
                map.set(`${tipo}:${numero}`, titulo);
            }
            visitar(toArray(item.subestruturas));
        }
    };
    visitar(toArray(estruturasIndice));
    return map;
}

function preencherTitulosComIndice(estruturasBase, estruturasIndice) {
    const indiceMap = mapIndicePorChave(estruturasIndice);
    const clonar = (item) => {
        const tipo = tipoIndiceNormalizado(item.tipo || '');
        const numero = String(item.numero || '').trim().toUpperCase();
        const chave = `${tipo}:${numero}`;
        const tituloAtual = String(item.titulo || '').trim();
        const tituloIndice = indiceMap.get(chave) || '';
        return {
            ...item,
            tipo: item.tipo || tipo || 'GERAL',
            titulo: tituloAtual || tituloIndice || '',
            artigos: toArray(item.artigos),
            subestruturas: toArray(item.subestruturas).map(clonar)
        };
    };
    return toArray(estruturasBase).map(clonar);
}

async function importarLegislacaoJson(dados) {
    if (!dados || typeof dados !== 'object') {
        throw new Error('Payload inválido para importação');
    }

    const nome = String(dados.nome || '').trim();
    if (!nome) {
        throw new Error('Campo nome é obrigatório');
    }

    const estruturasBase = extrairEstruturas(dados);
    const estruturasIndice = converterIndiceParaEstruturas(
        dados?.indice || dados?.índice || dados?.conteudo?.indice || dados?.conteudo?.índice || []
    );
    const estruturas = estruturasBase.length
        ? preencherTitulosComIndice(estruturasBase, estruturasIndice)
        : estruturasIndice;

    if (estruturas.length === 0) {
        throw new Error('Estrutura da legislação não encontrada no JSON');
    }

    const legislacaoId = String(dados.id || uuidv4()).trim();

    await initLegislacaoSchema();

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await limparLegislacaoAnterior(client, legislacaoId);

        await client.query(
            `INSERT INTO legislacoes (id, nome, descricao, fundamentacao, data_publicacao)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                legislacaoId,
                nome,
                dados.descricao || '',
                dados.fundamentacao || '',
                dados.data_publicacao || null
            ]
        );

        for (let i = 0; i < estruturas.length; i++) {
            await processarEstrutura(client, estruturas[i], legislacaoId, null, 0, i);
        }

        await client.query('COMMIT');
        return { id: legislacaoId, nome };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    importarLegislacaoJson
};
