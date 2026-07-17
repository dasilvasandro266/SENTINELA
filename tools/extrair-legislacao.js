#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp']);
const STRUCTURE_TYPES = [
  { tipo: 'PARTE', regex: /^\s*(PARTE)\s+([IVXLCDM]+|\d+[A-Z0-9\-]*)\b[\s:\-–—.]*(.*)$/i, nivel: 0, numeroIndex: 2, tituloIndex: 3 },
  { tipo: 'LIVRO', regex: /^\s*(LIVRO)\s+([IVXLCDM]+|\d+[A-Z0-9\-]*)\b[\s:\-–—.]*(.*)$/i, nivel: 1, numeroIndex: 2, tituloIndex: 3 },
  { tipo: 'TITULO', regex: /^\s*(T[ÍI]TULO)\s+([IVXLCDM]+|\d+[A-Z0-9\-]*)\b[\s:\-–—.]*(.*)$/i, nivel: 2, numeroIndex: 2, tituloIndex: 3 },
  { tipo: 'CAPITULO', regex: /^\s*(CAP[ÍI]TULO)\s+([IVXLCDM]+|\d+[A-Z0-9\-]*)\b[\s:\-–—.]*(.*)$/i, nivel: 3, numeroIndex: 2, tituloIndex: 3 },
  { tipo: 'SECAO', regex: /^\s*(SE[CÇ][AÃ]O|SEC[CÇ][AÃ]O)\s+([IVXLCDM]+|\d+[A-Z0-9\-]*)\b[\s:\-–—.]*(.*)$/i, nivel: 4, numeroIndex: 2, tituloIndex: 3 },
  { tipo: 'SUBSECAO', regex: /^\s*(SUBSE[CÇ][AÃ]O|SUBSEC[CÇ][AÃ]O)\s+([IVXLCDM]+|\d+[A-Z0-9\-]*)\b[\s:\-–—.]*(.*)$/i, nivel: 5, numeroIndex: 2, tituloIndex: 3 },
  { tipo: 'SECAO', regex: /^\s*(SE[CÇ][AÃ]O|SEC[CÇ][AÃ]O)\b[\s:\-–—.]*(.*)$/i, nivel: 4, numeroIndex: null, tituloIndex: 2 },
  { tipo: 'SUBSECAO', regex: /^\s*(SUBSE[CÇ][AÃ]O|SUBSEC[CÇ][AÃ]O)\b[\s:\-–—.]*(.*)$/i, nivel: 5, numeroIndex: null, tituloIndex: 2 }
];

function parseArgs(argv) {
  const args = {
    ocr: 'auto',
    lang: 'por',
    descricao: '',
    fundamentacao: '',
    minTextForPdf: 500,
    columns: 1,
    ignoreFootnotes: true
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    switch (token) {
      case '--input':
      case '-i':
        args.input = next;
        i += 1;
        break;
      case '--output':
      case '-o':
        args.output = next;
        i += 1;
        break;
      case '--nome':
      case '-n':
        args.nome = next;
        i += 1;
        break;
      case '--id':
        args.id = next;
        i += 1;
        break;
      case '--descricao':
        args.descricao = next;
        i += 1;
        break;
      case '--fundamentacao':
        args.fundamentacao = next;
        i += 1;
        break;
      case '--ocr':
        args.ocr = next;
        i += 1;
        break;
      case '--lang':
        args.lang = next;
        i += 1;
        break;
      case '--raw-text':
        args.rawTextOutput = next;
        i += 1;
        break;
      case '--min-text':
        args.minTextForPdf = Number(next) || args.minTextForPdf;
        i += 1;
        break;
      case '--columns':
        args.columns = Number(next) || args.columns;
        i += 1;
        break;
      case '--duplex':
      case '--dupla-face':
        args.columns = 2;
        break;
      case '--keep-footnotes':
        args.ignoreFootnotes = false;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (!token.startsWith('-') && !args.input) {
          args.input = token;
        } else {
          throw new Error(`Argumento desconhecido: ${token}`);
        }
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Uso:
  node tools/extrair-legislacao.js --input <arquivo> [opcoes]

Opcoes:
  --input, -i         Caminho para PDF, imagem ou TXT
  --output, -o        Caminho do JSON de saida (default: dados/<nome>.json)
  --nome, -n          Nome da legislacao (default: nome do arquivo)
  --id                ID da legislacao (default: slug do nome)
  --descricao         Descricao opcional
  --fundamentacao     Texto de fundamentacao opcional
  --ocr               auto | always | never (default: auto)
  --lang              Idioma do OCR no Tesseract (default: por)
  --raw-text          Salva o texto bruto extraido em arquivo
  --min-text          Minimo de caracteres no PDF para evitar OCR (default: 500)
  --columns           Numero de colunas (1 ou 2) para OCR (default: 1)
  --duplex            Atalho para --columns 2 em scans com paginas lado a lado
  --keep-footnotes    Mantem notas de rodape no texto extraido
  --help, -h          Mostra esta ajuda

Exemplos:
  node tools/extrair-legislacao.js -i /home/sandrodasilva/Transferências/Livro-da-Lei-Geral-do-Trabalho.pdf -n "Lei Geral do Trabalho" -o dados/legislacao/lei-geral-do-trabalho.json
  node tools/extrair-legislacao.js -i scans/pagina1.jpg --ocr always --lang por
`);
}

function assertArg(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function commandExists(cmd) {
  const result = spawnSync('bash', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' });
  return result.status === 0;
}

function pythonHasPIL() {
  if (!commandExists('python3')) return false;
  const result = spawnSync('python3', ['-c', 'import PIL; print("ok")'], { encoding: 'utf8' });
  return result.status === 0;
}

function runCommand(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    ...options
  });

  if (result.status !== 0) {
    const err = (result.stderr || '').trim();
    throw new Error(`Falha ao executar ${cmd}: ${err || 'sem detalhes'}`);
  }

  return (result.stdout || '').toString();
}

function normalizeText(raw) {
  return raw
    .replace(/-\n(?=[a-záéíóúâêôãõç])/gi, '')
    .replace(/\f/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/\u0007/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripFootnoteNoise(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let skippingNoteBlock = false;

  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) {
      skippingNoteBlock = false;
      out.push(raw);
      continue;
    }

    const isFootnoteStart = (
      /^\d{1,3}\s+/.test(line) &&
      !/^(\d+\.|Art(?:igo)?\.?|CAP[ÍI]TULO|T[ÍI]TULO|LIVRO|PARTE|SE[CÇ][AÃ]O)\b/i.test(line) &&
      line.length > 35
    ) || /^(nota|notas|fonte|rodap[eé])\s*[:\-]/i.test(line);

    const isPageFooter = (
      /^\d{1,4}$/.test(line) ||
      /^\d{1,4}\s+\S+/.test(line) && /(di[aá]rio da rep[úu]blica|i s[ée]rie|lexlink|p[aá]gina|boletim|imprensa nacional)/i.test(line)
    );

    if (isFootnoteStart || isPageFooter) {
      skippingNoteBlock = isFootnoteStart;
      continue;
    }

    if (skippingNoteBlock && line.length < 140 && !/[.;:]$/.test(line)) {
      continue;
    }

    skippingNoteBlock = false;
    out.push(raw);
  }

  return out.join('\n');
}

function preprocessExtractedText(text, args) {
  let output = normalizeText(text);
  if (args.ignoreFootnotes) {
    output = stripFootnoteNoise(output);
  }
  return normalizeText(output)
    .replace(/\b(Art(?:igo)?\.?\s*[º°]?)\s*\n\s*(\d+)/gi, '$1 $2')
    .replace(/\b(PARTE|LIVRO|T[ÍI]TULO|CAP[ÍI]TULO|SE[CÇ][AÃ]O|SEC[CÇ][AÃ]O|SUBSE[CÇ][AÃ]O|SUBSEC[CÇ][AÃ]O)\s*\n\s*([IVXLCDM]+|\d+[A-Z0-9-]*)/gi, '$1 $2')
    .replace(/\n(?=[a-záéíóúâêôãõç,;:])/g, ' ');
}

function ensureText(inputText) {
  const text = normalizeText(inputText || '');
  if (!text) {
    throw new Error('Nao foi possivel extrair texto util do arquivo informado.');
  }
  return text;
}

function slugify(input) {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'legislacao';
}

function extractTextFromPdf(filePath, args) {
  if (!commandExists('pdftotext')) {
    throw new Error('pdftotext nao encontrado. Instale poppler-utils para extracao de PDF.');
  }

  let extracted = '';
  try {
    extracted = runCommand('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-']);
  } catch (err) {
    if (args.ocr === 'never') {
      throw err;
    }
  }

  const normalized = preprocessExtractedText(extracted, args);
  const needsOcr = args.ocr === 'always' || (args.ocr === 'auto' && normalized.length < args.minTextForPdf);

  if (!needsOcr) {
    return ensureText(normalized);
  }

  if (!commandExists('tesseract') || !commandExists('pdftoppm')) {
    if (normalized.length > 0) {
      console.warn('Aviso: OCR indisponivel (faltam tesseract/pdftoppm). Usando texto parcial do PDF.');
      return ensureText(normalized);
    }
    throw new Error('OCR de PDF requer tesseract e pdftoppm instalados no sistema.');
  }

  console.log('OCR ativado para PDF (texto insuficiente detectado).');
  return ensureText(preprocessExtractedText(ocrPdfWithTesseract(filePath, args.lang, args.columns), args));
}

function splitImageIntoColumns(imagePath, columns) {
  if (columns === 1) return [imagePath];
  if (!pythonHasPIL()) {
    throw new Error('OCR em colunas requer python3 + Pillow (PIL).');
  }

  const dir = path.dirname(imagePath);
  const base = path.basename(imagePath, path.extname(imagePath));
  const leftPath = path.join(dir, `${base}_col1.png`);
  const rightPath = path.join(dir, `${base}_col2.png`);

  runCommand('python3', ['-c', `
from PIL import Image
img = Image.open(r"${imagePath}")
w, h = img.size
left = img.crop((0, 0, w//2, h))
right = img.crop((w//2, 0, w, h))
left.save(r"${leftPath}")
right.save(r"${rightPath}")
`]);

  return [leftPath, rightPath];
}

function ocrPdfWithTesseract(filePath, lang, columns = 1) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-legislacao-'));

  try {
    const prefix = path.join(tempDir, 'page');
    runCommand('pdftoppm', ['-png', filePath, prefix]);

    const pages = fs
      .readdirSync(tempDir)
      .filter((file) => file.startsWith('page-') && file.endsWith('.png'))
      .sort((a, b) => {
        const na = Number((a.match(/page-(\d+)/) || [])[1] || 0);
        const nb = Number((b.match(/page-(\d+)/) || [])[1] || 0);
        return na - nb;
      });

    if (pages.length === 0) {
      throw new Error('Nenhuma pagina convertida para OCR.');
    }

    const chunks = [];
    for (const page of pages) {
      const pagePath = path.join(tempDir, page);
      const columnImages = splitImageIntoColumns(pagePath, columns);
      for (const colPath of columnImages) {
        const text = runCommand('tesseract', [colPath, 'stdout', '-l', lang, '--psm', '6']);
        if (text && text.trim()) chunks.push(text.trim());
      }
    }

    return chunks.join('\n\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function extractTextFromImage(filePath, args) {
  if (!commandExists('tesseract')) {
    throw new Error('Para imagens, o Tesseract e obrigatorio. Instale tesseract-ocr no sistema.');
  }

  const columnImages = splitImageIntoColumns(filePath, args.columns);
  const chunks = [];
  for (const colPath of columnImages) {
    const text = runCommand('tesseract', [colPath, 'stdout', '-l', args.lang, '--psm', '6']);
    if (text && text.trim()) chunks.push(text.trim());
  }
  return ensureText(preprocessExtractedText(chunks.join('\n\n'), args));
}

function extractText(filePath, args) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    return extractTextFromPdf(filePath, args);
  }

  if (ext === '.txt') {
    return ensureText(preprocessExtractedText(fs.readFileSync(filePath, 'utf8'), args));
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return extractTextFromImage(filePath, args);
  }

  throw new Error(`Formato nao suportado: ${ext}. Use PDF, imagem ou TXT.`);
}

function looksLikeEpigrafe(line) {
  if (!line) return false;
  if (/^[º°.\-–—\s]+$/.test(line)) return false;
  if (line.length > 120) return false;
  if (/^(§|[a-z]\)|[IVXLCDM]+\s*[-–—])/.test(line)) return false;
  if (/\.$/.test(line)) return false;
  return true;
}

function sanitizeLine(rawLine) {
  return String(rawLine || '')
    .replace(/\u0007/g, ' ')
    .replace(/\u00AD/g, '')
    // Remove notas de rodape conhecidas que vem coladas ao texto.
    .replace(/\bNOTA:\s*Redac[cç][aã]o\s+actualizada.*$/i, '')
    .replace(/\bNOTA:\s*Redac[cç][aã]o\s+atualizada.*$/i, '')
    .replace(/\b\d{1,4}\s+(LEI GERAL DO TRABALHO\s*-\s*LEI N[.ºo][^$]*)$/i, '')
    .replace(/\b\d{1,4}\s+(Minist[ée]rio da Administra[cç][aã]o P[úu]blica, Trabalho e Seguran[cç]a Social)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHeadingSpacing(line) {
  return String(line || '').replace(
    /\b(PARTE|LIVRO|T[ÍI]TULO|CAP[ÍI]TULO|SE[CÇ][AÃ]O|SEC[CÇ][AÃ]O|SUBSE[CÇ][AÃ]O|SUBSEC[CÇ][AÃ]O)(?=([IVXLCDM]+|\d))/gi,
    '$1 '
  );
}

function splitEmbeddedHeadings(line) {
  const normalized = normalizeHeadingSpacing(line);
  const headingRe = /\b(PARTE|LIVRO|T[ÍI]TULO|CAP[ÍI]TULO|SE[CÇ][AÃ]O|SEC[CÇ][AÃ]O|SUBSE[CÇ][AÃ]O|SUBSEC[CÇ][AÃ]O)\s+([IVXLCDM]+|\d+[A-Z0-9\-]*)\b/gi;
  const output = [];
  const queue = [normalized];

  while (queue.length > 0) {
    const chunk = queue.shift();
    const match = headingRe.exec(chunk);
    headingRe.lastIndex = 0;
    if (match && match.index > 0) {
      const before = chunk.slice(0, match.index).trim();
      const after = chunk.slice(match.index).trim();
      if (before) output.push(before);
      if (after) queue.unshift(after);
      continue;
    }
    output.push(chunk);
  }

  return output;
}

function isNoiseLine(line) {
  if (!line) return true;
  if (/^\d{1,4}$/.test(line)) return true;
  if (/^produzido pela\b/i.test(line)) return true;
  if (/^minist[ée]rio da administra[cç][aã]o p[úu]blica, trabalho e seguran[cç]a social$/i.test(line)) return true;
  if (/^lei geral do trabalho\s*-\s*lei n[.ºo]/i.test(line)) return true;
  if (/^\d{1,4}\s+lei geral do trabalho\s*-\s*lei n[.ºo]/i.test(line)) return true;
  if (/^\d{1,4}\s+minist[ée]rio da administra[cç][aã]o p[úu]blica, trabalho e seguran[cç]a social$/i.test(line)) return true;
  if (/^rep[úu]blica de angola$/i.test(line)) return true;
  if (/^assembleia nacional$/i.test(line)) return true;
  if (/^ficha t[eé]cnica$/i.test(line)) return true;
  if (/^nota:\s*redac[cç][aã]o\s+actualizada/i.test(line)) return true;
  if (/^nota:\s*redac[cç][aã]o\s+atualizada/i.test(line)) return true;
  if (/^todos os direitos reservados\b/i.test(line)) return true;
  if (/lexlink\b/i.test(line)) return true;
  if (/^\.{3,}\s*\d+\s*$/.test(line)) return true;
  if (/\.\.\.\.+\s*\d+\s*$/.test(line)) return true;
  return false;
}

function splitInlineAlineas(line) {
  const raw = String(line || '').trim();
  if (!raw) return [];

  const marker = /;\s*([a-z]{1,3})\)\s*/gi;
  if (!marker.test(raw)) {
    return [raw];
  }

  marker.lastIndex = 0;
  const parts = [];
  let start = 0;
  let match;

  while ((match = marker.exec(raw)) !== null) {
    const splitAt = match.index + 1;
    const previous = raw.slice(start, splitAt).trim();
    if (previous) {
      parts.push(previous);
    }

    const newStart = match.index + match[0].lastIndexOf(match[1]);
    start = newStart;
  }

  const tail = raw.slice(start).trim();
  if (tail) {
    parts.push(tail);
  }

  return parts.length > 0 ? parts : [raw];
}

function parseArticleBody(lines) {
  const cleanLines = lines
    .map((line) => sanitizeLine(line))
    .filter((line) => !isNoiseLine(line))
    .flatMap((line) => splitInlineAlineas(line));
  const result = {
    epigrafe: '',
    conteudo: cleanLines.join('\n'),
    paragrafos: []
  };

  if (cleanLines.length === 0) {
    return result;
  }

  while (cleanLines.length > 0 && /^[º°.\-–—\s]+$/.test(cleanLines[0])) {
    cleanLines.shift();
  }

  let cursor = 0;
  if (cleanLines.length > 1 && looksLikeEpigrafe(cleanLines[0])) {
    result.epigrafe = cleanLines[0];
    cursor = 1;
  }

  const caputLines = [];
  let paragrafoAtual = null;
  let ultimaAlinea = null;

  function flushParagrafo() {
    if (!paragrafoAtual) return;

    paragrafoAtual.conteudo = (paragrafoAtual.conteudo || '').trim();
    if (Object.keys(paragrafoAtual.alineas).length === 0) {
      delete paragrafoAtual.alineas;
    }

    if (paragrafoAtual.conteudo || paragrafoAtual.alineas) {
      result.paragrafos.push(paragrafoAtual);
    }

    paragrafoAtual = null;
    ultimaAlinea = null;
  }

  for (let i = cursor; i < cleanLines.length; i += 1) {
    const line = cleanLines[i];
    const paragrafoComSecaoMatch = line.match(/^§\s*(\d+[º°]?|u[úu]nico)\s*[-–—:)]?\s*(.*)$/i);
    const paragrafoNumericoMatch = line.match(/^(\d+)\.\s*(.+)$/);
    const alineaMatch = line.match(/^([a-z]{1,3})\)\s*(.*)$/i);

    const podeAbrirParagrafoNumerado = Boolean(
      paragrafoNumericoMatch && /[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(paragrafoNumericoMatch[2] || '')
    );

    if (paragrafoComSecaoMatch || podeAbrirParagrafoNumerado) {
      flushParagrafo();
      const numeroRaw = (
        (paragrafoComSecaoMatch && paragrafoComSecaoMatch[1]) ||
        (paragrafoNumericoMatch && paragrafoNumericoMatch[1]) ||
        ''
      ).toLowerCase();
      const numeroNormalizado = numeroRaw.replace('unico', 'unico');
      const numeroParagrafo = numeroNormalizado === 'unico' ? 'único' : numeroNormalizado;
      paragrafoAtual = {
        numero: numeroParagrafo,
        conteudo: (
          (paragrafoComSecaoMatch && paragrafoComSecaoMatch[2]) ||
          (paragrafoNumericoMatch && paragrafoNumericoMatch[2]) ||
          ''
        ).trim(),
        alineas: {}
      };
      ultimaAlinea = null;
      continue;
    }

    if (alineaMatch) {
      if (!paragrafoAtual) {
        paragrafoAtual = { numero: 'caput', conteudo: '', alineas: {} };
      }
      const letra = alineaMatch[1].toLowerCase();
      paragrafoAtual.alineas[letra] = (alineaMatch[2] || '').trim();
      ultimaAlinea = letra;
      continue;
    }

    if (ultimaAlinea && paragrafoAtual && paragrafoAtual.alineas[ultimaAlinea] !== undefined) {
      paragrafoAtual.alineas[ultimaAlinea] = `${paragrafoAtual.alineas[ultimaAlinea]} ${line}`.trim();
      continue;
    }

    if (paragrafoAtual) {
      paragrafoAtual.conteudo = `${paragrafoAtual.conteudo} ${line}`.trim();
    } else {
      caputLines.push(line);
    }
  }

  flushParagrafo();

  const caput = caputLines.join(' ').trim();
  if (caput) {
    result.paragrafos.unshift({ numero: 'caput', conteudo: caput });
  }

  return result;
}

function parseLegislation(text, metadata) {
  const lines = text.split('\n');
  const structures = [];
  const structureById = new Map();
  const stack = [];

  const rootId = 'root_1';
  const root = {
    id: rootId,
    tipo: 'GERAL',
    numero: '',
    titulo: 'Disposicoes Gerais',
    parentId: null,
    nivel: 0,
    ordem: 0,
    artigos: []
  };

  structures.push(root);
  structureById.set(rootId, root);

  let currentStructureId = rootId;
  let articleCounter = 0;
  let structureCounter = 1;
  let currentArticle = null;
  let pendingStructureId = null;
  let inIndice = false;

  function flushArticle() {
    if (!currentArticle) return;
    const parsed = parseArticleBody(currentArticle.bodyLines);
    const artigo = {
      numero: currentArticle.numero,
      epigrafe: parsed.epigrafe,
      conteudo: parsed.conteudo,
      paragrafos: parsed.paragrafos
    };

    const target = structureById.get(currentArticle.estruturaId) || root;
    target.artigos.push(artigo);
    currentArticle = null;
  }

  for (const rawLine of lines) {
    const sanitized = sanitizeLine(rawLine);
    const chunks = sanitized ? splitEmbeddedHeadings(sanitized) : [''];

    for (const rawChunk of chunks) {
      const line = sanitizeLine(rawChunk);
      if (!line) {
        if (currentArticle) currentArticle.bodyLines.push('');
        continue;
      }

      if (/^índice$/i.test(line)) {
        inIndice = true;
        continue;
      }
      if (inIndice) {
        if (/^assembleia nacional$/i.test(line) || /^lei n[.ºo]/i.test(line)) {
          inIndice = false;
        }
        continue;
      }

      if (isNoiseLine(line)) {
        continue;
      }

      if (pendingStructureId) {
        const looksLikeArticle = /^Art(?:igo)?\.?/i.test(line);
        const looksLikeStructure = STRUCTURE_TYPES.some((item) => item.regex.test(line));
        if (!looksLikeArticle && !looksLikeStructure && line.length <= 180) {
          const target = structureById.get(pendingStructureId);
          if (target && !target.titulo) {
            target.titulo = line.replace(/\s*\.\.\.+\s*\d+\s*$/, '').trim();
            pendingStructureId = null;
            continue;
          }
        }
        pendingStructureId = null;
      }

      const structureDef = STRUCTURE_TYPES.find((item) => item.regex.test(line));
      if (structureDef) {
        flushArticle();
        const match = line.match(structureDef.regex);

        while (stack.length > 0 && stack[stack.length - 1].nivel >= structureDef.nivel) {
          stack.pop();
        }

        const parent = stack.length > 0 ? stack[stack.length - 1] : root;
        structureCounter += 1;

        const numeroMatch = structureDef.numeroIndex ? match[structureDef.numeroIndex] : '';
        const tituloMatch = match[structureDef.tituloIndex] || '';
        const node = {
          id: `est_${structureCounter}`,
          tipo: structureDef.tipo,
          numero: (numeroMatch || '').trim(),
          titulo: (tituloMatch || '').trim(),
          parentId: parent.id,
          nivel: structureDef.nivel,
          ordem: structures.length,
          artigos: []
        };

        structures.push(node);
        structureById.set(node.id, node);
        stack.push(node);
        currentStructureId = node.id;
        if (!node.titulo) {
          pendingStructureId = node.id;
        }
        continue;
      }

      const articleMatch = line.match(/^Art(?:igo)?(?:\.|\s)*[º°]?\s*\.?\s*([0-9]+(?:\.[0-9]+)?(?:\.\s*[º°]|[º°])?(?:-[A-Za-z0-9]+)?)\s*[-–—.:)]?\s*(.*)$/i);
      if (articleMatch) {
        flushArticle();
        articleCounter += 1;
        const numeroNormalizado = String(articleMatch[1] || '')
          .replace(/[º°]/g, '')
          .replace(/\.\s*$/, '')
          .trim();
        const initialRemainder = String(articleMatch[2] || '').replace(/^[º°]\s*/, '').trim();
        currentArticle = {
          numero: numeroNormalizado,
          estruturaId: currentStructureId,
          bodyLines: initialRemainder ? [initialRemainder] : []
        };
        continue;
      }

      if (currentArticle) {
        currentArticle.bodyLines.push(line);
      }
    }
  }

  flushArticle();

  const nested = buildNestedStructure(structures, rootId);

  const rootTree = nested[0];
  let estruturaFinal = nested;

  if (rootTree && rootTree.id === rootId) {
    if (rootTree.artigos.length === 0 && rootTree.subestruturas.length > 0) {
      estruturaFinal = rootTree.subestruturas;
    } else if (rootTree.artigos.length > 0 || rootTree.subestruturas.length > 0) {
      estruturaFinal = [rootTree];
    }
  }

  const result = {
    id: metadata.id,
    nome: metadata.nome,
    descricao: metadata.descricao,
    fundamentacao: metadata.fundamentacao,
    estrutura: estruturaFinal.map(stripInternalIds)
  };

  return {
    json: result,
    stats: {
      estruturas: countStructures(result.estrutura),
      artigos: countArticles(result.estrutura),
      linhasProcessadas: lines.length,
      artigosDetectados: articleCounter
    }
  };
}

function countStructures(nodes) {
  return nodes.reduce((acc, node) => acc + 1 + countStructures(node.subestruturas || []), 0);
}

function countArticles(nodes) {
  return nodes.reduce((acc, node) => {
    const local = Array.isArray(node.artigos) ? node.artigos.length : 0;
    return acc + local + countArticles(node.subestruturas || []);
  }, 0);
}

function buildNestedStructure(flatNodes, rootId) {
  const childrenByParent = new Map();

  for (const node of flatNodes) {
    const parentKey = node.parentId || '__root__';
    if (!childrenByParent.has(parentKey)) {
      childrenByParent.set(parentKey, []);
    }
    childrenByParent.get(parentKey).push(node);
  }

  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.ordem - b.ordem);
  }

  function toTree(node) {
    const children = childrenByParent.get(node.id) || [];
    return {
      id: node.id,
      tipo: node.tipo,
      numero: node.numero,
      titulo: node.titulo,
      artigos: node.artigos,
      subestruturas: children.map(toTree)
    };
  }

  const roots = childrenByParent.get('__root__') || [];
  const explicitRoot = roots.find((n) => n.id === rootId);

  if (explicitRoot) {
    return [toTree(explicitRoot)];
  }

  return roots.map(toTree);
}

function stripInternalIds(node) {
  return {
    tipo: node.tipo,
    numero: node.numero,
    titulo: node.titulo,
    artigos: (node.artigos || []).map((art) => ({
      numero: art.numero,
      epigrafe: art.epigrafe,
      conteudo: art.conteudo,
      paragrafos: art.paragrafos
    })),
    subestruturas: (node.subestruturas || []).map(stripInternalIds)
  };
}

function mergeEstruturas(nodes) {
  const merged = [];
  const byKey = new Map();

  function romanToInt(input) {
    const roman = String(input || '').toUpperCase();
    if (!/^[IVXLCDM]+$/.test(roman)) return null;
    const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let total = 0;
    let prev = 0;
    for (let i = roman.length - 1; i >= 0; i -= 1) {
      const value = map[roman[i]] || 0;
      if (value < prev) total -= value;
      else total += value;
      prev = value;
    }
    return total || null;
  }

  function normalizeNumeroKey(numero) {
    const raw = String(numero || '').trim().toUpperCase();
    if (!raw) return '';
    if (/^\d+$/.test(raw)) return `N${Number(raw)}`;
    const romanValue = romanToInt(raw);
    if (romanValue !== null) return `N${romanValue}`;
    return raw;
  }

  function keyOf(node) {
    return `${String(node.tipo || '').toUpperCase()}::${normalizeNumeroKey(node.numero)}`;
  }

  function cloneNode(node) {
    return {
      tipo: node.tipo,
      numero: node.numero,
      titulo: node.titulo || '',
      artigos: Array.isArray(node.artigos) ? [...node.artigos] : [],
      subestruturas: mergeEstruturas(node.subestruturas || [])
    };
  }

  function mergeInto(target, source) {
    if (!target.titulo && source.titulo) {
      target.titulo = source.titulo;
    }

    if (Array.isArray(source.artigos) && source.artigos.length > 0) {
      target.artigos.push(...source.artigos);
    }

    target.subestruturas = mergeEstruturas([...(target.subestruturas || []), ...(source.subestruturas || [])]);
  }

  for (const node of nodes || []) {
    const normalized = cloneNode(node);
    const key = keyOf(normalized);

    if (!normalized.numero) {
      merged.push(normalized);
      continue;
    }

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, normalized);
      merged.push(normalized);
      continue;
    }

    mergeInto(existing, normalized);
  }

  return merged.filter((node) => {
    const temTitulo = Boolean(String(node.titulo || '').trim());
    const temArtigos = Array.isArray(node.artigos) && node.artigos.length > 0;
    const temSub = Array.isArray(node.subestruturas) && node.subestruturas.length > 0;
    return temTitulo || temArtigos || temSub;
  });
}

function main() {
  try {
    const args = parseArgs(process.argv);

    if (args.help) {
      printHelp();
      process.exit(0);
    }

    assertArg(args.input, 'Informe --input com o caminho do arquivo.');
    assertArg(['auto', 'always', 'never'].includes(args.ocr), '--ocr deve ser auto, always ou never.');
    assertArg([1, 2].includes(args.columns), '--columns deve ser 1 ou 2.');

    const inputPath = path.resolve(process.cwd(), args.input);
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Arquivo de entrada nao encontrado: ${inputPath}`);
    }

    const nome = args.nome || path.parse(inputPath).name.replace(/[_-]+/g, ' ');
    const id = args.id || slugify(nome);
    const outputPath = path.resolve(
      process.cwd(),
      args.output || path.join('dados', `${slugify(nome)}.json`)
    );

    console.log(`Extraindo texto de: ${inputPath}`);
    const text = extractText(inputPath, args);

    if (args.rawTextOutput) {
      const rawPath = path.resolve(process.cwd(), args.rawTextOutput);
      fs.mkdirSync(path.dirname(rawPath), { recursive: true });
      fs.writeFileSync(rawPath, text, 'utf8');
      console.log(`Texto bruto salvo em: ${rawPath}`);
    }

    const { json, stats } = parseLegislation(text, {
      id,
      nome,
      descricao: args.descricao || '',
      fundamentacao: args.fundamentacao || ''
    });

    json.estrutura = mergeEstruturas(json.estrutura || []);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');

    console.log(`JSON salvo em: ${outputPath}`);
    console.log(`Estruturas: ${stats.estruturas} | Artigos: ${stats.artigos} | Linhas: ${stats.linhasProcessadas}`);

    if (stats.artigos === 0) {
      console.warn('Aviso: nenhum artigo detectado automaticamente. Revise o texto extraido.');
    }
  } catch (err) {
    console.error(`Erro: ${err.message}`);
    process.exit(1);
  }
}

main();
