#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');

function parseArgs(argv) {
  const optionNames = new Set(['--input', '-i', '--source', '-s', '--db', '--help', '-h', '--replace-source']);
  const isOptionToken = (value) => optionNames.has(value);
  const args = {};
  const collectValue = (startIdx) => {
    const parts = [];
    for (let j = startIdx; j < argv.length; j += 1) {
      const part = argv[j];
      if (isOptionToken(part)) break;
      parts.push(part);
    }
    return {
      value: parts.join(' ').trim(),
      consumed: parts.length
    };
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--input':
      case '-i':
        {
          const { value, consumed } = collectValue(i + 1);
          args.input = value || args.input;
          i += consumed;
        }
        break;
      case '--source':
      case '-s':
        {
          const { value, consumed } = collectValue(i + 1);
          args.source = value || args.source;
          i += consumed;
        }
        break;
      case '--db':
        {
          const { value, consumed } = collectValue(i + 1);
          args.db = value || args.db;
          i += consumed;
        }
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--replace-source':
        args.replaceSource = true;
        break;
      default:
        if (!token.startsWith('-') && !args.input) {
          args.input = token;
        }
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Uso:
  node tools/extrair-doutrina.js --input <arquivo.pdf|txt> [opcoes]

Opcoes:
  --input, -i   Caminho para PDF/TXT pesquisavel
  --source, -s  Nome do livro/fonte (default: nome do arquivo)
  --db          Caminho do SQLite (default: dados/doutrina/index.db)
  --replace-source  Remove entradas antigas da mesma fonte antes de inserir
  --help, -h    Mostra esta ajuda
`);
}

function commandExists(cmd) {
  const result = spawnSync('bash', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' });
  return result.status === 0;
}

function extractTextFromPdf(filePath) {
  if (!commandExists('pdftotext')) {
    throw new Error('pdftotext não encontrado. Instale poppler-utils para extrair PDF.');
  }
  const result = spawnSync('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });

  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '').trim();

  // Alguns PDFs retornam avisos em stderr; aproveita o texto extraído quando útil.
  if (result.status !== 0 && !stdout.trim()) {
    throw new Error(`Falha ao extrair PDF: ${stderr || `código ${result.status}`}`);
  }
  if (stderr) {
    console.warn(`Aviso do pdftotext: ${stderr}`);
  }
  return stdout;
}

function normalizeText(raw) {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitPages(text) {
  if (!text) return [];
  const pages = text.split('\f').map((p) => normalizeText(p)).filter(Boolean);
  return pages.length ? pages : [normalizeText(text)];
}

function normalizeInline(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isUpperTitle(line) {
  const value = normalizeInline(line);
  if (value.length < 4 || value.length > 120) return false;
  if (!/[A-ZÁÀÂÃÉÈÍÓÔÕÚÇ]/.test(value)) return false;
  return /^[A-ZÁÀÂÃÉÈÍÓÔÕÚÇ0-9\s\-.,:;()]+$/.test(value);
}

function detectHeading(line) {
  const value = normalizeInline(line);
  if (!value || value.length > 140) return null;
  const rules = [
    { level: 1, type: 'titulo', re: /^(T[ÍI]TULO|LIVRO)\s+[IVXLCDM0-9]+[\s\-.:]*(.*)$/i },
    { level: 2, type: 'capitulo', re: /^CAP[ÍI]TULO\s+[IVXLCDM0-9]+[\s\-.:]*(.*)$/i },
    { level: 3, type: 'secao', re: /^SE[CÇ][ÃA]O\s+[IVXLCDM0-9]+[\s\-.:]*(.*)$/i },
    { level: 4, type: 'artigo', re: /^(ARTIGO|ART\.?)\s+\d+[.ºo-]*[\s\-.:]*(.*)$/i },
    { level: 4, type: 'topico', re: /^\d+\.\d+(\.\d+)*\s+.{3,}$/ },
    { level: 4, type: 'topico', re: /^\d+[.)]\s+.{3,}$/ }
  ];
  const matched = rules.find((rule) => rule.re.test(value));
  if (matched) return { text: value, level: matched.level, type: matched.type };
  if (isUpperTitle(value)) return { text: value, level: 3, type: 'titulo' };
  if (value.length <= 70 && /^(conceito|defini[cç][aã]o|fundamento|exce[cç][aã]o|natureza|efeitos|requisitos)\b/i.test(value)) {
    return { text: value, level: 4, type: 'topico' };
  }
  return null;
}

function splitSentences(text) {
  return normalizeInline(text)
    .split(/(?<=[.!?;:])\s+/)
    .map((s) => normalizeInline(s))
    .filter((s) => s.length >= 30);
}

function pickSentences(sentences, regexes, max = 2) {
  const found = [];
  sentences.forEach((sentence) => {
    if (found.length >= max) return;
    if (regexes.some((re) => re.test(sentence))) found.push(sentence);
  });
  return found;
}

function extractKeywords(text, headings = []) {
  const stop = new Set([
    'para', 'como', 'pela', 'pelo', 'pelos', 'pelas', 'esta', 'este', 'essa', 'esse',
    'aquele', 'aquela', 'sobre', 'entre', 'tambem', 'também', 'quando', 'onde',
    'direito', 'juridico', 'jurídico', 'juridica', 'jurídica', 'norma', 'lei', 'artigo'
  ]);
  const base = `${headings.join(' ')} ${text}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');
  const counts = new Map();
  base.split(/\s+/)
    .filter((token) => token.length >= 4 && !stop.has(token))
    .forEach((token) => counts.set(token, (counts.get(token) || 0) + 1));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([token]) => token);
}

function extractRelations(sentences) {
  return pickSentences(sentences, [
    /\b(difere|distingue-se|ao contr[aá]rio|por outro lado|semelhante|similar|compar(a|ação)|contraste|relação)\b/i
  ], 2);
}

function buildCognitiveUnit(section, idx) {
  const text = normalizeInline(section.lines.join(' '));
  if (text.length < 100) return null;

  const sentences = splitSentences(text);
  const definicoes = pickSentences(sentences, [
    /\b(é|são|consiste|define-se|entende-se|compreende-se|significa)\b/i
  ], 3);
  const fundamentos = pickSentences(sentences, [
    /\b(nos termos|de acordo|conforme|artigo|art\.|c[oó]digo|lei|constitui[cç][aã]o)\b/i
  ], 3);
  const excecoes = pickSentences(sentences, [
    /\b(salvo|exceto|excepto|n[aã]o se aplica|ressalvad[oa]s?|sem preju[ií]zo)\b/i
  ], 3);
  const exemplos = pickSentences(sentences, [
    /\b(por exemplo|imagine|caso|hip[oó]tese|suponha|numa hip[oó]tese|em caso de)\b/i
  ], 2);
  const distincao = pickSentences(sentences, [
    /\b(difere|distingue-se|ao contr[aá]rio|por outro lado|distin[cç][aã]o|compar(a|ação)|semelhante|similar)\b/i
  ], 2);
  const relacoes = extractRelations(sentences);

  const pathParts = section.path.map((h) => h.text);
  const conceito = section.heading?.text || pathParts[pathParts.length - 1] || `Unidade ${idx + 1}`;
  const explicacao = definicoes[0] || sentences.find((s) => s.length <= 260) || text.slice(0, 260);
  const keywords = extractKeywords(text, pathParts);
  const rawText = text.length > 1400 ? `${text.slice(0, 1400).trim()}…` : text;
  const embeddingText = normalizeInline([
    conceito,
    explicacao,
    definicoes.join(' '),
    fundamentos.join(' '),
    excecoes.join(' '),
    exemplos.join(' '),
    distincao.join(' '),
    relacoes.join(' '),
    keywords.join(' ')
  ].join(' '));

  return {
    source: section.source,
    pageStart: section.pageStart,
    pageEnd: section.pageEnd,
    disciplina: '',
    tema: pathParts[0] || '',
    subtema: pathParts.slice(1).join(' > '),
    conceito,
    explicacao,
    exemplo: exemplos[0] || '',
    excecoes,
    fundamentacao: fundamentos,
    definicoes,
    distincao: distincao[0] || '',
    relacoes,
    keywords,
    hierarchy: pathParts,
    rawText,
    embeddingText
  };
}

function extractCognitiveUnits(pages, source) {
  const sections = [];
  const headingStack = [];
  let current = null;

  const flush = () => {
    if (current && current.lines.join(' ').trim().length >= 120) {
      sections.push(current);
    }
  };

  pages.forEach((pageText, pageIdx) => {
    const lines = String(pageText || '')
      .split('\n')
      .map((line) => normalizeInline(line))
      .filter(Boolean);

    lines.forEach((line) => {
      const heading = detectHeading(line);
      if (heading) {
        flush();
        while (headingStack.length && headingStack[headingStack.length - 1].level >= heading.level) {
          headingStack.pop();
        }
        headingStack.push(heading);
        current = {
          source,
          heading,
          path: [...headingStack],
          pageStart: pageIdx + 1,
          pageEnd: pageIdx + 1,
          lines: []
        };
        return;
      }

      if (!current) {
        current = {
          source,
          heading: null,
          path: [...headingStack],
          pageStart: pageIdx + 1,
          pageEnd: pageIdx + 1,
          lines: []
        };
      }
      current.pageEnd = pageIdx + 1;
      current.lines.push(line);

      const currentSize = current.lines.join(' ').length;
      if ((currentSize >= 1600 && /[.!?;:]$/.test(line)) || current.lines.length >= 18) {
        flush();
        current = {
          source,
          heading: current.heading,
          path: [...headingStack],
          pageStart: pageIdx + 1,
          pageEnd: pageIdx + 1,
          lines: []
        };
      }
    });
  });

  flush();
  return sections.map(buildCognitiveUnit).filter(Boolean);
}

function ensureDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite3.Database(dbPath);
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS doutrina_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS doutrina_fts USING fts5(
      source, page, content
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS doutrina_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      page_start INTEGER,
      page_end INTEGER,
      disciplina TEXT,
      tema TEXT,
      subtema TEXT,
      conceito TEXT,
      explicacao TEXT,
      exemplo TEXT,
      excecoes_json TEXT,
      fundamentacao_json TEXT,
      definicoes_json TEXT,
      distincao TEXT,
      keywords_json TEXT,
      hierarchy_json TEXT,
      raw_text TEXT,
      embedding_text TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS doutrina_units_fts USING fts5(
      source,
      tema,
      subtema,
      conceito,
      explicacao,
      fundamentacao,
      keywords,
      embedding_text
    )`);
  });
  return db;
}

function insertCognitiveUnits(db, source, units, replaceSource = false) {
  return new Promise((resolve, reject) => {
    let failed = false;
    const fail = (error) => {
      if (!failed) {
        failed = true;
        reject(error);
      }
    };

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      if (replaceSource) {
        db.run('DELETE FROM doutrina_fts WHERE source = ?', [source]);
        db.run('DELETE FROM doutrina_units_fts WHERE rowid IN (SELECT id FROM doutrina_units WHERE source = ?)', [source]);
        db.run('DELETE FROM doutrina_units WHERE source = ?', [source], (deleteErr) => {
          if (deleteErr) {
            fail(deleteErr);
          }
        });
      }

      const stmt = db.prepare(
        `INSERT INTO doutrina_units
         (source, page_start, page_end, disciplina, tema, subtema, conceito, explicacao, exemplo,
          excecoes_json, fundamentacao_json, definicoes_json, distincao, keywords_json, hierarchy_json,
          raw_text, embedding_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        (prepErr) => {
          if (prepErr) {
            return reject(prepErr);
          }
        }
      );
      const ftsStmt = db.prepare(
        `INSERT INTO doutrina_units_fts
         (rowid, source, tema, subtema, conceito, explicacao, fundamentacao, keywords, embedding_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        (prepErr) => {
          if (prepErr) {
            return reject(prepErr);
          }
        }
      );

      const insertOne = (unit) => {
        stmt.run(
          unit.source,
          unit.pageStart,
          unit.pageEnd,
          unit.disciplina,
          unit.tema,
          unit.subtema,
          unit.conceito,
          unit.explicacao,
          unit.exemplo,
          JSON.stringify(unit.excecoes || []),
          JSON.stringify(unit.fundamentacao || []),
          JSON.stringify(unit.definicoes || []),
          unit.distincao,
          JSON.stringify(unit.keywords || []),
          JSON.stringify(unit.hierarchy || []),
          unit.rawText,
          unit.embeddingText,
          function insertFts(insertErr) {
            if (insertErr) {
              fail(insertErr);
              return;
            }
            ftsStmt.run(
              this.lastID,
              unit.source,
              unit.tema,
              unit.subtema,
              unit.conceito,
              unit.explicacao,
              (unit.fundamentacao || []).join(' '),
              (unit.keywords || []).join(' '),
              unit.embeddingText,
              (ftsErr) => {
                if (ftsErr) fail(ftsErr);
              }
            );
          }
        );
      };

      units.forEach(insertOne);

      stmt.finalize((finalizeErr) => {
        if (finalizeErr) {
          return reject(finalizeErr);
        }
        ftsStmt.finalize((ftsErr) => {
          if (ftsErr) {
            return reject(ftsErr);
          }
          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              return reject(commitErr);
            }
            db.close((closeErr) => {
              if (closeErr) {
                return reject(closeErr);
              }
              resolve();
            });
          });
        });
      });
    });
  });
}

function insertLegacyPages(db, source, pages, replaceSource = false) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      if (replaceSource) {
        db.run('DELETE FROM doutrina_fts WHERE source = ?', [source], (deleteErr) => {
          if (deleteErr) {
            reject(deleteErr);
          }
        });
      }

      const stmt = db.prepare('INSERT INTO doutrina_fts (source, page, content) VALUES (?, ?, ?)', (prepErr) => {
        if (prepErr) {
          return reject(prepErr);
        }
      });

      pages.forEach((content, idx) => {
        stmt.run(source, idx + 1, content);
      });

      stmt.finalize((finalizeErr) => {
        if (finalizeErr) {
          return reject(finalizeErr);
        }
        db.close((closeErr) => {
          if (closeErr) {
            return reject(closeErr);
          }
          resolve();
        });
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.input) {
    printHelp();
    process.exit(args.input ? 0 : 1);
  }

  const inputPath = String(args.input || '').trim();
  if (!inputPath) {
    throw new Error('Caminho de input vazio. Use --input <arquivo.pdf|txt>.');
  }
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Arquivo de input não encontrado: ${inputPath}`);
  }

  const ext = path.extname(inputPath).toLowerCase();
  const source = args.source || path.basename(inputPath, ext);
  const dbPath = args.db || path.join('dados', 'doutrina', 'index.db');

  let raw = '';
  if (ext === '.pdf') {
    raw = extractTextFromPdf(inputPath);
  } else if (ext === '.txt') {
    raw = fs.readFileSync(inputPath, 'utf8');
  } else {
    throw new Error(`Formato não suportado (${ext || 'sem extensão'}). Use PDF ou TXT.`);
  }

  const pages = splitPages(raw);
  if (!pages.length) {
    throw new Error('Nenhum texto válido encontrado.');
  }
  const units = extractCognitiveUnits(pages, source);
  if (!units.length) {
    throw new Error('Nenhuma unidade cognitiva válida encontrada.');
  }

  const db = ensureDb(dbPath);
  await insertCognitiveUnits(db, source, units, Boolean(args.replaceSource));

  console.log(`✅ Doutrina estruturada: ${source} (${units.length} unidades cognitivas, ${pages.length} páginas analisadas) -> ${dbPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  ensureDb,
  extractCognitiveUnits,
  insertCognitiveUnits,
  splitPages,
  normalizeText
};
