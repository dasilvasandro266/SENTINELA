import { authenticatedFetch, getUser, isAdminUser } from "./authManager.js";
import * as pdfjsLib from "/vendor/pdfjs/pdf.min.mjs";

const API_URL = "/api";

let jurisprudenciaContainer = null;
let searchInput = null;
let loadingAnimation = null;
let todasJurisprudencias = [];
let importadorJurisprudencia = null;
let userIsAdmin = false;

function getJurisprudenciaContainer() {
  return document.querySelector(".jurisprudencia-container, .jurisprudência-container");
}

function getSearchInput() {
  return document.getElementById("search-bar") || document.getElementById("searchInput");
}

// Editor/importador
let jpTextoFonte = null;
let jpUploadArquivo = null;
let jpBtnConverterTexto = null;
let jpEstadoUpload = null;
let jpHtmlSaida = null;
let jpPreviewHtml = null;
let jpBtnCopiarHtml = null;
let jpBtnAplicarClasses = null;
let jpCampoTribunal = null;
let jpCampoAno = null;
let jpCampoId = null;
let jpCampoNome = null;
let jpCampoReferencias = null;
let jpBtnSalvar = null;
let jpBtnCopiarPayload = null;
let jpEstadoSalvar = null;
let jurisprudenciaModal = null;
let jurisprudenciaModalTitulo = null;
let jurisprudenciaModalMeta = null;
let jurisprudenciaModalReferencia = null;
let jurisprudenciaModalTexto = null;
let fecharJurisprudenciaModalBtn = null;

const CLASS_MAP = {
  h1: "sc-titulo",
  h2: "sc-titulo",
  h3: "sc-titulo",
  h4: "sc-titulo",
  p: "sc-paragrafo",
  ul: "sc-lista",
  ol: "sc-lista",
  li: "sc-item",
  blockquote: "sc-citacao",
  code: "sc-codigo",
  pre: "sc-pre",
};

const DATE_REGEX = /\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}\s+de\s+(janeiro|fevereiro|marco|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+\d{4})\b/gi;
const CITACAO_REGEX = /("([^"\n]{3,}?)"|“([^”\n]{3,}?)”|«([^»\n]{3,}?)»)/g;
const REF_TOKEN_REGEX = /\b(DOI:\s*[^\s]+|ISBN(?:-1[03])?:\s*[\d\-Xx]+|dispon[ií]vel em:|acesso em:|et al\.|v\.\s*\d+|n\.\s*\d+|ed\.\s*\d+|pp?\.\s*\d+(?:-\d+)?)\b/gi;
const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;

function setEstado(msg) {
  if (jpEstadoUpload) jpEstadoUpload.textContent = msg || "";
}

function setEstadoSalvar(msg) {
  if (jpEstadoSalvar) jpEstadoSalvar.textContent = msg || "";
}

function escapeHtml(texto = "") {
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeTrustedHtml(html = "") {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  doc.querySelectorAll("script, style, iframe, object, embed, link, meta, base").forEach((el) => el.remove());

  doc.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = String(attr.value || "").trim().toLowerCase();
      if (name.startsWith("on") || value.startsWith("javascript:") || value.startsWith("data:text/html")) {
        el.removeAttribute(attr.name);
      }
    });
  });

  return doc.body.firstElementChild?.innerHTML || "";
}

function nodeInsideTag(node, tags = []) {
  let current = node.parentElement;
  while (current) {
    if (tags.includes(current.tagName)) return true;
    current = current.parentElement;
  }
  return false;
}

function highlightRegexInTextNodes(root, regex, className) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];

  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }

  for (const textNode of nodes) {
    if (!textNode.nodeValue || !textNode.nodeValue.trim()) continue;
    if (nodeInsideTag(textNode, ["SCRIPT", "STYLE", "CODE", "PRE", "A"])) continue;

    const text = textNode.nodeValue;
    regex.lastIndex = 0;
    let match;
    let lastIndex = 0;
    const frag = document.createDocumentFragment();
    let encontrou = false;

    while ((match = regex.exec(text)) !== null) {
      encontrou = true;
      const inicio = match.index;
      const fim = inicio + match[0].length;

      if (inicio > lastIndex) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex, inicio)));
      }

      const span = document.createElement("span");
      span.className = className;
      span.textContent = match[0];
      frag.appendChild(span);

      lastIndex = fim;
    }

    if (!encontrou) continue;

    if (lastIndex < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    textNode.parentNode.replaceChild(frag, textNode);
  }
}

function destacarReferenciasBibliograficas(root) {
  const regexReferenciaLinha = /(dispon[ií]vel em|acesso em|doi:|isbn|et al\.|in:|revista|editora|vol\.|v\.\s*\d+|n\.\s*\d+)/i;
  const regexAutorAno = /^[A-ZÁÉÍÓÚÇ][A-ZÁÉÍÓÚÇ\-\s]+,\s+.+\b\d{4}\b/;

  root.querySelectorAll("p, li").forEach((el) => {
    const txt = (el.textContent || "").trim();
    if (!txt) return;

    if (regexReferenciaLinha.test(txt) || regexAutorAno.test(txt)) {
      el.classList.add("referencia");
      el.classList.add("sc-destaque-referencia-linha");
    }
  });
}

function aplicarRealceSemantico(root) {
  root.querySelectorAll("blockquote").forEach((el) => {
    el.classList.add("citacao-intensa");
  });

  highlightRegexInTextNodes(root, CITACAO_REGEX, "sc-destaque-citacao");
  highlightRegexInTextNodes(root, DATE_REGEX, "sc-destaque-data");
  highlightRegexInTextNodes(root, REF_TOKEN_REGEX, "sc-destaque-referencia");
  destacarReferenciasBibliograficas(root);
}

function finalizeHtml(htmlRaw) {
  const doc = new DOMParser().parseFromString(`<div>${htmlRaw}</div>`, "text/html");

  doc.querySelectorAll("script, style").forEach((el) => el.remove());

  Object.entries(CLASS_MAP).forEach(([tag, className]) => {
    doc.querySelectorAll(tag).forEach((el) => {
      el.classList.add(className);
    });
  });

  doc.querySelectorAll("p").forEach((p) => {
    if (!p.textContent.trim() && !p.querySelector("img,br")) {
      p.remove();
    }
  });

  aplicarRealceSemantico(doc.body);

  return doc.body.innerHTML.trim();
}

function atualizarSaida(html) {
  if (jpHtmlSaida) jpHtmlSaida.value = html;
  if (jpPreviewHtml) jpPreviewHtml.innerHTML = html;
}

function normalizeStructuredText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeCompareText(text) {
  return normalizeStructuredText(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isStandalonePageNumberLine(text) {
  return /^\d{1,4}$/.test(String(text || "").trim());
}

function isTopBannerLine(line) {
  const text = String(line.text || "").trim();
  if (!text) return false;
  if (line.page !== 1 && !line.centered) return false;
  if (line.topRatio < 0.72) return false;

  const normalized = normalizeCompareText(text);
  const stripped = normalized.replace(/[0-9]+/g, "").replace(/\s+/g, " ").trim();
  if (!stripped) return false;
  if (text.includes(":")) return false;
  if (text.length > 90) return false;
  if (isStandalonePageNumberLine(text)) return false;

  return stripped === normalized
    || /^(república de angola|tribunal supremo|[0-9a-zºª]+\s+sec[cç][aã]o|[0-9a-zºª]+\s+c[âa]mara)/i.test(normalized)
    || (text === text.toUpperCase() && /[A-ZÀ-Ü]/.test(text) && !/[a-zà-ü]/.test(text));
}

function isFooterLine(line) {
  const text = String(line.text || "").trim();
  if (!text) return false;
  if (isStandalonePageNumberLine(text)) return true;
  if (line.bottomRatio < 0.82) return false;

  const normalized = normalizeCompareText(text);
  if (!normalized) return false;

  return /^(rua\s+\d+|pal[aá]cio|cidade alta|luanda angola|luanda)$/.test(normalized)
    || normalized.includes("rua 17 de setembro")
    || normalized.includes("pinheiro furtado")
    || normalized.includes("cidade alta")
    || normalized.includes("luanda angola")
    || normalized.length <= 14;
}

function isLabelLine(text) {
  return /^([A-ZÁÉÍÓÚÇ][^:]{1,60}):\s+/.test(String(text || "").trim());
}

function isRomanHeadingLine(text) {
  return /^(?:(?:[IVXLCDM]+)\.?\s+)?[A-ZÁÉÍÓÚÇ0-9][A-ZÁÉÍÓÚÇ0-9\sÁÉÍÓÚÇÀ-ÿ'’\-.,()]{2,}$/u.test(String(text || "").trim())
    && !/[a-zà-ü]/.test(String(text || ""))
    && String(text || "").trim().length <= 90;
}

function isPdfHeadingLine(line) {
  const text = String(line.text || "").trim();
  if (!text) return false;

  const normalized = normalizeCompareText(text);
  if (!normalized) return false;

  if (normalized === "texto integral") return true;
  if (normalized === "acordao" || normalized === "acórdão") return true;
  if (/^(i{1,3}|iv|v|vi|vii|viii|ix|x)\.\s+/i.test(text)) return true;
  if (isRomanHeadingLine(text)) return true;
  if (line.centered && text.length <= 80 && text === text.toUpperCase()) return true;

  return false;
}

function isPdfMetaLine(text) {
  return /^(proc\.?\s*n[.º°o]?\s*|ju[ií]zo de origem|relator|data do ac[óo]rd[ãa]o|vota[cç][aã]o|meio processual|decis[aã]o|resumo do ac[óo]rd[ãa]o|texto integral)\s*[:\-]?/i.test(String(text || "").trim())
    || isLabelLine(text);
}

function renderInlineStrongLabel(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/^(.{2,60}?):\s*(.+)$/);
  if (!match) return `<p>${escapeHtml(raw)}</p>`;
  const label = match[1].trim();
  const value = match[2].trim();
  return `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`;
}

function renderParagraphBuffer(lines) {
  const text = lines.map((line) => String(line || "").trim()).filter(Boolean).join(" ").replace(/\s{2,}/g, " ").trim();
  if (!text) return "";

  if (/^[“"«].+[”"»]$/.test(text)) {
    return `<blockquote>${escapeHtml(text)}</blockquote>`;
  }

  if (isLabelLine(text) || isPdfMetaLine(text)) {
    return renderInlineStrongLabel(text);
  }

  return `<p>${escapeHtml(text)}</p>`;
}

function renderStructuredLines(lines) {
  const out = [];
  let paragraphBuffer = [];
  let headerGroup = [];

  const flushParagraph = () => {
    const html = renderParagraphBuffer(paragraphBuffer);
    if (html) out.push(html);
    paragraphBuffer = [];
  };

  const flushHeaderGroup = () => {
    if (!headerGroup.length) return;
    out.push(`<div class="juris-cabecalho">${headerGroup.map((line) => `<p>${escapeHtml(line.text)}</p>`).join("")}</div>`);
    headerGroup = [];
  };

  const pushHeading = (line) => {
    const text = String(line.text || "").trim();
    const normalized = normalizeCompareText(text);
    let level = 2;
    if (normalized === "acordao" || normalized === "acórdão") level = 1;
    else if (normalized === "texto integral") level = 2;
    else if (/^(i{1,3}|iv|v|vi|vii|viii|ix|x)\.\s+/i.test(text)) level = 2;
    else if (text.length > 45) level = 3;
    out.push(`<h${level}>${escapeHtml(text)}</h${level}>`);
  };

  for (const line of lines) {
    if (!line || !String(line.text || "").trim()) {
      flushParagraph();
      flushHeaderGroup();
      continue;
    }

    if (line.kind === "skip") {
      continue;
    }

    if (line.kind === "header") {
      flushParagraph();
      headerGroup.push(line);
      continue;
    }

    flushHeaderGroup();

    if (line.kind === "heading") {
      flushParagraph();
      pushHeading(line);
      continue;
    }

    paragraphBuffer.push(line.text);
  }

  flushParagraph();
  flushHeaderGroup();
  return out.join("\n");
}

function textoParaHtmlBasico(texto) {
  const lines = normalizeStructuredText(texto)
    .split("\n")
    .map((line) => ({ text: line.trim(), kind: null }));
  for (const line of lines) {
    const text = String(line.text || "").trim();
    if (!text) continue;
    if (text.startsWith("#")) {
      const headingMatch = text.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        line.kind = "heading";
        line.text = headingMatch[2];
        continue;
      }
    }
    if (isPdfHeadingLine(line)) {
      line.kind = "heading";
    }
  }
  return renderStructuredLines(lines);
}

async function converterDocx(file) {
  if (!window.mammoth) {
    throw new Error("Biblioteca Mammoth não carregada.");
  }
  const arrayBuffer = await file.arrayBuffer();
  const styleMap = [
    "p[style-name='Title'] => h1:fresh",
    "p[style-name='Heading 1'] => h1:fresh",
    "p[style-name='Heading1'] => h1:fresh",
    "p[style-name='Heading 2'] => h2:fresh",
    "p[style-name='Heading2'] => h2:fresh",
    "p[style-name='Heading 3'] => h3:fresh",
    "p[style-name='Heading3'] => h3:fresh",
    "p[style-name='Heading 4'] => h4:fresh",
    "p[style-name='Heading4'] => h4:fresh",
    "p[style-name='Intense Quote'] => blockquote.citacao-intensa:fresh",
    "p[style-name='Citação intensa'] => blockquote.citacao-intensa:fresh",
    "p[style-name='Intense Reference'] => p.docx-referencia-intensa:fresh",
    "p[style-name='Referência Intensa'] => p.docx-referencia-intensa:fresh",
    "r[style-name='Subtle Reference'] => span.referencia-sutil",
    "r[style-name='Referência Sutil'] => span.referencia-sutil",
    "r[style-name='Intense Reference'] => span.referencia-intensa",
    "r[style-name='Referência Intensa'] => span.referencia-intensa",
    "r[style-name='Intense Emphasis'] => span.enfase-intenso",
    "r[style-name='Ênfase intensa'] => span.enfase-intenso",
  ];
  const result = await window.mammoth.convertToHtml({ arrayBuffer, styleMap });
  return result.value || "";
}

function encontrarPrimeiroPorLocalName(root, localName) {
  const nodes = root.getElementsByTagName("*");
  for (const node of nodes) {
    if (node.localName === localName) return node;
  }
  return null;
}

function textoNodoOdt(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue || "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (child.localName === "line-break") {
        out += "\n";
      } else if (child.localName === "tab") {
        out += "\t";
      } else {
        out += textoNodoOdt(child);
      }
    }
  }
  return out;
}

function renderListOdt(listNode) {
  const itens = [];
  for (const child of listNode.children) {
    if (child.localName !== "list-item") continue;

    let itemTexto = "";
    let nested = "";
    for (const itemNode of child.children) {
      if (itemNode.localName === "p") {
        itemTexto += textoNodoOdt(itemNode).trim();
      }
      if (itemNode.localName === "list") {
        nested += renderListOdt(itemNode);
      }
    }

    itens.push(`<li>${escapeHtml(itemTexto)}${nested}</li>`);
  }
  return itens.length ? `<ul>${itens.join("")}</ul>` : "";
}

function converterXmlOdtParaHtml(xmlStr) {
  const xmlDoc = new DOMParser().parseFromString(xmlStr, "application/xml");
  const officeText = encontrarPrimeiroPorLocalName(xmlDoc, "text");
  if (!officeText) return "";

  const out = [];

  function walk(node) {
    for (const child of node.children) {
      if (child.localName === "h") {
        const levelRaw = Number(child.getAttribute("text:outline-level") || 2);
        const level = Math.max(1, Math.min(4, levelRaw));
        out.push(`<h${level}>${escapeHtml(textoNodoOdt(child).trim())}</h${level}>`);
        continue;
      }

      if (child.localName === "p") {
        const texto = textoNodoOdt(child).trim();
        if (texto) out.push(`<p>${escapeHtml(texto)}</p>`);
        continue;
      }

      if (child.localName === "list") {
        out.push(renderListOdt(child));
        continue;
      }

      walk(child);
    }
  }

  walk(officeText);
  return out.join("\n");
}

async function converterOdt(file) {
  if (!window.JSZip) {
    throw new Error("Biblioteca JSZip não carregada.");
  }
  const arrayBuffer = await file.arrayBuffer();
  const zip = await window.JSZip.loadAsync(arrayBuffer);
  const contentFile = zip.file("content.xml");
  if (!contentFile) {
    throw new Error("Arquivo ODT inválido: content.xml não encontrado.");
  }
  const xmlStr = await contentFile.async("string");
  return converterXmlOdtParaHtml(xmlStr);
}

function configurarPdfJs() {
  if (!pdfjsLib) {
    throw new Error("Biblioteca PDF.js não carregada.");
  }

  if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
  }
}

function montarTextoPaginaPdf(items) {
  const linhas = [];
  let linhaAtual = [];
  let yAtual = null;

  for (const item of items) {
    const texto = String(item.str || "").trim();
    if (!texto) continue;

    const y = Math.round(Number(item.transform?.[5] || 0));
    if (yAtual !== null && Math.abs(y - yAtual) > 3) {
      if (linhaAtual.length) linhas.push(linhaAtual.join(" "));
      linhaAtual = [];
    }

    linhaAtual.push(texto);
    yAtual = y;
  }

  if (linhaAtual.length) linhas.push(linhaAtual.join(" "));
  return linhas.join("\n");
}

async function converterPdf(file) {
  configurarPdfJs();

  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error("PDF demasiado grande. Use um arquivo até 25 MB.");
  }

  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    disableFontFace: true,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const paginas = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: false,
    });
    const linhas = montarLinhasPdf(content.items || [], viewport.height, pageNum, viewport.width);
    if (linhas.length) {
      paginas.push({ pageNum, linhas, pageWidth: viewport.width });
    }
  }

  if (!paginas.length) {
    throw new Error("Não foi possível extrair texto do PDF. Se for imagem digitalizada, aplique OCR e tente novamente.");
  }

  const html = converterPdfLinhasParaHtml(paginas);
  if (!html.trim()) {
    throw new Error("Não foi possível reconstruir a estrutura do PDF. Tente outro formato ou um PDF com texto pesquisável.");
  }

  return html;
}

function montarLinhasPdf(items, pageHeight, pageNum, pageWidth = 0) {
  const tokens = [];

  for (const item of items) {
    const text = String(item.str || "").replace(/\s+/g, " ").trim();
    if (!text) continue;

    const transform = item.transform || [];
    const x = Number(transform[4] || 0);
    const y = Number(transform[5] || 0);
    const fontSize = Math.hypot(Number(transform[0] || 0), Number(transform[1] || 0)) || Math.abs(Number(transform[3] || 0)) || 0;
    tokens.push({
      text,
      x,
      y,
      pageNum,
      pageHeight,
      fontSize,
      width: Number(item.width || 0),
      hasEOL: item.hasEOL === true,
    });
  }

  tokens.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines = [];
  let current = null;
  const toleranceBase = 3.2;

  const finalize = () => {
    if (!current || !current.tokens.length) {
      current = null;
      return;
    }

    current.tokens.sort((a, b) => a.x - b.x);
    let text = "";
    let prev = null;
    for (const token of current.tokens) {
      if (!text) {
        text = token.text;
      } else {
        const gap = prev ? token.x - (prev.x + prev.width) : 0;
        if (gap > Math.max(1.5, (prev?.fontSize || current.fontSize || 10) * 0.25)) {
          text += " ";
        } else if (!/\s$/.test(text)) {
          text += " ";
        }
        text += token.text;
      }
      prev = token;
    }

    const avgFontSize = current.tokens.reduce((sum, token) => sum + (token.fontSize || 0), 0) / current.tokens.length || 0;
    const xMin = Math.min(...current.tokens.map((token) => token.x));
    const xMax = Math.max(...current.tokens.map((token) => token.x + token.width));
    const normalized = normalizeCompareText(text);
    lines.push({
      text: text.replace(/\s{2,}/g, " ").trim(),
      normalized,
      xMin,
      xMax,
      pageNum: current.pageNum,
      pageHeight: current.pageHeight,
      topRatio: current.pageHeight ? current.y / current.pageHeight : 0,
      bottomRatio: current.pageHeight ? 1 - (current.y / current.pageHeight) : 0,
      centered: pageWidth ? xMin > pageWidth * 0.16 && xMax < pageWidth * 0.84 && text.length < 90 : false,
      fontSize: avgFontSize,
    });
    current = null;
  };

  for (const token of tokens) {
    if (!current) {
      current = {
        tokens: [token],
        y: token.y,
        pageNum: token.pageNum,
        pageHeight: token.pageHeight,
        pageWidth,
        fontSize: token.fontSize || 0,
      };
      continue;
    }

    const sameLine = Math.abs(token.y - current.y) <= Math.max(toleranceBase, Math.min(current.fontSize || token.fontSize || 10, token.fontSize || current.fontSize || 10) * 0.55);
    if (!sameLine) {
      finalize();
      current = {
        tokens: [token],
        y: token.y,
        pageNum: token.pageNum,
        pageHeight: token.pageHeight,
        pageWidth,
        fontSize: token.fontSize || 0,
      };
      continue;
    }

    current.tokens.push(token);
    current.y = (current.y * (current.tokens.length - 1) + token.y) / current.tokens.length;
    current.fontSize = Math.max(current.fontSize || 0, token.fontSize || 0);
    if (token.hasEOL) {
      finalize();
    }
  }

  finalize();
  return lines;
}

function converterPdfLinhasParaHtml(paginas) {
  const todos = [];
  for (const pagina of paginas) {
    todos.push(...pagina.linhas);
  }

  const frequencias = new Map();
  const vistosPorPagina = new Map();
  for (const linha of todos) {
    const chave = linha.normalized || normalizeCompareText(linha.text);
    if (!chave) continue;
    if (!vistosPorPagina.has(linha.pageNum)) vistosPorPagina.set(linha.pageNum, new Set());
    const vistos = vistosPorPagina.get(linha.pageNum);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    frequencias.set(chave, (frequencias.get(chave) || 0) + 1);
  }

  const paginaCount = paginas.length;
  const linhasClassificadas = todos.map((linha) => {
    const chave = linha.normalized || normalizeCompareText(linha.text);
    const repetida = chave && (frequencias.get(chave) || 0) >= Math.max(2, Math.ceil(paginaCount / 2));
    const texto = String(linha.text || "").trim();

    if (!texto) {
      return { ...linha, kind: "skip" };
    }

    if (isStandalonePageNumberLine(texto) || isFooterLine(linha)) {
      return { ...linha, kind: "skip" };
    }

    if (isTopBannerLine(linha)) {
      return { ...linha, kind: "header" };
    }

    if (repetida && (linha.topRatio > 0.82 || linha.bottomRatio > 0.82) && texto.length < 120) {
      return { ...linha, kind: "skip" };
    }

    if (isPdfHeadingLine(linha)) {
      return { ...linha, kind: "heading" };
    }

    return { ...linha, kind: "body" };
  });

  const comQuebrasDePagina = [];
  let ultimaPagina = null;
  for (const linha of linhasClassificadas) {
    if (ultimaPagina !== null && linha.pageNum !== ultimaPagina) {
      comQuebrasDePagina.push({ text: "", kind: "separator" });
    }
    comQuebrasDePagina.push(linha);
    ultimaPagina = linha.pageNum;
  }

  return renderStructuredLines(comQuebrasDePagina);
}

async function processarUpload(file) {
  if (!file) return;

  const nome = file.name.toLowerCase();
  setEstado(`A processar: ${file.name}...`);

  try {
    let htmlRaw = "";
    if (nome.endsWith(".txt")) {
      const text = await file.text();
      htmlRaw = textoParaHtmlBasico(text);
    } else if (nome.endsWith(".html") || nome.endsWith(".htm")) {
      const text = await file.text();
      htmlRaw = text;
    } else if (nome.endsWith(".pdf") || file.type === "application/pdf") {
      htmlRaw = await converterPdf(file);
    } else if (nome.endsWith(".docx")) {
      htmlRaw = await converterDocx(file);
    } else if (nome.endsWith(".odt")) {
      htmlRaw = await converterOdt(file);
    } else if (nome.endsWith(".doc")) {
      throw new Error("Formato .doc não suportado diretamente. Abra no Writer/Word e salve como .docx ou .odt.");
    } else {
      throw new Error("Formato não suportado. Use .pdf, .docx, .odt, .txt ou .html.");
    }

    const htmlFinal = finalizeHtml(htmlRaw);
    atualizarSaida(htmlFinal);
    setEstado("Conversão concluída.");
  } catch (error) {
    console.error(error);
    setEstado(`Erro: ${error.message}`);
  }
}

function converterTextoManual() {
  const texto = jpTextoFonte?.value || "";
  const htmlFinal = finalizeHtml(textoParaHtmlBasico(texto));
  atualizarSaida(htmlFinal);
  setEstado("Texto convertido para HTML com classes.");
}

async function copiarHtml() {
  const valor = jpHtmlSaida?.value || "";
  if (!valor.trim()) {
    setEstado("Não há HTML para copiar.");
    return;
  }
  await navigator.clipboard.writeText(valor);
  setEstado("HTML copiado para a área de transferência.");
}

function reaplicarClasses() {
  const valor = jpHtmlSaida?.value || "";
  if (!valor.trim()) return;
  atualizarSaida(finalizeHtml(valor));
  setEstado("Classes reaplicadas.");
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

function montarPayload() {
  const tribunal = String(jpCampoTribunal?.value || "").trim();
  const anoRaw = String(jpCampoAno?.value || "").trim();
  const ano = anoRaw ? Number.parseInt(anoRaw, 10) : null;
  const nome = String(jpCampoNome?.value || "").trim();
  const referencias = String(jpCampoReferencias?.value || "").trim();
  const idInformado = String(jpCampoId?.value || "").trim();
  const baseId = slugify(`${tribunal}-${ano || ""}-${nome}`) || slugify(nome) || "juris";
  const id = idInformado || `${baseId}-${Date.now()}`;

  return {
    id,
    tribunal,
    ano,
    nome,
    referencias,
    conteudoHtml: jpHtmlSaida?.value || "",
  };
}

async function copiarPayloadJson() {
  const payload = montarPayload();
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  setEstadoSalvar("Payload JSON copiado.");
}

async function salvarJurisprudencia() {
  const payload = montarPayload();
  const idInformado = String(jpCampoId?.value || "").trim();

  if (!payload.tribunal || !payload.ano || !payload.nome) {
    setEstadoSalvar("Preencha tribunal, ano e título.");
    return;
  }
  if (!payload.conteudoHtml.trim()) {
    setEstadoSalvar("Converta ou escreva conteúdo antes de guardar.");
    return;
  }

  try {
    setEstadoSalvar("A guardar...");
    const isUpdate = Boolean(idInformado);
    const url = isUpdate
      ? `${API_URL}/jurisprudencias/${encodeURIComponent(payload.id)}`
      : `${API_URL}/jurisprudencias`;
    let response = await authenticatedFetch(url, {
      method: isUpdate ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });

    if (isUpdate && response.status === 404) {
      response = await authenticatedFetch(`${API_URL}/jurisprudencias`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }

    if (!response.ok) {
      const erro = await response.text();
      throw new Error(`Falha ao guardar: ${response.status} ${erro}`);
    }

    setEstadoSalvar("Jurisprudência guardada com sucesso.");
    await carregarJurisprudencias();
  } catch (error) {
    console.error(error);
    setEstadoSalvar(error.message || "Erro ao guardar jurisprudência.");
  }
}

function toggleLoading(show) {
  if (loadingAnimation) {
    if (show) {
      loadingAnimation.style.display = "flex";
      document.body.classList.add("no-content");
    } else {
      loadingAnimation.style.display = "none";
      document.body.classList.remove("no-content");
    }
  }
}

function toggleContent(show) {
  if (jurisprudenciaContainer) {
    jurisprudenciaContainer.style.display = show ? "grid" : "none";
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), ms);
  };
}

async function carregarJurisprudencias() {
  try {
    const response = await authenticatedFetch(`${API_URL}/jurisprudencias`);

    if (!response.ok) {
      throw new Error(`Erro HTTP: ${response.status}`);
    }

    const lista = await response.json();
    todasJurisprudencias = Array.isArray(lista) ? lista : [];
    renderizarJurisprudencias(todasJurisprudencias);
  } catch (error) {
    console.error("❌ Erro ao carregar jurisprudência:", error);
    jurisprudenciaContainer.innerHTML = '<p class="empty">Erro ao carregar jurisprudência. Verifique o servidor local.</p>';
  } finally {
    toggleLoading(false);
    toggleContent(true);
  }
}

function renderizarJurisprudencias(lista, filtro = "") {
  const itemsToRemove = document.querySelectorAll(".jurisprudência-item, .empty");
  itemsToRemove.forEach((el) => el.remove());

  if (!lista || lista.length === 0) {
    jurisprudenciaContainer.innerHTML += '<p class="empty">Nenhuma jurisprudência disponível.</p>';
    return;
  }

  let itemsRenderizados = 0;

  lista.forEach(({ tribunal, ano, id, nome, referencias }) => {
    const searchableText = `${nome || ""} ${referencias || ""}`.toLowerCase();

    if (searchableText.includes(filtro.toLowerCase())) {
      const item = document.createElement("div");
      item.className = "jurisprudência-item";
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", "0");
      item.dataset.jurisId = id;
      item.dataset.tribunal = tribunal;
      item.dataset.ano = ano;

      item.innerHTML = `
         <h2>${escapeHtml(nome || `Jurisprudência ${id}`)}</h2>
         <div class="meta">${escapeHtml(tribunal || "")}${ano ? ` · ${escapeHtml(String(ano))}` : ""}</div>
         <p>${escapeHtml(referencias || "")}</p>
         ${userIsAdmin ? `<button type="button" class="btn-eliminar-jurisprudencia" data-juris-id="${id}" data-juris-nome="${String(nome || id).replace(/\"/g, '&quot;')}">Eliminar</button>` : ""}
      `;

      jurisprudenciaContainer.appendChild(item);
      itemsRenderizados++;
    }
  });

  if (userIsAdmin) {
    jurisprudenciaContainer.querySelectorAll(".btn-eliminar-jurisprudencia").forEach((btn) => {
      btn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const jurId = btn.getAttribute("data-juris-id");
        const jurNome = btn.getAttribute("data-juris-nome") || jurId;
        await eliminarJurisprudenciaPelaInterface(jurId, jurNome);
      });
    });
  }

  jurisprudenciaContainer.querySelectorAll(".jurisprudência-item").forEach((card) => {
    const abrir = async (event) => {
      const interactive = event.target.closest("button, input, textarea, select, a");
      if (interactive) return;
      await abrirJurisprudenciaModal({
        id: card.dataset.jurisId,
        tribunal: card.dataset.tribunal,
        ano: card.dataset.ano
      });
    };

    card.addEventListener("click", abrir);
    card.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      await abrir(event);
    });
  });

  if (itemsRenderizados === 0) {
    jurisprudenciaContainer.innerHTML += '<p class="empty">Nenhum resultado encontrado.</p>';
  }

  setupIntersectionObserver();
  enhanceHighlight();
}

async function salvarHistoricoJurisprudencia(data) {
  if (!data || !data.id) return;

  try {
    await authenticatedFetch(`${API_URL}/historico/jurisprudencias`, {
      method: "POST",
      body: JSON.stringify({
        jurisprudenciaId: data.id,
        tribunal: data.tribunal,
        ano: data.ano,
        titulo: data.nome || "Jurisprudência"
      })
    });
  } catch (error) {
    console.warn("Histórico de jurisprudência não registrado:", error);
  }
}

async function abrirJurisprudenciaModal({ tribunal, ano, id }) {
  if (!tribunal || !ano || !id || !jurisprudenciaModal) return;

  jurisprudenciaModalTitulo.textContent = "A carregar jurisprudência...";
  jurisprudenciaModalMeta.textContent = "";
  jurisprudenciaModalReferencia.textContent = "";
  jurisprudenciaModalReferencia.hidden = true;
  jurisprudenciaModalTexto.innerHTML = "<p>A carregar conteúdo...</p>";
  jurisprudenciaModal.classList.remove("hidden");
  jurisprudenciaModal.classList.add("show");
  jurisprudenciaModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("jurisprudencia-modal-open");

  try {
    const response = await authenticatedFetch(
      `${API_URL}/jurisprudencias/lookup?tribunal=${encodeURIComponent(tribunal)}&ano=${encodeURIComponent(ano)}&id=${encodeURIComponent(id)}`
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Erro HTTP ${response.status}`);
    }

    const data = await response.json();
    jurisprudenciaModalTitulo.textContent = data.nome || "Jurisprudência";
    jurisprudenciaModalMeta.textContent = [data.tribunal, data.ano].filter(Boolean).join(" · ");

    if (data.referencias) {
      jurisprudenciaModalReferencia.textContent = data.referencias;
      jurisprudenciaModalReferencia.hidden = false;
    }

    const conteudo = sanitizeTrustedHtml(data.conteudoHtml || data.conteudo_html || "");
    jurisprudenciaModalTexto.innerHTML = conteudo || "<p>Sem conteúdo disponível.</p>";
    await salvarHistoricoJurisprudencia(data);
  } catch (error) {
    console.error("Erro ao abrir jurisprudência:", error);
    jurisprudenciaModalTitulo.textContent = "Erro ao carregar jurisprudência";
    jurisprudenciaModalTexto.innerHTML = `<p>${escapeHtml(error.message || "Tente novamente.")}</p>`;
  }
}

function fecharJurisprudenciaModal() {
  if (!jurisprudenciaModal) return;
  jurisprudenciaModal.classList.remove("show");
  jurisprudenciaModal.classList.add("hidden");
  jurisprudenciaModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("jurisprudencia-modal-open");
}

async function eliminarJurisprudenciaPelaInterface(jurisId, jurNome) {
  if (!jurisId) return;
  const confirmado = window.confirm(`Eliminar a jurisprudência \"${jurNome}\"?\nEsta ação não pode ser desfeita.`);
  if (!confirmado) return;
  const reason = window.prompt("Fundamentação obrigatória para eliminar esta jurisprudência:");
  if (!reason || !reason.trim()) {
    setEstadoSalvar("Eliminação cancelada: informe uma fundamentação.");
    return;
  }

  try {
    const response = await authenticatedFetch(`${API_URL}/jurisprudencias/${encodeURIComponent(jurisId)}`, {
      method: "DELETE",
      body: JSON.stringify({ reason: reason.trim() })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Erro HTTP ${response.status}`);
    }
    setEstadoSalvar(`Jurisprudência eliminada: ${jurNome}`);
    await carregarJurisprudencias();
  } catch (error) {
    console.error("Erro ao eliminar jurisprudência:", error);
    setEstadoSalvar(`Falha ao eliminar: ${error.message}`);
  }
}

function persistSearch() {
  const KEY = "jp:search";
  const saved = sessionStorage.getItem(KEY);
  if (saved && !searchInput.value) searchInput.value = saved;
  searchInput.addEventListener("input", () => sessionStorage.setItem(KEY, searchInput.value || ""));
}

function setupQuickSearch() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/input|textarea/i.test(document.activeElement.tagName)) {
      if (searchInput) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    }
  });
}

function setupIntersectionObserver() {
  const items = document.querySelectorAll(".jurisprudência-item");
  if (!items.length) return;

  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) en.target.classList.add("is-visible");
    });
  }, { threshold: 0.08 });

  items.forEach((el) => io.observe(el));
}

function enhanceHighlight() {
  if (!searchInput || searchInput.dataset.hl === "1") return;
  searchInput.dataset.hl = "1";

  const stripTags = (el, key) => {
    if (!el.dataset[key]) el.dataset[key] = el.textContent;
    el.textContent = el.dataset[key];
  };

  const applyMark = (el, term) => {
    if (!term) return;
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      const rx = new RegExp("(" + safe + ")", "ig");
      el.innerHTML = el.textContent.replace(rx, '<mark class="hl">$1</mark>');
    } catch (_) {
      /* termo pode gerar regex inválida */
    }
  };

  const run = () => {
    const t = searchInput.value.trim();
    document.querySelectorAll(".jurisprudência-item").forEach((card) => {
      const h = card.querySelector("h2, h3");
      const p = card.querySelector("p");
      if (h) stripTags(h, "origTitle");
      if (p) stripTags(p, "origPara");
      if (t) {
        if (h) applyMark(h, t);
        if (p) applyMark(p, t);
      }
    });
  };

  searchInput.addEventListener("input", debounce(run, 80));
  run();
}

function cardClickThrough() {
  const container = getJurisprudenciaContainer();
  if (!container) return;
  container.addEventListener("click", (e) => {
    const card = e.target.closest(".jurisprudência-item");
    if (!card) return;
    const isInteractive = e.target.closest("a, button, input, textarea, select");
    if (isInteractive) return;
  });
}

function watchDynamicCards() {
  const container = getJurisprudenciaContainer();
  if (!container) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) en.target.classList.add("is-visible"); });
  }, { threshold: 0.08 });

  const arm = (node) => {
    if (node.classList && node.classList.contains("jurisprudência-item")) io.observe(node);
    node.querySelectorAll && node.querySelectorAll(".jurisprudência-item").forEach((n) => io.observe(n));
  };

  container.querySelectorAll(".jurisprudência-item").forEach(arm);

  const mo = new MutationObserver((muts) => {
    muts.forEach((m) => m.addedNodes.forEach(arm));
  });
  mo.observe(container, { childList: true, subtree: true });
}

async function init() {

  jurisprudenciaContainer = getJurisprudenciaContainer();
  searchInput = getSearchInput();
  loadingAnimation = document.getElementById("loadingAnimation");
  importadorJurisprudencia = document.getElementById("importadorJurisprudencia");

  jpTextoFonte = document.getElementById("jpTextoFonte");
  jpUploadArquivo = document.getElementById("jpUploadArquivo");
  jpBtnConverterTexto = document.getElementById("jpBtnConverterTexto");
  jpEstadoUpload = document.getElementById("jpEstadoUpload");
  jpHtmlSaida = document.getElementById("jpHtmlSaida");
  jpPreviewHtml = document.getElementById("jpPreviewHtml");
  jpBtnCopiarHtml = document.getElementById("jpBtnCopiarHtml");
  jpBtnAplicarClasses = document.getElementById("jpBtnAplicarClasses");
  jpCampoTribunal = document.getElementById("jpCampoTribunal");
  jpCampoAno = document.getElementById("jpCampoAno");
  jpCampoId = document.getElementById("jpCampoId");
  jpCampoNome = document.getElementById("jpCampoNome");
  jpCampoReferencias = document.getElementById("jpCampoReferencias");
  jpBtnSalvar = document.getElementById("jpBtnSalvar");
  jpBtnCopiarPayload = document.getElementById("jpBtnCopiarPayload");
  jpEstadoSalvar = document.getElementById("jpEstadoSalvar");
  jurisprudenciaModal = document.getElementById("jurisprudenciaModal");
  jurisprudenciaModalTitulo = document.getElementById("jurisprudenciaModalTitulo");
  jurisprudenciaModalMeta = document.getElementById("jurisprudenciaModalMeta");
  jurisprudenciaModalReferencia = document.getElementById("jurisprudenciaModalReferencia");
  jurisprudenciaModalTexto = document.getElementById("jurisprudenciaModalTexto");
  fecharJurisprudenciaModalBtn = document.getElementById("fecharJurisprudenciaModal");

  if (!jurisprudenciaContainer || !searchInput || !loadingAnimation) {
    console.error("⛔ Elementos essenciais não encontrados!");
    return;
  }

  toggleLoading(true);
  toggleContent(false);

  const user = await getUser();
  if (!user) {
    console.error("⛔ Usuário não autenticado. Redirecionando.");
    alert("Você precisa estar autenticado para acessar a jurisprudência.");
    window.location.href = "/index.html";
    return;
  }

  userIsAdmin = isAdminUser(user);
  if (importadorJurisprudencia) {
    importadorJurisprudencia.hidden = !userIsAdmin;
  }

  if (userIsAdmin) {
    if (jpUploadArquivo) {
      jpUploadArquivo.addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        await processarUpload(file);
      });
    }
    if (jpBtnConverterTexto) jpBtnConverterTexto.addEventListener("click", converterTextoManual);
    if (jpBtnCopiarHtml) jpBtnCopiarHtml.addEventListener("click", copiarHtml);
    if (jpBtnAplicarClasses) jpBtnAplicarClasses.addEventListener("click", reaplicarClasses);
    if (jpBtnSalvar) jpBtnSalvar.addEventListener("click", salvarJurisprudencia);
    if (jpBtnCopiarPayload) jpBtnCopiarPayload.addEventListener("click", copiarPayloadJson);
  }

  persistSearch();
  setupQuickSearch();
  cardClickThrough();
  watchDynamicCards();
  if (fecharJurisprudenciaModalBtn) {
    fecharJurisprudenciaModalBtn.addEventListener("click", fecharJurisprudenciaModal);
  }
  if (jurisprudenciaModal) {
    jurisprudenciaModal.addEventListener("click", (event) => {
      if (event.target === jurisprudenciaModal) fecharJurisprudenciaModal();
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && jurisprudenciaModal?.classList.contains("show")) {
      fecharJurisprudenciaModal();
    }
  });

  await carregarJurisprudencias();

  searchInput.addEventListener(
    "input",
    debounce((e) => {
      renderizarJurisprudencias(todasJurisprudencias, e.target.value);
    }, 150)
  );
}

init();
