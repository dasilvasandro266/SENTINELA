import { authenticatedFetch } from "./authManager.js";

const API_URL = '/api';

let legislacaoGlobal = null;

// =============================================
// NORMALIZAÇÃO DE DADOS
// =============================================

function parseAlineasDoTexto(texto) {
    if (!texto || typeof texto !== "string") return null;

    const regex = /(?:^|\n|;\s*)([a-z]{1,3})\)\s+([\s\S]*?)(?=(?:\n|;\s*)[a-z]{1,3}\)\s+|$)/gi;
    const alineas = {};
    let match;

    while ((match = regex.exec(texto)) !== null) {
        const letra = String(match[1] || "").toLowerCase();
        const conteudo = String(match[2] || "").replace(/\s+/g, " ").trim();
        if (letra && conteudo) {
            alineas[letra] = conteudo;
        }
    }

    return Object.keys(alineas).length > 0 ? alineas : null;
}

function parseParagrafosDoTexto(texto) {
    if (!texto || typeof texto !== "string") return [];

    const paragrafos = [];
    const regex = /(?:^|\n)\s*§\s*(\d+[º°]?|u[úu]nico)\s*[-–—.:)]?\s*([\s\S]*?)(?=(?:\n\s*§\s*(?:\d+[º°]?|u[úu]nico)\s*[-–—.:)]?\s*)|$)/gi;
    let match;

    while ((match = regex.exec(texto)) !== null) {
        const numeroRaw = String(match[1] || "").toLowerCase().replace("unico", "único");
        const conteudoRaw = String(match[2] || "").trim();
        const alineas = parseAlineasDoTexto(conteudoRaw);

        paragrafos.push({
            numero: numeroRaw || "",
            conteudo: conteudoRaw,
            ...(alineas ? { alineas } : {})
        });
    }

    return paragrafos;
}

function normalizarAlineas(alineas) {
    if (!alineas) return null;

    if (Array.isArray(alineas)) {
        const obj = {};
        alineas.forEach((item) => {
            if (!item) return;
            if (typeof item === "string") {
                const m = item.match(/^([a-z]{1,3})\)\s*(.*)$/i);
                if (m) obj[m[1].toLowerCase()] = m[2].trim();
                return;
            }
            const letra = String(item.letra || item.key || "").toLowerCase();
            const conteudo = item.conteudo || item.texto || "";
            if (letra && conteudo) obj[letra] = String(conteudo).trim();
        });
        return Object.keys(obj).length > 0 ? obj : null;
    }

    if (typeof alineas === "object") {
        const obj = {};
        Object.entries(alineas).forEach(([letra, conteudo]) => {
            if (!letra) return;
            if (conteudo === null || conteudo === undefined) return;
            obj[String(letra).toLowerCase()] = String(conteudo).trim();
        });
        return Object.keys(obj).length > 0 ? obj : null;
    }

    return null;
}

function normalizarParagrafo(paragrafo) {
    const numero = paragrafo?.numero ?? "caput";
    const conteudo = String(paragrafo?.conteudo || "").trim();
    const alineasDiretas = normalizarAlineas(paragrafo?.alineas);
    const alineasDoTexto = parseAlineasDoTexto(conteudo);
    const alineas = alineasDiretas || alineasDoTexto || null;

    const resultado = {
        ...paragrafo,
        numero,
        conteudo
    };

    if (alineas) resultado.alineas = alineas;
    return resultado;
}

function normalizarArtigo(artigo) {
    let paragrafos = Array.isArray(artigo?.paragrafos) ? artigo.paragrafos.map(normalizarParagrafo) : [];

    if (paragrafos.length === 0 && artigo?.conteudo) {
        const detectados = parseParagrafosDoTexto(String(artigo.conteudo));
        if (detectados.length > 0) {
            paragrafos = detectados.map(normalizarParagrafo);
        } else {
            paragrafos = [normalizarParagrafo({ numero: "caput", conteudo: String(artigo.conteudo) })];
        }
    }

    // Fallback para APIs que retornam alíneas no nível do artigo
    const alineasArtigo = normalizarAlineas(artigo?.alineas);
    if (alineasArtigo) {
        const idxCaput = paragrafos.findIndex((p) => String(p.numero).toLowerCase() === "caput");
        if (idxCaput >= 0) {
            paragrafos[idxCaput].alineas = { ...(paragrafos[idxCaput].alineas || {}), ...alineasArtigo };
        } else if (paragrafos.length > 0) {
            paragrafos[0].alineas = { ...(paragrafos[0].alineas || {}), ...alineasArtigo };
        } else {
            paragrafos.push({ numero: "caput", conteudo: "", alineas: alineasArtigo });
        }
    }

    // Se nenhuma alínea veio estruturada, tenta extrair direto do conteúdo do artigo
    const existeAlinea = paragrafos.some((p) => p?.alineas && Object.keys(p.alineas).length > 0);
    if (!existeAlinea && artigo?.conteudo) {
        const alineasDoArtigo = parseAlineasDoTexto(String(artigo.conteudo));
        if (alineasDoArtigo) {
            const idxCaput = paragrafos.findIndex((p) => String(p.numero).toLowerCase() === "caput");
            if (idxCaput >= 0) {
                paragrafos[idxCaput].alineas = { ...(paragrafos[idxCaput].alineas || {}), ...alineasDoArtigo };
            } else if (paragrafos.length > 0) {
                paragrafos[0].alineas = { ...(paragrafos[0].alineas || {}), ...alineasDoArtigo };
            } else {
                paragrafos.push({ numero: "caput", conteudo: String(artigo.conteudo), alineas: alineasDoArtigo });
            }
        }
    }

    return {
        ...artigo,
        paragrafos
    };
}

function flattenEstrutura(estrutura, parentId, nivel, ordemBase, estruturasOut, artigosOut) {
    const estruturaId = `estr_${estruturasOut.length + 1}`;
    estruturasOut.push({
        id: estruturaId,
        tipo: estrutura.tipo || "Estrutura",
        numero: estrutura.numero || "",
        titulo: estrutura.titulo || "",
        parent_id: parentId || null,
        nivel,
        ordem: ordemBase + estruturasOut.length
    });

    if (Array.isArray(estrutura.artigos)) {
        estrutura.artigos.forEach((artigo) => {
            artigosOut.push({
                ...normalizarArtigo(artigo),
                estrutura_id: estruturaId
            });
        });
    }

    if (Array.isArray(estrutura.subestruturas)) {
        estrutura.subestruturas.forEach((sub) => {
            flattenEstrutura(sub, estruturaId, nivel + 1, ordemBase, estruturasOut, artigosOut);
        });
    }
}

function normalizarLegislacao(legislacao) {
    if (!legislacao || typeof legislacao !== "object") return legislacao;

    // Formato já compatível (API com estruturas + artigos)
    if (Array.isArray(legislacao.estruturas) || Array.isArray(legislacao.artigos)) {
        const artigosNormalizados = Array.isArray(legislacao.artigos)
            ? legislacao.artigos.map(normalizarArtigo)
            : [];

        return {
            ...legislacao,
            artigos: artigosNormalizados
        };
    }

    // Formato do JSON extraído/importador (estrutura hierárquica)
    if (Array.isArray(legislacao.estrutura)) {
        const estruturas = [];
        const artigos = [];

        legislacao.estrutura.forEach((raiz) => {
            flattenEstrutura(raiz, null, 0, 0, estruturas, artigos);
        });

        return {
            ...legislacao,
            estruturas,
            artigos
        };
    }

    return legislacao;
}

// =============================================
// FUNÇÕES DE CARREGAMENTO
// =============================================

async function carregarLegislacao(activeDocumentState = null) {
    const urlParams = new URLSearchParams(window.location.search);
    const legislacaoId = urlParams.get('legislacao');
    const container = document.getElementById("legislacao-container");

    if (!container) {
        console.error("Erro leitor.js: elemento #legislacao-container não encontrado.");
        return;
    }

    if (!legislacaoId) {
        container.innerHTML = "<p>Legislação não especificada.</p>";
        return;
    }

    localStorage.setItem("legislacaoAtual", legislacaoId);

    try {
        const response = await authenticatedFetch(`${API_URL}/legislacoes/${legislacaoId}`);
        
        if (response.ok) {
            legislacaoGlobal = normalizarLegislacao(await response.json());
            processarConteudoLegislacao(container, legislacaoGlobal);
            await registrarHistoricoLegislacao(legislacaoId, legislacaoGlobal?.nome || '');
            await marcarArtigosComRemissoes(legislacaoId);
            restaurarScroll(legislacaoId, activeDocumentState);
            restaurarZoom(activeDocumentState);
        } else {
            container.innerHTML = "<p>Legislação não encontrada.</p>";
        }
        
    } catch (error) {
        console.error("Erro ao carregar legislação:", error);
        container.innerHTML = "<p>Erro ao carregar legislação. Verifique se o servidor está rodando.</p>";
    }
}

// =============================================
// FUNÇÃO PRINCIPAL DE PROCESSAMENTO
// =============================================

function processarConteudoLegislacao(container, legislacao) {
    container.innerHTML = '';
    
    // Título principal
    const tituloPrincipal = document.createElement("h1");
    tituloPrincipal.textContent = legislacao.nome;
    container.appendChild(tituloPrincipal);

    // Barra de pesquisa
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.id = "search";
    searchInput.placeholder = "Pesquisar...";
    searchInput.addEventListener("input", realizarPesquisa);
    container.appendChild(searchInput);

    // Fundamentação (se houver)
    if (legislacao.fundamentacao) {
        renderizarFundamentacao(container, legislacao);
    }

    // VERIFICAR O TIPO DE DADOS RECEBIDOS
    console.log("Estrutura da legislação:", {
        temEstruturas: !!legislacao.estruturas,
        temArtigos: !!legislacao.artigos,
        temConteudo: !!legislacao.conteudo,
        chaves: Object.keys(legislacao)
    });

    // CASO 1: Dados estruturados com artigos e estruturas
    if (legislacao.estruturas || legislacao.artigos) {
        renderizarLegislacaoEstruturada(container, legislacao);
    }
    // CASO 2: Conteúdo HTML bruto (como no screenshot)
    else if (legislacao.conteudo && typeof legislacao.conteudo === 'string') {
        renderizarConteudoBruto(container, legislacao);
    }
    // CASO 3: Formato desconhecido - mostrar como JSON para debug
    else {
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(legislacao, null, 2);
        container.appendChild(pre);
    }
}

// =============================================
// FUNÇÕES DE RENDERIZAÇÃO ESPECÍFICAS
// =============================================

function renderizarLegislacaoEstruturada(container, legislacao) {
    // Organizar estruturas por nível
    const estruturasPorNivel = {};
    if (legislacao.estruturas) {
        legislacao.estruturas.forEach(est => {
            if (!estruturasPorNivel[est.nivel]) estruturasPorNivel[est.nivel] = [];
            estruturasPorNivel[est.nivel].push(est);
        });
    }

    // Agrupar artigos por estrutura
    const artigosPorEstrutura = {};
    if (legislacao.artigos) {
        legislacao.artigos.forEach(art => {
            const estruturaId = art.estrutura_id || 'root';
            if (!artigosPorEstrutura[estruturaId]) artigosPorEstrutura[estruturaId] = [];
            artigosPorEstrutura[estruturaId].push(art);
        });
    }

    // Função recursiva para renderizar estrutura
    function renderizarEstrutura(estruturaId, nivel) {
        const estrutura = legislacao.estruturas?.find(e => e.id === estruturaId);
        if (estrutura) {
            const divEstrutura = document.createElement("div");
            divEstrutura.className = `estrutura-item nivel-${nivel}`;
            
            const tituloEstrutura = document.createElement("h3");
            tituloEstrutura.textContent = `${estrutura.tipo || 'Estrutura'} ${estrutura.numero || ''}: ${estrutura.titulo || ''}`;
            divEstrutura.appendChild(tituloEstrutura);
            
            container.appendChild(divEstrutura);
            
            // Renderizar artigos desta estrutura
            const artigos = artigosPorEstrutura[estruturaId] || [];
            artigos.sort((a, b) => {
                const numA = parseInt(a.numero) || 0;
                const numB = parseInt(b.numero) || 0;
                return numA - numB;
            });
            
            artigos.forEach(art => {
                renderizarArtigo(container, art);
            });
            
            // Renderizar subestruturas
            const subestruturas = legislacao.estruturas?.filter(e => e.parent_id === estruturaId) || [];
            subestruturas.sort((a, b) => a.ordem - b.ordem);
            
            subestruturas.forEach(sub => {
                renderizarEstrutura(sub.id, nivel + 1);
            });
        }
    }
    
    // Renderizar artigos sem estrutura (raiz)
    const artigosRaiz = artigosPorEstrutura['root'] || [];
    artigosRaiz.forEach(art => {
        renderizarArtigo(container, art);
    });
    
    // Começar pelas estruturas de nível 0 (raiz)
    const raizes = legislacao.estruturas?.filter(e => !e.parent_id) || [];
    raizes.sort((a, b) => a.ordem - b.ordem);
    
    raizes.forEach(raiz => {
        renderizarEstrutura(raiz.id, 0);
    });
}

function renderizarArtigo(container, art) {
    const divArtigo = document.createElement("div");
    divArtigo.className = "artigo-item";
    divArtigo.id = `artigo-${art.numero}`;
    
    // Título do artigo
    const tituloArtigo = document.createElement("h4");
    tituloArtigo.textContent = `Artigo ${art.numero}${art.epigrafe ? ': ' + art.epigrafe : ''}`;
    divArtigo.appendChild(tituloArtigo);
    
    // Conteúdo direto do artigo só aparece quando não há parágrafos úteis
    const temParagrafosComConteudo = Array.isArray(art.paragrafos)
        && art.paragrafos.some((p) => String(p?.conteudo || '').trim().length > 0);

    if (art.conteudo && !temParagrafosComConteudo) {
        const conteudoDiv = document.createElement("div");
        conteudoDiv.className = "artigo-conteudo";
        
        // Verificar se é HTML
        if (art.conteudo.includes('<') && art.conteudo.includes('>')) {
            conteudoDiv.innerHTML = art.conteudo;
        } else {
            conteudoDiv.textContent = art.conteudo;
        }
        divArtigo.appendChild(conteudoDiv);
    }
    
    // Processar parágrafos
    if (art.paragrafos && art.paragrafos.length > 0) {
        const paragrafosOrdenados = [...art.paragrafos].sort((a, b) => {
            const numA = a.numero !== undefined && a.numero !== null ? a.numero : '';
            const numB = b.numero !== undefined && b.numero !== null ? b.numero : '';
            
            if (!isNaN(numA) && !isNaN(numB) && numA !== '' && numB !== '') {
                return parseInt(numA) - parseInt(numB);
            }
            
            if (numA === 'único') return 1;
            if (numB === 'único') return -1;
            if (numA === 'caput') return -1;
            if (numB === 'caput') return 1;
            if (numA === '') return 1;
            if (numB === '') return -1;
            
            return String(numA).localeCompare(String(numB));
        });
        
        paragrafosOrdenados.forEach(p => {
            const paragrafoDiv = document.createElement("div");
            paragrafoDiv.className = "paragrafo";
            
            const conteudo = p.conteudo || '';
            
            // Verificar se é HTML
            const numeroLabel = String(p.numero).toLowerCase() === "caput" ? "" : `§ ${p.numero} `;

            if (conteudo.includes('<') && conteudo.includes('>')) {
                paragrafoDiv.innerHTML = `${numeroLabel ? `<strong>${numeroLabel}</strong>` : ""}${conteudo}`;
            } else {
                if (numeroLabel) {
                    const strong = document.createElement("strong");
                    strong.textContent = numeroLabel;
                    paragrafoDiv.appendChild(strong);
                }
                paragrafoDiv.appendChild(document.createTextNode(conteudo));
            }
            
            divArtigo.appendChild(paragrafoDiv);
            
            // Processar alíneas
            if (p.alineas && typeof p.alineas === 'object' && Object.keys(p.alineas).length > 0) {
                const ul = document.createElement("ul");
                ul.className = "alineas";
                
                const letras = Object.keys(p.alineas).sort((a, b) => a.localeCompare(b));
                letras.forEach(letra => {
                    const li = document.createElement("li");
                    const conteudoAlinea = p.alineas[letra] || '';
                    
                    if (conteudoAlinea.includes('<') && conteudoAlinea.includes('>')) {
                        li.innerHTML = `<strong>${letra})</strong> ${conteudoAlinea}`;
                    } else {
                        const strong = document.createElement("strong");
                        strong.textContent = `${letra}) `;
                        li.appendChild(strong);
                        li.appendChild(document.createTextNode(conteudoAlinea));
                    }
                    
                    ul.appendChild(li);
                });
                
                divArtigo.appendChild(ul);
            }
        });
    }
    
    // Botão de remissão
    const btnRemissao = document.createElement("button");
    btnRemissao.className = "remissao-btn";
    btnRemissao.textContent = "🔗 Remissões";
    btnRemissao.onclick = () => mostrarRemissao(art.numero);
    divArtigo.appendChild(btnRemissao);
    
    container.appendChild(divArtigo);
}

function renderizarConteudoBruto(container, legislacao) {
    const wrapper = document.createElement("div");
    wrapper.className = "legislacao-conteudo-bruto";
    
    // Tentar parsear se for string com tags HTML
    if (legislacao.conteudo.includes('<') && legislacao.conteudo.includes('>')) {
        wrapper.innerHTML = legislacao.conteudo;
    } else {
        // Se for texto puro, dividir em parágrafos
        const linhas = legislacao.conteudo.split('\n');
        linhas.forEach(linha => {
            if (linha.trim()) {
                const p = document.createElement("p");
                p.textContent = linha;
                wrapper.appendChild(p);
            }
        });
    }
    
    container.appendChild(wrapper);
}

function renderizarFundamentacao(container, legislacao) {
    if (legislacao.fundamentacao && legislacao.fundamentacao.trim() !== "") {
        const fundamentacaoDiv = document.createElement("div");
        fundamentacaoDiv.classList.add("fundamentacao-container");
        
        const titulo = document.createElement("h2");
        titulo.textContent = "Fundamentação";
        fundamentacaoDiv.appendChild(titulo);
        
        const texto = document.createElement("div");
        texto.classList.add("fundamentacao-texto");
        
        // Verificar se é HTML
        if (legislacao.fundamentacao.includes('<') && legislacao.fundamentacao.includes('>')) {
            texto.innerHTML = legislacao.fundamentacao;
        } else {
            texto.textContent = legislacao.fundamentacao;
        }
        
        fundamentacaoDiv.appendChild(texto);
        container.appendChild(fundamentacaoDiv);
    }
}

// =============================================
// FUNÇÕES DE REMISSÃO
// =============================================

window.mostrarRemissao = function (numeroArtigo) {
    const legislacaoIdAtual = localStorage.getItem("legislacaoAtual");
    const nomeLegislacaoAtual = legislacaoGlobal?.nome || "Legislação atual";

    const overlay = document.createElement("div");
    overlay.className = "remissao-overlay";

    const menu = document.createElement("div");
    menu.className = "remissao-container";

    const titulo = document.createElement("h3");
    titulo.textContent = `Artigo ${numeroArtigo}`;
    menu.appendChild(titulo);

    const info = document.createElement("p");
    info.style.margin = "4px 0 12px";
    info.style.color = "#555";
    info.textContent = `${nomeLegislacaoAtual} (${legislacaoIdAtual || "ID desconhecido"})`;
    menu.appendChild(info);

    const btnCriar = document.createElement("button");
    btnCriar.textContent = "Criar remissão (neste diploma)";
    btnCriar.onclick = () => {
        document.body.removeChild(menu);
        document.body.removeChild(overlay);
        abrirModalCriarRemissao(numeroArtigo);
    };
    menu.appendChild(btnCriar);

    const btnCriarExterna = document.createElement("button");
    btnCriarExterna.textContent = "Criar remissão em outro diploma";
    btnCriarExterna.onclick = () => {
        document.body.removeChild(menu);
        document.body.removeChild(overlay);
        abrirModalCriarRemissao(numeroArtigo, { externa: true });
    };
    menu.appendChild(btnCriarExterna);

    const btnMostrar = document.createElement("button");
    btnMostrar.textContent = "Mostrar remissões";
    btnMostrar.onclick = () => {
        document.body.removeChild(menu);
        document.body.removeChild(overlay);
        exibirRemissoesDoArtigo(numeroArtigo);
    };
    menu.appendChild(btnMostrar);

    const btnFechar = document.createElement("button");
    btnFechar.textContent = "Cancelar";
    btnFechar.onclick = () => {
        document.body.removeChild(menu);
        document.body.removeChild(overlay);
    };
    menu.appendChild(btnFechar);

    document.body.appendChild(overlay);
    document.body.appendChild(menu);
};

const cacheLegislacoesRemissao = new Map();

async function carregarLegislacaoParaRemissao(legislacaoId) {
    if (!legislacaoId) return null;
    const atualId = localStorage.getItem("legislacaoAtual");
    if (legislacaoId === atualId && legislacaoGlobal) return legislacaoGlobal;
    if (cacheLegislacoesRemissao.has(legislacaoId)) {
        return cacheLegislacoesRemissao.get(legislacaoId);
    }

    const response = await authenticatedFetch(`${API_URL}/legislacoes/${encodeURIComponent(legislacaoId)}`);
    if (!response.ok) return null;
    const data = normalizarLegislacao(await response.json());
    cacheLegislacoesRemissao.set(legislacaoId, data);
    return data;
}

async function carregarListaLegislacoes() {
    const cacheRaw = localStorage.getItem("legislacoes_cache");
    if (cacheRaw) {
        try {
            const parsed = JSON.parse(cacheRaw);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        } catch (_) {
            // ignore cache invalido
        }
    }

    const response = await authenticatedFetch(`${API_URL}/legislacoes`);
    if (!response.ok) return [];
    return response.json();
}

function montarMapaArtigos(legislacao) {
    const artigosValidos = {};
    if (legislacao && Array.isArray(legislacao.artigos)) {
        legislacao.artigos.forEach((art) => {
            if (art && art.numero !== undefined && art.numero !== null) {
                artigosValidos[String(art.numero)] = true;
            }
        });
    }
    return artigosValidos;
}

async function abrirModalCriarRemissao(numeroArtigoAtual, options = {}) {
    const { externa = false } = options;
    const legislacaoIdAtual = localStorage.getItem("legislacaoAtual");
    let legislacaoDestinoId = legislacaoIdAtual;
    let legislacaoDestino = legislacaoGlobal;
    let artigosValidos = montarMapaArtigos(legislacaoDestino);

    const overlay = document.createElement("div");
    overlay.className = "remissao-overlay";

    const modal = document.createElement("div");
    modal.className = "remissao-container";

    const titulo = document.createElement("h3");
    titulo.textContent = `Nova remissão do Artigo ${numeroArtigoAtual}`;
    modal.appendChild(titulo);

    let selectLegislacao = null;
    if (externa) {
        const label = document.createElement("label");
        label.textContent = "Diploma de destino";
        modal.appendChild(label);

        selectLegislacao = document.createElement("select");
        selectLegislacao.style.marginBottom = "8px";
        modal.appendChild(selectLegislacao);

        const legislacoes = await carregarListaLegislacoes();
        selectLegislacao.innerHTML = "";
        let firstOptionId = legislacaoIdAtual;

        if (legislacoes.length === 0 && legislacaoIdAtual) {
            const opt = document.createElement("option");
            opt.value = legislacaoIdAtual;
            opt.textContent = legislacaoGlobal?.nome || legislacaoIdAtual;
            selectLegislacao.appendChild(opt);
        } else {
            legislacoes.forEach((leg) => {
                const opt = document.createElement("option");
                opt.value = leg.id;
                opt.textContent = leg.nome || leg.id;
                if (!firstOptionId || firstOptionId === legislacaoIdAtual) {
                    if (leg.id !== legislacaoIdAtual) firstOptionId = leg.id;
                }
                selectLegislacao.appendChild(opt);
            });
        }

        if (firstOptionId) {
            selectLegislacao.value = firstOptionId;
            legislacaoDestinoId = firstOptionId;
        }

        selectLegislacao.addEventListener("change", async () => {
            legislacaoDestinoId = selectLegislacao.value;
            legislacaoDestino = await carregarLegislacaoParaRemissao(legislacaoDestinoId);
            artigosValidos = montarMapaArtigos(legislacaoDestino);
            validarArtigoDestino();
        });

        legislacaoDestino = await carregarLegislacaoParaRemissao(legislacaoDestinoId);
        artigosValidos = montarMapaArtigos(legislacaoDestino);
    }

    const inputArtigo = document.createElement("input");
    inputArtigo.type = "text";
    inputArtigo.placeholder = "Número do artigo";
    modal.appendChild(inputArtigo);

    const inputComentario = document.createElement("textarea");
    inputComentario.placeholder = "Comentário (opcional)";
    modal.appendChild(inputComentario);

    const validacao = document.createElement("div");
    validacao.className = "validacao-artigo";
    modal.appendChild(validacao);

    const btnConfirmar = document.createElement("button");
    btnConfirmar.textContent = "Confirmar";
    btnConfirmar.disabled = true;
    modal.appendChild(btnConfirmar);

    const btnCancelar = document.createElement("button");
    btnCancelar.textContent = "Cancelar";
    btnCancelar.onclick = () => {
        document.body.removeChild(modal);
        document.body.removeChild(overlay);
    };
    modal.appendChild(btnCancelar);

    function validarArtigoDestino() {
        const valor = inputArtigo.value.trim();
        if (valor && artigosValidos[valor]) {
            validacao.textContent = "✔ Artigo válido";
            validacao.style.color = "green";
            btnConfirmar.disabled = false;
        } else {
            validacao.textContent = "✖ Artigo não encontrado";
            validacao.style.color = "red";
            btnConfirmar.disabled = true;
        }
    }

    inputArtigo.addEventListener("input", validarArtigoDestino);
    validarArtigoDestino();

    btnConfirmar.onclick = () => {
        adicionarRemissao(
            numeroArtigoAtual,
            inputArtigo.value.trim(),
            inputComentario.value.trim(),
            legislacaoDestinoId
        );
        document.body.removeChild(modal);
        document.body.removeChild(overlay);
    };

    document.body.appendChild(overlay);
    document.body.appendChild(modal);
}

window.adicionarRemissao = function (numeroArtigo, numeroRemissao, comentario, legislacaoDestinoId) {
    adicionarRemissaoApi(numeroArtigo, numeroRemissao, comentario, legislacaoDestinoId);
};

async function exibirRemissoesDoArtigo(numeroArtigoAtual) {
    const legislacaoId = localStorage.getItem("legislacaoAtual");

    const overlay = document.createElement("div");
    overlay.className = "remissao-overlay";
    
    const container = document.createElement("div");
    container.className = "remissao-container";

    const titulo = document.createElement("h3");
    titulo.textContent = `Remissões do Artigo ${numeroArtigoAtual}`;
    container.appendChild(titulo);

    const lista = document.createElement("div");
    lista.className = "remissoes-lista";
    lista.innerHTML = "<p>A carregar remissões...</p>";
    container.appendChild(lista);

    const fecharBtn = document.createElement("button");
    fecharBtn.textContent = "Fechar";
    fecharBtn.addEventListener("click", () => {
        document.body.removeChild(container);
        document.body.removeChild(overlay);
    });
    container.appendChild(fecharBtn);

    document.body.appendChild(overlay);
    document.body.appendChild(container);

    try {
        const rows = await buscarRemissoes(numeroArtigoAtual, legislacaoId);
        if (!rows.length) {
            lista.innerHTML = "<p>Sem remissões para este artigo.</p>";
            return;
        }

        lista.innerHTML = "";
        rows.forEach((item) => {
            const div = document.createElement("div");
            div.className = "remissao-item";
            div.innerHTML = `
                <strong>${item.lei_origem || ''} - Art. ${item.artigo_origem}</strong>
                <p>Remete para: ${item.lei_destino || ''} - Art. ${item.artigo_destino}</p>
                ${item.comentario ? `<p><em>${item.comentario}</em></p>` : ''}
            `;
            lista.appendChild(div);
        });
    } catch (error) {
        console.error("Erro ao listar remissões:", error);
        lista.innerHTML = "<p>Erro ao carregar remissões.</p>";
    }
}

async function registrarHistoricoLegislacao(legislacaoId, titulo) {
    try {
        await authenticatedFetch(`${API_URL}/historico/legislacoes`, {
            method: "POST",
            body: JSON.stringify({
                legislacaoId,
                titulo
            })
        });
    } catch (error) {
        console.error("Erro ao registrar histórico de legislação:", error);
    }
}

async function buscarRemissoes(artigoOrigem, legislacaoId) {
    const params = new URLSearchParams();
    if (legislacaoId) params.set("legislacaoId", legislacaoId);
    if (artigoOrigem) params.set("artigoOrigem", String(artigoOrigem));

    const response = await authenticatedFetch(`${API_URL}/remissoes/me?${params.toString()}`);
    if (!response.ok) return [];
    return response.json();
}

async function adicionarRemissaoApi(numeroArtigo, numeroRemissao, comentario, legislacaoDestinoId) {
    try {
        const legislacaoId = localStorage.getItem("legislacaoAtual");
        const payload = {
            legislacaoOrigemId: legislacaoId,
            artigoOrigem: String(numeroArtigo),
            legislacaoDestinoId: legislacaoDestinoId || legislacaoId,
            artigoDestino: String(numeroRemissao),
            comentario: comentario || ''
        };

        const response = await authenticatedFetch(`${API_URL}/remissoes`, {
            method: "POST",
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const msg = await response.text();
            throw new Error(msg || `HTTP ${response.status}`);
        }

        await marcarArtigosComRemissoes(legislacaoId);
        alert("Remissão guardada com sucesso.");
    } catch (error) {
        console.error("Erro ao guardar remissão:", error);
        alert("Erro ao guardar remissão.");
    }
}

async function marcarArtigosComRemissoes(legislacaoId) {
    try {
        const rows = await buscarRemissoes(null, legislacaoId);
        const artigosComRemissao = new Set(rows.map((r) => String(r.artigo_origem)));

        document.querySelectorAll(".artigo-item").forEach((artEl) => {
            const id = artEl.id || "";
            const numero = id.replace("artigo-", "");
            if (artigosComRemissao.has(numero)) {
                artEl.classList.add("has-remissao");
            } else {
                artEl.classList.remove("has-remissao");
            }
        });
    } catch (error) {
        console.error("Erro ao marcar artigos com remissão:", error);
    }
}

// =============================================
// FUNÇÕES UTILITÁRIAS
// =============================================

function realizarPesquisa() {
    const termoRaw = document.getElementById("search").value.trim();
    const termo = termoRaw.toLowerCase();
    const artPrefixMatch = termo.match(/^art(?:igo)?\.?\s*(.*)$/);
    const termoParaNumeros = artPrefixMatch ? artPrefixMatch[1].trim() : termo;
    const artigos = document.querySelectorAll(".artigo-item");
    const estruturas = document.querySelectorAll(".estrutura-item");

    if (!termo) {
        artigos.forEach((artigo) => { artigo.style.display = "block"; });
        estruturas.forEach((estrutura) => { estrutura.style.display = "block"; });
        return;
    }

    const matchIntervalo = termoParaNumeros.match(/^(\d+)\s*-\s*(\d+)$/);
    const matchLista = termoParaNumeros.match(/^\s*\d+(?:\s*[;,]\s*\d+)+\s*$/);
    const matchCombo = termoParaNumeros.match(/^\s*\d+(?:\s*-\s*\d+)?(?:\s*[;,]\s*\d+(?:\s*-\s*\d+)?)+\s*$/);
    const matchNumero = termoParaNumeros.match(/^\d+$/);

    if (matchIntervalo) {
        let inicio = Number(matchIntervalo[1]);
        let fim = Number(matchIntervalo[2]);
        if (Number.isNaN(inicio) || Number.isNaN(fim)) {
            return;
        }
        if (inicio > fim) {
            const tmp = inicio;
            inicio = fim;
            fim = tmp;
        }
        artigos.forEach((artigo) => {
            const numeroRaw = (artigo.id || "").replace("artigo-", "");
            const numero = Number(numeroRaw);
            const visivel = !Number.isNaN(numero) && numero >= inicio && numero <= fim;
            artigo.style.display = visivel ? "block" : "none";
        });
        estruturas.forEach((estrutura) => {
            estrutura.style.display = "none";
        });
        return;
    }

    if (matchLista) {
        const numerosAlvo = new Set(
            termoParaNumeros
                .split(/[;,]/)
                .map((parte) => parte.trim())
                .filter(Boolean)
                .map((n) => Number(n))
                .filter((n) => !Number.isNaN(n))
                .map((n) => String(n))
        );

        artigos.forEach((artigo) => {
            const numero = (artigo.id || "").replace("artigo-", "");
            artigo.style.display = numerosAlvo.has(numero) ? "block" : "none";
        });
        estruturas.forEach((estrutura) => {
            estrutura.style.display = "none";
        });
        return;
    }

    if (matchCombo) {
        const numerosAlvo = new Set();
        termoParaNumeros.split(/[;,]/).forEach((parte) => {
            const item = parte.trim();
            if (!item) return;
            const intervalo = item.match(/^(\d+)\s*-\s*(\d+)$/);
            if (intervalo) {
                let inicio = Number(intervalo[1]);
                let fim = Number(intervalo[2]);
                if (Number.isNaN(inicio) || Number.isNaN(fim)) return;
                if (inicio > fim) {
                    const tmp = inicio;
                    inicio = fim;
                    fim = tmp;
                }
                for (let n = inicio; n <= fim; n += 1) {
                    numerosAlvo.add(String(n));
                }
                return;
            }
            const numero = Number(item);
            if (!Number.isNaN(numero)) {
                numerosAlvo.add(String(numero));
            }
        });

        artigos.forEach((artigo) => {
            const numero = (artigo.id || "").replace("artigo-", "");
            artigo.style.display = numerosAlvo.has(numero) ? "block" : "none";
        });
        estruturas.forEach((estrutura) => {
            estrutura.style.display = "none";
        });
        return;
    }

    if (matchNumero) {
        const numeroAlvo = matchNumero[0];
        artigos.forEach((artigo) => {
            const numero = (artigo.id || "").replace("artigo-", "");
            artigo.style.display = numero === numeroAlvo ? "block" : "none";
        });
        estruturas.forEach((estrutura) => {
            estrutura.style.display = "none";
        });
        return;
    }

    artigos.forEach((artigo) => {
        artigo.style.display = artigo.textContent.toLowerCase().includes(termo) ? "block" : "none";
    });
    estruturas.forEach((estrutura) => {
        estrutura.style.display = estrutura.textContent.toLowerCase().includes(termo) ? "block" : "none";
    });
}

// Botão de voltar ao topo
const btnTopo = document.createElement("button");
btnTopo.id = "btn-topo";
btnTopo.title = "Voltar ao topo";
btnTopo.innerHTML = `<i class="fas fa-arrow-up"></i>`;
document.body.appendChild(btnTopo);

btnTopo.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
});

// Salvar posição de leitura
function salvarPosicaoLeitura() {
    const legislacaoKey = localStorage.getItem("legislacaoAtual");
    if (legislacaoKey) {
        const posY = window.scrollY;
        localStorage.setItem(`scrollPos_${legislacaoKey}`, posY);
    }
}

window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        salvarPosicaoLeitura();
    }
});

window.addEventListener("beforeunload", () => {
    salvarPosicaoLeitura();
});

// Restaurar posição de leitura
function restaurarScroll(legislacaoKey, activeDocumentState = null) {
    if (activeDocumentState && typeof activeDocumentState.scrollY === 'number') {
        setTimeout(() => {
            window.scrollTo(0, activeDocumentState.scrollY);
            console.log(`🔁 Posição restaurada do documento activo: ${activeDocumentState.scrollY}px`);
        }, 100);
        return;
    }

    const posYSalva = localStorage.getItem(`scrollPos_${legislacaoKey}`);
    if (posYSalva) {
        setTimeout(() => {
            window.scrollTo(0, parseFloat(posYSalva));
            console.log(`🔁 Posição restaurada: ${posYSalva}px`);
        }, 100);
    }
}

function restaurarZoom(activeDocumentState = null) {
    const zoomLevel = activeDocumentState?.zoom || 1;
    if (zoomLevel && zoomLevel !== 1 && document.body) {
        document.body.style.zoom = zoomLevel;
    }
}

export async function initializeLeitor(activeDocumentState = null) {
    await carregarLegislacao(activeDocumentState);
}

export function getCurrentLeitorContext() {
    const scrollY = window.scrollY;
    const zoom = window.visualViewport?.scale || parseFloat(document.body.style.zoom) || 1;
    const articleElement = Array.from(document.querySelectorAll('.artigo-item')).reverse()
        .find((node) => node.getBoundingClientRect().top <= 120) || document.querySelector('.artigo-item');
    const sectionElement = Array.from(document.querySelectorAll('.estrutura-item h3')).reverse()
        .find((node) => node.getBoundingClientRect().top <= 120);

    const article = articleElement?.id ? articleElement.id.replace(/^artigo-/, '') : articleElement?.querySelector('h4')?.textContent || '';
    const section = sectionElement?.textContent || '';

    return {
        scrollY,
        zoom,
        section,
        article,
        lastUsed: Date.now(),
    };
}

// =============================================
// INICIALIZAÇÃO
// =============================================

document.addEventListener("DOMContentLoaded", () => {
    carregarLegislacao();
});

// Para debug - expor globalmente
window.legislacaoGlobal = legislacaoGlobal;
