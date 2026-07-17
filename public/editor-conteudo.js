import { getUser, authenticatedFetch, isAdminUser } from "./authManager.js";

const estadoUploadEl = document.getElementById("estadoUpload");
const textoFonteEl = document.getElementById("textoFonte");
const htmlSaidaEl = document.getElementById("htmlSaida");
const previewHtmlEl = document.getElementById("previewHtml");
const uploadArquivoEl = document.getElementById("uploadArquivo");
const btnConverterTextoEl = document.getElementById("btnConverterTexto");
const btnCopiarHtmlEl = document.getElementById("btnCopiarHtml");
const btnAplicarClassesEl = document.getElementById("btnAplicarClasses");
const btnInserirPageBreakEl = document.getElementById("btnInserirPageBreak");
const btnInserirRodapeEl = document.getElementById("btnInserirRodape");
// Elementos para conteúdo e salvar
const campoDisciplinaEl = document.getElementById("campoDisciplina");
const campoNomeEl = document.getElementById("campoNome");
const campoSubtemaEl = document.getElementById("campoSubtema");
const btnSalvarConteudoEl = document.getElementById("btnSalvarConteudo");
const btnCopiarPayloadEl = document.getElementById("btnCopiarPayload");
const estadoSalvarEl = document.getElementById("estadoSalvar");
const campoAutoresEl = document.getElementById("campoAutores");
const listaAutoresEl = document.getElementById("listaAutores");

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

function setEstado(msg) {
    estadoUploadEl.textContent = msg || "";
}

function setEstadoSalvar(msg) {
    estadoSalvarEl.textContent = msg || "";
}

function escapeHtml(texto = "") {
    return String(texto)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
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
    normalizeFootnotes(doc.body);

    return doc.body.innerHTML.trim();
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

function normalizeFootnotes(root) {
    const notas = Array.from(root.querySelectorAll(".rodape-nota"));
    if (!notas.length) return;

    notas.forEach((nota, index) => {
        const numero = index + 1;
        nota.dataset.footnoteNumber = String(numero);
        nota.classList.add("rodape-nota", "sc-paragrafo", "referencia", "sc-destaque-referencia-linha");
        const texto = (nota.textContent || "").trim();
        if (!texto.startsWith(`${numero}`)) {
            nota.textContent = `${numero}. ${texto.replace(/^\\d+\\s*/g, "")}`.trim();
        }
    });

    const refs = Array.from(root.querySelectorAll(".footnote-ref"));
    if (refs.length) {
        refs.forEach((ref, index) => {
            const numero = index + 1;
            ref.textContent = String(numero);
            ref.dataset.footnoteNumber = String(numero);
        });
    }

    removerTextoRodapeInline(
        root,
        notas
            .map((n) => (n.textContent || "").replace(/^\d+\.\s*/, "").trim())
            .filter(Boolean)
    );

    let refIndex = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const textNode of nodes) {
        if (refIndex >= notas.length) break;
        const parent = textNode.parentElement;
        if (!parent || parent.closest(".rodape-nota")) continue;
        const text = textNode.nodeValue || "";
        const regex = /(\\d{1,3})(?=[A-ZÁÉÍÓÚÇ])/;
        const match = regex.exec(text);
        if (!match) continue;

        const before = text.slice(0, match.index);
        const after = text.slice(match.index + match[0].length);
        const frag = document.createDocumentFragment();
        if (before) frag.appendChild(document.createTextNode(before));
        const sup = document.createElement("sup");
        sup.className = "footnote-ref";
        sup.textContent = String(refIndex + 1);
        frag.appendChild(sup);
        if (after) frag.appendChild(document.createTextNode(after));
        textNode.parentNode.replaceChild(frag, textNode);
        refIndex += 1;
    }
}

function removerTextoRodapeInline(root, notas) {
    if (!notas.length) return;
    const containers = Array.from(root.querySelectorAll("p, li, blockquote"));
    const normalizedNotes = notas.map((nota) => normalizeCompare(nota)).filter(Boolean);
    const notePatterns = notas.map((nota) => {
        const escaped = escapeRegex(nota);
        const flexible = escaped.replace(/\s+/g, "\\s+");
        return new RegExp(`(?:\\d{1,3}\\s*)?${flexible}`, "i");
    });
    const fuzzyPatterns = notas.map((nota) => buildFuzzyNoteRegex(nota)).filter(Boolean);

    containers.forEach((el) => {
        if (el.closest(".rodape-nota")) return;
        if (el.classList.contains("referencia") && !el.querySelector(".footnote-ref")) return;
        const text = el.textContent || "";
        const hasRef = !!el.querySelector(".footnote-ref");
        if (!hasRef && !/\d{1,3}[A-ZÁÉÍÓÚÇ]/.test(text)) return;

        if (el.tagName === "P") {
            const normalizedText = normalizeCompare(text);
            const looksLikeFootnote = /^\d{1,3}\s*[A-ZÁÉÍÓÚÇ]/.test(text);
            if (looksLikeFootnote && normalizedText) {
                const isOnlyFootnote = normalizedNotes.some((nota) => normalizedText === nota || normalizedText.endsWith(nota));
                if (isOnlyFootnote) {
                    el.remove();
                    return;
                }
            }
        }

        let updated = false;
        notePatterns.forEach((pattern) => {
            const match = pattern.exec(text);
            if (!match) return;
            removeRangeFromElement(el, match.index, match.index + match[0].length);
            updated = true;
        });
        if (!updated) {
            fuzzyPatterns.forEach((pattern) => {
                if (!pattern) return;
                const match = pattern.exec(text);
                if (!match) return;
                removeRangeFromElement(el, match.index, match.index + match[0].length);
                updated = true;
            });
        }

        if (updated) {
            normalizarEspacosElement(el);
        }
    });
}

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeRangeFromElement(element, start, end) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let index = 0;
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const value = node.nodeValue || "";
        const nodeStart = index;
        const nodeEnd = index + value.length;
        if (end <= nodeStart) break;
        if (start < nodeEnd && end > nodeStart) {
            const sliceStart = Math.max(0, start - nodeStart);
            const sliceEnd = Math.min(value.length, end - nodeStart);
            const before = value.slice(0, sliceStart);
            const after = value.slice(sliceEnd);
            const beforeChar = before.slice(-1);
            const afterChar = after.slice(0, 1);
            const needsSpace =
                beforeChar && afterChar && /[\p{L}\p{N}]/u.test(beforeChar) && /[\p{L}\p{N}]/u.test(afterChar);
            node.nodeValue = before + (needsSpace ? " " : "") + after;
        }
        index = nodeEnd;
    }
}

function normalizarEspacosElement(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.nodeValue) continue;
        node.nodeValue = node.nodeValue.replace(/\s{2,}/g, " ").replace(/\s+\./g, ".");
    }
}

function normalizeCompare(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^\wáéíóúçãõàâêôü0-9 ]/gi, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
}

function buildFuzzyNoteRegex(text) {
    const words = String(text || "")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
    if (words.length < 3) return null;
    const limited = words.slice(0, 14);
    const pattern = limited.map((w) => escapeRegex(w)).join("[\\s\\W]*");
    return new RegExp(`(?:\\d{1,3}\\s*)?${pattern}`, "i");
}

function atualizarSaida(html) {
    htmlSaidaEl.value = html;
    previewHtmlEl.innerHTML = html;
}

function inserirQuebraPagina() {
    setEstado("Quebras de página desativadas no modo atual.");
}

function inserirNotaRodape() {
    const marker = '<p class="rodape-nota sc-paragrafo referencia sc-destaque-referencia-linha">Nota: </p>';
    const atual = htmlSaidaEl.value || "";
    const novo = atual ? `${atual}\n${marker}\n` : marker;
    atualizarSaida(novo);
}

function textoParaHtmlBasico(texto) {
    const lines = String(texto || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let listType = null;

    const closeList = () => {
        if (listType) {
            out.push(`</${listType}>`);
            listType = null;
        }
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            closeList();
            continue;
        }

        const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
        if (headingMatch) {
            closeList();
            const level = headingMatch[1].length;
            out.push(`<h${level}>${escapeHtml(headingMatch[2])}</h${level}>`);
            continue;
        }

        const ulMatch = line.match(/^[-*]\s+(.+)$/);
        if (ulMatch) {
            if (listType !== "ul") {
                closeList();
                listType = "ul";
                out.push("<ul>");
            }
            out.push(`<li>${escapeHtml(ulMatch[1])}</li>`);
            continue;
        }

        const olMatch = line.match(/^\d+\.\s+(.+)$/);
        if (olMatch) {
            if (listType !== "ol") {
                closeList();
                listType = "ol";
                out.push("<ol>");
            }
            out.push(`<li>${escapeHtml(olMatch[1])}</li>`);
            continue;
        }

        closeList();
        out.push(`<p>${escapeHtml(line)}</p>`);
    }

    closeList();
    return out.join("\n");
}

async function converterDocx(file) {
    const arrayBuffer = await file.arrayBuffer();

    if (window.JSZip) {
        try {
            const zip = await window.JSZip.loadAsync(arrayBuffer);
            const documentFile = zip.file("word/document.xml");
            if (documentFile) {
                const documentXml = await documentFile.async("string");
                const footnotesFile = zip.file("word/footnotes.xml");
                const footnotesXml = footnotesFile ? await footnotesFile.async("string") : "";
                const endnotesFile = zip.file("word/endnotes.xml");
                const endnotesXml = endnotesFile ? await endnotesFile.async("string") : "";
                const numberingFile = zip.file("word/numbering.xml");
                const numberingXml = numberingFile ? await numberingFile.async("string") : "";
                const hasFootnotes = /footnoteReference/.test(documentXml) && !!footnotesXml;
                const hasEndnotes = /endnoteReference/.test(documentXml) && !!endnotesXml;
                const hasPageBreak = /lastRenderedPageBreak/.test(documentXml) || /w:type="page"/.test(documentXml);
                const hasLists = /<w:numPr\b|<numPr\b/.test(documentXml);
                const docxHtml = hasFootnotes || hasEndnotes || hasPageBreak || hasLists
                    ? converterDocxXmlParaHtml(documentXml, footnotesXml, endnotesXml, numberingXml)
                    : "";
                if (docxHtml) {
                    return docxHtml;
                }
            }
        } catch (error) {
            console.warn("Falha ao converter DOCX com parser interno. Usando Mammoth.", error);
        }
    }

    if (!window.mammoth) {
        throw new Error("Biblioteca Mammoth não carregada.");
    }
    const styleMap = [
        "p[style-name='Title'] => h2:fresh",
        "p[style-name='Heading 1'] => h2:fresh",
        "p[style-name='Heading1'] => h2:fresh",
        "p[style-name='Heading 2'] => h3:fresh",
        "p[style-name='Heading2'] => h3:fresh",
        "p[style-name='Heading 3'] => h4:fresh",
        "p[style-name='Heading3'] => h4:fresh",
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

function converterDocxXmlParaHtml(documentXml, footnotesXml, endnotesXml = "", numberingXml = "") {
    const doc = new DOMParser().parseFromString(documentXml, "application/xml");
    const body = encontrarPrimeiroPorLocalName(doc, "body");
    if (!body) return "";

    const headingMeta = coletarDocxHeadings(body);
    const headingIds = headingMeta.map((item) => item.id);
    const tocItems = coletarDocxTocItems(body, headingMeta);

    const footnotesById = extrairFootnotesDocx(footnotesXml);
    const endnotesById = extrairNotesDocx(endnotesXml, "endnote");
    const numbering = extrairNumberingDocx(numberingXml);
    const context = {
        footnotesById,
        endnotesById,
        numbering,
        listCounters: new Map(),
        footnoteNumbers: new Map(),
        endnoteNumbers: new Map(),
        footnoteCount: 0,
        endnoteCount: 0,
        headingIds,
        headingIndex: 0,
        getFootnoteNumber(id) {
            if (this.footnoteNumbers.has(id)) return this.footnoteNumbers.get(id);
            this.footnoteCount += 1;
            this.footnoteNumbers.set(id, this.footnoteCount);
            return this.footnoteCount;
        },
        getEndnoteNumber(id) {
            if (this.endnoteNumbers.has(id)) return this.endnoteNumbers.get(id);
            this.endnoteCount += 1;
            this.endnoteNumbers.set(id, this.endnoteCount);
            return this.endnoteCount;
        },
    };

    const out = [];
    if (tocItems.length) {
        out.push(renderDocxToc(tocItems));
    }
    for (const child of body.children) {
        if (child.localName === "p") {
            if (isDocxTocParagraph(child)) continue;
            const blocks = renderParagraphDocx(child, context);
            blocks.forEach((block) => out.push(block));
            continue;
        }

        if (child.localName === "tbl") {
            const tableHtml = renderTableDocx(child, context);
            if (tableHtml) out.push(tableHtml);
            continue;
        }

        if (child.localName === "sdt") {
            continue;
        }

        if (child.localName === "sectPr") {
            continue;
        }

            if (child.localName === "lastRenderedPageBreak") {
                continue;
            }
        }

    return out.join("\n");
}

function extrairNumberingDocx(numberingXml) {
    const result = { nums: new Map(), abstractLevels: new Map() };
    if (!numberingXml) return result;
    const doc = new DOMParser().parseFromString(numberingXml, "application/xml");
    for (const abstractNode of Array.from(doc.getElementsByTagName("*"))) {
        if (abstractNode.localName !== "abstractNum") continue;
        const abstractId = abstractNode.getAttribute("w:abstractNumId") || abstractNode.getAttribute("abstractNumId");
        if (!abstractId) continue;
        const levels = new Map();
        for (const levelNode of Array.from(abstractNode.children)) {
            if (levelNode.localName !== "lvl") continue;
            const ilvl = levelNode.getAttribute("w:ilvl") || levelNode.getAttribute("ilvl") || "0";
            const numFmt = Array.from(levelNode.children).find((node) => node.localName === "numFmt");
            const fmt = numFmt?.getAttribute("w:val") || numFmt?.getAttribute("val") || "decimal";
            levels.set(String(ilvl), fmt);
        }
        result.abstractLevels.set(String(abstractId), levels);
    }
    for (const numNode of Array.from(doc.getElementsByTagName("*"))) {
        if (numNode.localName !== "num") continue;
        const numId = numNode.getAttribute("w:numId") || numNode.getAttribute("numId");
        if (!numId) continue;
        const abstractRef = Array.from(numNode.children).find((node) => node.localName === "abstractNumId");
        const abstractId = abstractRef?.getAttribute("w:val") || abstractRef?.getAttribute("val");
        if (abstractId) result.nums.set(String(numId), String(abstractId));
    }
    return result;
}

function getDocxListInfo(paragraph, context) {
    const pPr = Array.from(paragraph.children).find((node) => node.localName === "pPr");
    if (!pPr) return null;
    const numPr = Array.from(pPr.children).find((node) => node.localName === "numPr");
    if (!numPr) return null;
    const numIdNode = Array.from(numPr.children).find((node) => node.localName === "numId");
    const ilvlNode = Array.from(numPr.children).find((node) => node.localName === "ilvl");
    const numId = numIdNode?.getAttribute("w:val") || numIdNode?.getAttribute("val");
    const ilvl = ilvlNode?.getAttribute("w:val") || ilvlNode?.getAttribute("val") || "0";
    if (!numId) return null;

    const abstractId = context.numbering?.nums?.get(String(numId));
    const fmt = context.numbering?.abstractLevels?.get(String(abstractId))?.get(String(ilvl)) || "decimal";
    const tag = /bullet/i.test(fmt) ? "ul" : "ol";
    const key = `${numId}:${ilvl}`;
    const next = (context.listCounters.get(key) || 0) + 1;
    context.listCounters.set(key, next);
    return { tag, value: next };
}

function renderTableDocx(tableNode, context) {
    const rows = [];
    const tableNotes = [];
    for (const row of tableNode.children) {
        if (row.localName !== "tr") continue;
        const cells = [];
        for (const cell of row.children) {
            if (cell.localName !== "tc") continue;
            const parts = [];
            for (const child of cell.children) {
                if (child.localName === "p") {
                    const html = renderParagraphDocxInline(child, context, tableNotes);
                    if (html) parts.push(html);
                } else if (child.localName === "tbl") {
                    const nested = renderTableDocx(child, context);
                    if (nested) parts.push(nested);
                }
            }
            cells.push(`<td>${parts.join("<br/>")}</td>`);
        }
        if (cells.length) {
            rows.push(`<tr>${cells.join("")}</tr>`);
        }
    }
    if (!rows.length) return "";
    const notesHtml = tableNotes
        .map(
            (note) =>
                `<p class="rodape-nota sc-paragrafo referencia sc-destaque-referencia-linha" data-footnote-number="${note.numero}">${escapeHtml(note.texto)}</p>`
        )
        .join("");
    return `<table class="docx-table">${rows.join("")}</table>${notesHtml}`;
}

function renderParagraphDocxInline(paragraph, context, notesCollector = []) {
    let current = "";

    const handleFootnote = (id) => {
        const numero = context.getFootnoteNumber(id);
        current += `<sup class="footnote-ref" data-footnote-number="${numero}">${numero}</sup>`;
        const texto = context.footnotesById.get(id);
        if (texto) notesCollector.push({ numero, texto });
    };
    const handleEndnote = (id) => {
        const numero = context.getEndnoteNumber(id);
        current += `<sup class="footnote-ref endnote-ref" data-endnote-number="${numero}">${numero}</sup>`;
        const texto = context.endnotesById.get(id);
        if (texto) notesCollector.push({ numero, texto: `Nota final ${numero}: ${texto}` });
    };

    const appendStyled = (text, runNode) => {
        if (!text) return;
        const styled = aplicarRunStyleDocx(text, runNode);
        current += styled;
    };

    const processNode = (node) => {
        if (node.localName === "r") {
            for (const child of node.childNodes) {
                if (child.nodeType !== Node.ELEMENT_NODE) continue;
                if (child.localName === "t") {
                    appendStyled(escapeHtml(child.textContent || ""), node);
                    continue;
                }
                if (child.localName === "tab") {
                    appendStyled("&emsp;", node);
                    continue;
                }
                if (child.localName === "br") {
                    const type = child.getAttribute("w:type") || child.getAttribute("type") || "";
                    if (type !== "page") {
                        current += "<br/>";
                    }
                    continue;
                }
                if (child.localName === "footnoteReference") {
                    const id = child.getAttribute("w:id") || child.getAttribute("id");
                    if (id) handleFootnote(String(id));
                    continue;
                }
                if (child.localName === "endnoteReference") {
                    const id = child.getAttribute("w:id") || child.getAttribute("id");
                    if (id) handleEndnote(String(id));
                    continue;
                }
                if (child.localName === "instrText") {
                    appendStyled(escapeHtml(child.textContent || ""), node);
                    continue;
                }
            }
            return;
        }

        if (node.localName === "hyperlink" || node.localName === "fldSimple") {
            for (const child of node.children) {
                processNode(child);
            }
            return;
        }
    };

    for (const child of paragraph.children) {
        processNode(child);
    }

    return current.trim();
}

function extrairFootnotesDocx(footnotesXml) {
    return extrairNotesDocx(footnotesXml, "footnote");
}

function extrairNotesDocx(notesXml, localName) {
    if (!notesXml) return new Map();
    const doc = new DOMParser().parseFromString(notesXml, "application/xml");
    const notes = new Map();
    const nodes = doc.getElementsByTagName("*");
    for (const node of nodes) {
        if (node.localName !== localName) continue;
        const type = node.getAttribute("w:type") || node.getAttribute("type") || "";
        if (type === "separator" || type === "continuationSeparator") continue;
        const idRaw = node.getAttribute("w:id") || node.getAttribute("id");
        const id = String(idRaw || "").trim();
        if (!id || Number(id) <= 0) continue;
        const texto = extrairTextoFootnoteDocx(node);
        if (texto) {
            notes.set(id, texto);
        }
    }
    return notes;
}

function extrairTextoFootnoteDocx(footnoteNode) {
    const parts = [];
    for (const child of footnoteNode.children) {
        if (child.localName !== "p") continue;
        const texto = extrairTextoParagrafoDocx(child).trim();
        if (texto) parts.push(texto);
    }
    return parts.join(" ").replace(/\s{2,}/g, " ").trim();
}

function renderParagraphDocx(paragraph, context) {
    const blocks = [];
    let current = "";
    let pendingNotes = [];
    const paragraphStyle = getDocxParagraphStyle(paragraph);
    const paragraphStyleKey = normalizeDocxStyleName(paragraphStyle);
    const paragraphClasses = [];
    let tag = getDocxParagraphTag(paragraph);
    const listInfo = getDocxListInfo(paragraph, context);
    if (paragraphStyleKey === "citacaointensa" || paragraphStyleKey === "intensequote") {
        tag = "blockquote";
        paragraphClasses.push("citacao-intensa", "docx-citacao-intensa");
    }
    if (paragraphStyleKey === "referenciasutil" || paragraphStyleKey === "subtlereference") {
        paragraphClasses.push("referencia-sutil", "docx-referencia-sutil");
    }
    if (paragraphStyleKey === "referenciaintensa" || paragraphStyleKey === "intensereference") {
        paragraphClasses.push("referencia-intensa", "docx-referencia-intensa");
    }
    const isHeading = tag.startsWith("h");
    const headingId = isHeading ? context.headingIds[context.headingIndex] : null;
    if (isHeading) context.headingIndex += 1;

    const flushCurrent = () => {
        if (current.trim()) {
            if (listInfo) {
                const valueAttr = listInfo.tag === "ol" ? ` value="${listInfo.value}"` : "";
                blocks.push(`<${listInfo.tag} class="docx-list"><li${valueAttr}>${current}</li></${listInfo.tag}>`);
            } else {
                const idAttr = headingId ? ` id="${headingId}"` : "";
                const classAttr = paragraphClasses.length ? ` class="${paragraphClasses.join(" ")}"` : "";
                blocks.push(`<${tag}${idAttr}${classAttr}>${current}</${tag}>`);
            }
            current = "";
        }
    };

    const flushNotes = () => {
        if (!pendingNotes.length) return;
        pendingNotes.forEach((noteHtml) => blocks.push(noteHtml));
        pendingNotes = [];
    };

    const handlePageBreak = () => {
        flushCurrent();
        flushNotes();
                return;
            };

    const handleFootnote = (id) => {
        const numero = context.getFootnoteNumber(id);
        current += `<sup class="footnote-ref" data-footnote-number="${numero}">${numero}</sup>`;
        const texto = context.footnotesById.get(id);
        if (texto) {
            pendingNotes.push(
                `<p class="rodape-nota sc-paragrafo referencia sc-destaque-referencia-linha" data-footnote-number="${numero}">${escapeHtml(texto)}</p>`
            );
        }
    };
    const handleEndnote = (id) => {
        const numero = context.getEndnoteNumber(id);
        current += `<sup class="footnote-ref endnote-ref" data-endnote-number="${numero}">${numero}</sup>`;
        const texto = context.endnotesById.get(id);
        if (texto) {
            pendingNotes.push(
                `<p class="rodape-nota nota-fim sc-paragrafo referencia sc-destaque-referencia-linha" data-endnote-number="${numero}">${escapeHtml(`Nota final ${numero}: ${texto}`)}</p>`
            );
        }
    };

    const appendStyled = (text, runNode) => {
        if (!text) return;
        const styled = aplicarRunStyleDocx(text, runNode);
        current += styled;
    };

    const processNode = (node) => {
        if (node.localName === "r") {
            for (const child of node.childNodes) {
                if (child.nodeType !== Node.ELEMENT_NODE) continue;
                if (child.localName === "t") {
                    appendStyled(escapeHtml(child.textContent || ""), node);
                    continue;
                }
                if (child.localName === "tab") {
                    appendStyled("&emsp;", node);
                    continue;
                }
                if (child.localName === "br") {
                    const type = child.getAttribute("w:type") || child.getAttribute("type") || "";
                    if (type === "page") {
                        continue;
                    } else {
                        current += "<br/>";
                    }
                    continue;
                }
                if (child.localName === "footnoteReference") {
                    const id = child.getAttribute("w:id") || child.getAttribute("id");
                    if (id) handleFootnote(String(id));
                    continue;
                }
                if (child.localName === "endnoteReference") {
                    const id = child.getAttribute("w:id") || child.getAttribute("id");
                    if (id) handleEndnote(String(id));
                    continue;
                }
                if (child.localName === "lastRenderedPageBreak") {
                    continue;
                }
                if (child.localName === "instrText") {
                    appendStyled(escapeHtml(child.textContent || ""), node);
                    continue;
                }
            }
            return;
        }

        if (node.localName === "hyperlink" || node.localName === "fldSimple") {
            for (const child of node.children) {
                processNode(child);
            }
            return;
        }

        if (node.localName === "lastRenderedPageBreak") {
            handlePageBreak();
        }
    };

    for (const child of paragraph.children) {
        processNode(child);
    }

    flushCurrent();
    flushNotes();
    return blocks;
}

function getDocxParagraphTag(paragraph) {
    const pPr = Array.from(paragraph.children).find((node) => node.localName === "pPr");
    if (!pPr) return "p";
    const pStyle = Array.from(pPr.children).find((node) => node.localName === "pStyle");
    if (!pStyle) return "p";
    const raw = pStyle.getAttribute("w:val") || pStyle.getAttribute("val") || "";
    if (!raw) return "p";
    const key = raw.replace(/\s+/g, "").toLowerCase();
    if (key === "title") return "h2";
    if (key === "heading1") return "h2";
    if (key === "heading2") return "h3";
    if (key === "heading3") return "h4";
    if (key === "heading4") return "h4";
    if (key === "heading5") return "h4";
    if (key === "heading6") return "h4";
    return "p";
}

function getDocxParagraphStyle(paragraph) {
    const pPr = Array.from(paragraph.children).find((node) => node.localName === "pPr");
    if (!pPr) return "";
    const pStyle = Array.from(pPr.children).find((node) => node.localName === "pStyle");
    if (!pStyle) return "";
    return (pStyle.getAttribute("w:val") || pStyle.getAttribute("val") || "").trim();
}

function isDocxHeadingStyle(style) {
    const key = String(style || "").replace(/\s+/g, "").toLowerCase();
    return key === "title" || key.startsWith("heading");
}

function isDocxTocParagraph(paragraph) {
    const style = getDocxParagraphStyle(paragraph);
    return /^TOC\d+/i.test(style);
}

function iterarParagrafosDocx(node, onParagraph) {
    if (!node) return;
    for (const child of node.children || []) {
        if (child.localName === "p") {
            onParagraph(child);
        } else {
            iterarParagrafosDocx(child, onParagraph);
        }
    }
}

function coletarDocxHeadings(body) {
    const items = [];
    const used = new Map();
    iterarParagrafosDocx(body, (paragraph) => {
        const style = getDocxParagraphStyle(paragraph);
        if (!isDocxHeadingStyle(style)) return;
        const texto = extrairTextoParagrafoDocx(paragraph);
        if (!texto) return;
        const base = slugifyDocxHeading(texto);
        const count = (used.get(base) || 0) + 1;
        used.set(base, count);
        const id = count > 1 ? `${base}-${count}` : base;
        items.push({
            id,
            texto,
            textoNormalizado: normalizarTextoIndiceDocx(texto),
        });
    });
    return items;
}

function coletarDocxTocItems(body, headingMeta) {
    const items = [];
    let fallbackIndex = 0;
    const idsPorTexto = new Map();
    headingMeta.forEach((heading, idx) => {
        const key = heading.textoNormalizado;
        if (!key) return;
        if (!idsPorTexto.has(key)) idsPorTexto.set(key, []);
        idsPorTexto.get(key).push({ id: heading.id, idx });
    });

    iterarParagrafosDocx(body, (paragraph) => {
        if (!isDocxTocParagraph(paragraph)) return;
        let texto = extrairTextoParagrafoDocx(paragraph).trim();
        if (!texto) return;
        texto = limparTextoTocDocx(texto);
        const levelMatch = (getDocxParagraphStyle(paragraph).match(/\d+/) || []);
        const level = levelMatch.length ? Number(levelMatch[0]) : 1;
        const key = normalizarTextoIndiceDocx(texto);
        let targetId = "";
        if (key && idsPorTexto.has(key)) {
            const match = idsPorTexto.get(key).shift();
            if (match) {
                targetId = match.id;
                fallbackIndex = Math.max(fallbackIndex, match.idx + 1);
            }
        }

        if (!targetId && key) {
            for (let i = fallbackIndex; i < headingMeta.length; i += 1) {
                const headingKey = headingMeta[i].textoNormalizado;
                if (!headingKey) continue;
                if (headingKey.includes(key) || key.includes(headingKey)) {
                    targetId = headingMeta[i].id;
                    fallbackIndex = i + 1;
                    break;
                }
            }
        }

        if (!targetId && headingMeta[fallbackIndex]) {
            targetId = headingMeta[fallbackIndex].id;
            fallbackIndex += 1;
        }

        if (!targetId) {
            targetId = slugifyDocxHeading(texto);
        }
        items.push({ texto, level, targetId });
    });
    return items;
}

function renderDocxToc(items) {
    const lines = items.map((item) => {
        const indent = Math.max(1, Math.min(4, item.level));
        return `<li class="docx-toc-item level-${indent}"><a href="#${item.targetId}">${escapeHtml(item.texto)}</a></li>`;
    });
    return `
        <nav class="docx-toc">
            <h3>Índice</h3>
            <ul>${lines.join("")}</ul>
        </nav>
    `;
}

function slugifyDocxHeading(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 80);
}

function limparTextoTocDocx(texto = "") {
    return String(texto || "")
        .replace(/\s*[._-]{2,}\s*\d+\s*$/g, "")
        .replace(/\s+\d+\s*$/g, "")
        .trim();
}

function normalizarTextoIndiceDocx(value = "") {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeDocxStyleName(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

function extrairTextoParagrafoDocx(paragraph) {
    let out = "";
    const append = (text) => {
        out += text;
    };
    for (const child of paragraph.children) {
        if (child.localName === "r") {
            for (const rChild of child.childNodes) {
                if (rChild.nodeType !== Node.ELEMENT_NODE) continue;
                if (rChild.localName === "t") {
                    append(rChild.textContent || "");
                } else if (rChild.localName === "tab") {
                    append(" ");
                } else if (rChild.localName === "br") {
                    append(" ");
                }
            }
        } else if (child.localName === "hyperlink" || child.localName === "fldSimple") {
            out += extrairTextoParagrafoDocx(child);
        }
    }
    return out.replace(/\s{2,}/g, " ").trim();
}

function aplicarRunStyleDocx(html, runNode) {
    let bold = false;
    let italic = false;
    let underline = false;
    let styleClass = "";
    const rPr = Array.from(runNode.children).find((node) => node.localName === "rPr");
    if (rPr) {
        for (const child of rPr.children) {
            if (child.localName === "rStyle") {
                const raw = child.getAttribute("w:val") || child.getAttribute("val") || "";
                const key = normalizeDocxStyleName(raw);
                if (key === "referenciasutil" || key === "subtlereference") {
                    styleClass = "referencia-sutil";
                } else if (key === "referenciaintensa" || key === "intensereference") {
                    styleClass = "referencia-intensa";
                } else if (key === "enfaseintensa" || key === "intenseemphasis") {
                    styleClass = "enfase-intenso";
                }
            }
            if (child.localName === "b") {
                const val = child.getAttribute("w:val") || child.getAttribute("val");
                bold = val !== "false" && val !== "0";
            }
            if (child.localName === "i") {
                const val = child.getAttribute("w:val") || child.getAttribute("val");
                italic = val !== "false" && val !== "0";
            }
            if (child.localName === "u") {
                const val = child.getAttribute("w:val") || child.getAttribute("val");
                underline = val !== "none" && val !== "false" && val !== "0";
            }
        }
    }

    let out = html;
    if (bold) out = `<strong>${out}</strong>`;
    if (italic) out = `<em>${out}</em>`;
    if (underline) out = `<u>${out}</u>`;
    if (styleClass) out = `<span class="${styleClass}">${out}</span>`;
    return out;
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

function extrairTextoNotaOdt(noteNode) {
    const body = Array.from(noteNode.children || []).find((n) => n.localName === "note-body");
    if (!body) return "";
    return textoNodoOdt(body).trim();
}

function textoSpanOdt(node) {
    const styleName = node.getAttribute("text:style-name") || node.getAttribute("style-name") || "";
    const text = textoNodoOdt(node).trim();
    if (!text) return "";
    const lower = styleName.toLowerCase();
    let html = escapeHtml(text);
    if (lower.includes("bold") || lower.includes("negrito") || lower.includes("strong")) {
        html = `<strong>${html}</strong>`;
    }
    if (lower.includes("italic") || lower.includes("itá") || lower.includes("italico")) {
        html = `<em>${html}</em>`;
    }
    if (lower.includes("underline") || lower.includes("sublinh")) {
        html = `<u>${html}</u>`;
    }
    return html;
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
    const notas = [];

    function walk(node) {
        for (const child of node.children) {
            if (child.localName === "h") {
                const levelRaw = Number(child.getAttribute("text:outline-level") || 2);
                const level = Math.max(1, Math.min(4, levelRaw));
                out.push(`<h${level}>${escapeHtml(textoNodoOdt(child).trim())}</h${level}>`);
                continue;
            }

            if (child.localName === "p") {
                let html = "";
                for (const item of child.childNodes) {
                    if (item.nodeType === Node.TEXT_NODE) {
                        html += escapeHtml(item.nodeValue || "");
                        continue;
                    }
                    if (item.nodeType !== Node.ELEMENT_NODE) continue;
                    if (item.localName === "span") {
                        html += textoSpanOdt(item);
                        continue;
                    }
                    if (item.localName === "note") {
                        const noteText = extrairTextoNotaOdt(item);
                        if (noteText) {
                            notas.push(noteText);
                            const n = notas.length;
                            html += `<sup class="footnote-ref" data-footnote-number="${n}">${n}</sup>`;
                        }
                        continue;
                    }
                    if (item.localName === "line-break") {
                        html += "<br/>";
                        continue;
                    }
                    if (item.localName === "soft-page-break") {
                        continue;
                    }
                    if (item.localName === "tab") {
                        html += "&emsp;";
                        continue;
                    }
                    html += escapeHtml(textoNodoOdt(item));
                }
                const texto = html.trim();
                if (texto) out.push(`<p>${texto}</p>`);
                continue;
            }

            if (child.localName === "list") {
                out.push(renderListOdt(child));
                continue;
            }

            if (child.localName === "soft-page-break") {
                continue;
            }

            walk(child);
        }
    }

    walk(officeText);
    if (notas.length) {
        notas.forEach((nota) => {
            out.push(`<p class="rodape-nota sc-paragrafo referencia sc-destaque-referencia-linha">${escapeHtml(nota)}</p>`);
        });
    }
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
        } else if (nome.endsWith(".docx")) {
            htmlRaw = await converterDocx(file);
        } else if (nome.endsWith(".odt")) {
            htmlRaw = await converterOdt(file);
        } else if (nome.endsWith(".doc")) {
            throw new Error("Formato .doc não suportado diretamente. Abra no Writer/Word e salve como .docx ou .odt.");
        } else {
            throw new Error("Formato não suportado. Use .docx, .odt, .txt ou .html.");
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
    const texto = textoFonteEl.value || "";
    const htmlFinal = finalizeHtml(textoParaHtmlBasico(texto));
    atualizarSaida(htmlFinal);
    setEstado("Texto convertido para HTML com classes.");
}

async function copiarHtml() {
    const valor = htmlSaidaEl.value || "";
    if (!valor.trim()) {
        setEstado("Não há HTML para copiar.");
        return;
    }
    await navigator.clipboard.writeText(valor);
    setEstado("HTML copiado para a área de transferência.");
}

function reaplicarClasses() {
    const valor = htmlSaidaEl.value || "";
    if (!valor.trim()) return;
    atualizarSaida(finalizeHtml(valor));
    setEstado("Classes SENTINELA reaplicadas.");
}

async function salvarConteudo() {
    if (!campoDisciplinaEl.value.trim() || !campoNomeEl.value.trim() || !campoSubtemaEl.value.trim()) {
        setEstadoSalvar("Preencha disciplina, nome e subtema.");
        return;
    }

    const temConteudo = htmlSaidaEl.value.trim().length > 0;
    if (!temConteudo) {
        setEstadoSalvar("Preencha conteúdo antes de guardar.");
        return;
    }

    try {
        setEstadoSalvar("A guardar...");
        const autores = parseAutores(campoAutoresEl?.value || "");
        
        const payload = {
            disciplina: String(campoDisciplinaEl.value || "").trim(),
            nome: String(campoNomeEl.value || "").trim(),
            subtema: String(campoSubtemaEl.value || "").trim(),
            autores,
            conteudoHtml: htmlSaidaEl.value
        };

        const response = await authenticatedFetch("/api/home/fase-conteudo", {
            method: "POST",
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const erro = await response.text();
            throw new Error(`Falha ao guardar: ${response.status} ${erro}`);
        }

        setEstadoSalvar("✓ Conteúdo guardado com sucesso!");
    } catch (error) {
        console.error(error);
        setEstadoSalvar(error.message || "Erro ao guardar.");
    }
}

function montarPayload() {
    const autores = parseAutores(campoAutoresEl?.value || "");
    return {
        disciplina: String(campoDisciplinaEl.value || "").trim(),
        nome: String(campoNomeEl.value || "").trim(),
        subtema: String(campoSubtemaEl.value || "").trim(),
        conteudoHtml: htmlSaidaEl.value || "",
        autores,
    };
}

async function salvarFase() {
    const payload = montarPayload();

    if (!payload.disciplina || !payload.nome || !payload.subtema) {
        setEstadoSalvar("Preencha disciplina, nome e subtema.");
        return;
    }
    if (!payload.conteudoHtml.trim()) {
        setEstadoSalvar("Converta ou escreva conteúdo antes de guardar.");
        return;
    }

    try {
        setEstadoSalvar("A guardar...");
        const response = await authenticatedFetch("/api/home/fase-conteudo", {
            method: "POST",
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const erro = await response.text();
            throw new Error(`Falha ao guardar: ${response.status} ${erro}`);
        }

        setEstadoSalvar("Conteúdo guardado com sucesso.");
    } catch (error) {
        console.error(error);
        setEstadoSalvar(error.message || "Erro ao guardar conteúdo.");
    }
}

async function init() {
    const user = await getUser();
    if (!user) {
        window.location.href = "/index.html";
        return;
    }
    if (!isAdminUser(user)) {
        alert("Apenas administradores podem acessar o editor de conteúdo.");
        window.location.href = "/app/home";
        return;
    }

    uploadArquivoEl.addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        await processarUpload(file);
    });

    btnConverterTextoEl.addEventListener("click", converterTextoManual);
    btnCopiarHtmlEl.addEventListener("click", copiarHtml);
    btnAplicarClassesEl.addEventListener("click", reaplicarClasses);
    if (btnInserirPageBreakEl) {
        btnInserirPageBreakEl.addEventListener("click", inserirQuebraPagina);
    }
    if (btnInserirRodapeEl) {
        btnInserirRodapeEl.addEventListener("click", inserirNotaRodape);
    }
    btnSalvarConteudoEl.addEventListener("click", salvarConteudo);
    btnCopiarPayloadEl.addEventListener("click", copiarPayloadJson);

    carregarAutoresGestores();
}

init();

function parseAutores(texto) {
    return String(texto || "")
        .split(/[;,]+/g)
        .map((item) => item.trim())
        .filter(Boolean);
}

async function carregarAutoresGestores() {
    if (!listaAutoresEl) return;
    try {
        const response = await fetch('/gestores.json', { cache: 'no-cache' });
        if (!response.ok) return;
        const data = await response.json();
        const gestores = Array.isArray(data) ? data : Object.values(data || {});
        listaAutoresEl.innerHTML = '';
        gestores.forEach((gestor) => {
            if (!gestor?.nome) return;
            const option = document.createElement('option');
            option.value = gestor.nome;
            listaAutoresEl.appendChild(option);
        });
    } catch (error) {
        console.warn('Não foi possível carregar autores:', error);
    }
}
