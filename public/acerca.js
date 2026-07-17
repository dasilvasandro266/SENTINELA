import { authenticatedFetch } from "./authManager.js";

function normalizarGestores(gestoresData) {
    if (!gestoresData) return [];
    if (Array.isArray(gestoresData)) return gestoresData.filter(Boolean);
    return Object.values(gestoresData);
}

function normalizarNomeAutor(nome = "") {
    return String(nome)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

let conteudosPorAutor = new Map();
let gestoresCache = [];
let grupoAtivo = 'colegio';

function renderGestoresCarousel(items) {
    const stage = document.getElementById('gestoresCarousel');
    if (!stage) return;
    stage.innerHTML = '';

    if (!items.length) {
        stage.innerHTML = '<p style="text-align:center; color:#aaa; width:100%;">Nenhum gestor encontrado.</p>';
        return;
    }

    items.forEach((gestor) => {
        const card = document.createElement('article');
        card.className = 'gestor';

        const img = document.createElement('img');
        img.src = gestor.imagem;
        img.alt = `Foto de ${gestor.nome}`;
        img.onerror = function() {
            this.src = 'https://via.placeholder.com/300x360/1a1a1a/darkmagenta?text=Sem+Imagem';
        };
        card.appendChild(img);

        const nome = document.createElement('h3');
        nome.textContent = gestor.nome;
        card.appendChild(nome);

        const descricao = document.createElement('p');
        descricao.textContent = gestor.descricao;
        card.appendChild(descricao);

        card.addEventListener('click', () => {
            if (stage.classList.contains('dragging')) return;
            abrirModalGestor(gestor);
        });

        stage.appendChild(card);
    });

    initCarousel(stage, items.length);
}

function initCarousel(stage, totalItems, radius = 420, autoRotateSpeed = 0.02) {
    if (!stage || totalItems === 0) return;
    const cards = Array.from(stage.children);
    const anglePerItem = 360 / totalItems;
    const rotationOffset = 0;
    let rotation = 0;
    let isScrolling = false;
    let scrollTimeout = null;
    let animationFrame = null;
    let isDragging = false;
    let startX = 0;
    let startRotation = 0;

    const computeRadius = () => {
        const base = Math.max(220, Math.min(radius, (stage.clientWidth / 2) - 40));
        return Number.isFinite(base) ? base : radius;
    };

    const update = () => {
        const currentRadius = computeRadius();
        cards.forEach((card, i) => {
            const baseAngle = i * anglePerItem;
            const angle = baseAngle + rotation + rotationOffset;
            const relative = ((angle % 360) + 360) % 360;
            const normalized = Math.abs(relative > 180 ? 360 - relative : relative);
            const opacity = Math.max(0.3, 1 - (normalized / 180));
            const scale = 0.85 + (opacity * 0.15);
            card.style.transform = `rotateY(${angle}deg) translateZ(${currentRadius}px) rotateY(${-angle}deg) scale(${scale})`;
            card.style.opacity = opacity;
        });
    };

    const handleScroll = () => {
        isScrolling = true;
        if (scrollTimeout) clearTimeout(scrollTimeout);

        const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
        const scrollProgress = scrollableHeight > 0 ? window.scrollY / scrollableHeight : 0;
        rotation = scrollProgress * 360;
        update();

        scrollTimeout = setTimeout(() => {
            isScrolling = false;
        }, 150);
    };

    const autoRotate = () => {
        if (!isScrolling) {
            rotation += autoRotateSpeed;
            update();
        }
        animationFrame = requestAnimationFrame(autoRotate);
    };

    const onPointerDown = (e) => {
        isDragging = true;
        stage.classList.add('dragging');
        startX = e.clientX;
        startRotation = rotation;
    };

    const onPointerMove = (e) => {
        if (!isDragging) return;
        const deltaX = e.clientX - startX;
        rotation = startRotation + (deltaX * 0.2);
        update();
    };

    const onPointerUp = () => {
        isDragging = false;
        stage.classList.remove('dragging');
    };

    const prevBtn = document.getElementById('gestoresPrev');
    const nextBtn = document.getElementById('gestoresNext');
    if (prevBtn) prevBtn.addEventListener('click', () => { rotation -= anglePerItem; update(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { rotation += anglePerItem; update(); });

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', update);
    stage.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    update();
    animationFrame = requestAnimationFrame(autoRotate);
}

function criarModalGestor() {
    if (document.getElementById('gestorModal')) return;
    const modal = document.createElement('div');
    modal.id = 'gestorModal';
    modal.className = 'gestor-modal hidden';
    modal.innerHTML = `
        <div class="gestor-modal-content" role="dialog" aria-modal="true" aria-labelledby="gestorModalTitulo">
            <button class="gestor-fechar" type="button" aria-label="Fechar">&times;</button>
            <div class="gestor-modal-header">
                <img class="gestor-modal-foto" alt="" />
                <div>
                    <h3 id="gestorModalTitulo" class="gestor-modal-nome"></h3>
                    <p class="gestor-modal-desc"></p>
                </div>
            </div>
            <div class="gestor-modal-textos">
                <h4>Textos publicados</h4>
                <ul class="gestor-modal-textos-list"></ul>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.classList.contains('gestor-fechar')) {
            modal.classList.add('hidden');
        }
    });
}

function abrirModalGestor(gestor) {
    if (!gestor) return;
    criarModalGestor();
    const modal = document.getElementById('gestorModal');
    if (!modal) return;

    const foto = modal.querySelector('.gestor-modal-foto');
    const nome = modal.querySelector('.gestor-modal-nome');
    const desc = modal.querySelector('.gestor-modal-desc');
    const lista = modal.querySelector('.gestor-modal-textos-list');

    if (foto) {
        foto.src = gestor.imagem || '/images/virtruviano2.png';
        foto.alt = gestor.nome ? `Foto de ${gestor.nome}` : 'Foto do gestor';
        foto.onerror = function() {
            this.src = '/images/virtruviano2.png';
        };
    }
    if (nome) nome.textContent = gestor.nome || '';
    if (desc) desc.textContent = gestor.descricao || '';

    if (lista) {
        lista.innerHTML = '';
        const textos = conteudosPorAutor.get(normalizarNomeAutor(gestor.nome)) || [];
        if (!textos.length) {
            const item = document.createElement('li');
            item.textContent = 'Sem textos publicados ainda.';
            lista.appendChild(item);
        } else {
            textos.forEach((texto) => {
                const item = document.createElement('li');
                item.textContent = `${texto.tema} • ${texto.fase}`;
                lista.appendChild(item);
            });
        }
    }

    modal.classList.remove('hidden');
}

async function carregarGestoresLocal() {
    try {
        const response = await fetch('/gestores.json', { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const items = normalizarGestores(data);
        if (items.length) {
            gestoresCache = items;
            aplicarFiltro(grupoAtivo);
            return;
        }
        throw new Error('Sem dados');
    } catch (error) {
        const stage = document.getElementById('gestoresCarousel');
        if (stage) {
            stage.innerHTML = '<p style="text-align:center; color:#aaa; width:100%;">Nenhum gestor encontrado.</p>';
        }
    }
}

function aplicarFiltro(grupo) {
    grupoAtivo = grupo;
    const filtrados = gestoresCache.filter((gestor) => {
        if (!gestor?.grupo) return grupo === 'associados';
        return String(gestor.grupo).toLowerCase() === grupo;
    });
    renderGestoresCarousel(filtrados);
    document.querySelectorAll('.gestores-filtro').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.grupo === grupoAtivo);
    });
}

async function carregarConteudosAutores() {
    try {
        const response = await authenticatedFetch('/api/home/conteudos-autores');
        if (!response.ok) return;
        const data = await response.json();
        conteudosPorAutor = new Map();
        (data.items || []).forEach((item) => {
            const autores = Array.isArray(item.autores) ? item.autores : [];
            autores.forEach((autor) => {
                const key = normalizarNomeAutor(autor);
                if (!key) return;
                const lista = conteudosPorAutor.get(key) || [];
                lista.push(item);
                conteudosPorAutor.set(key, lista);
            });
        });
    } catch (error) {
        console.warn('Falha ao carregar textos por autor:', error);
    }
}

(async () => {
    await carregarConteudosAutores();
    await carregarGestoresLocal();
    document.querySelectorAll('.gestores-filtro').forEach((btn) => {
        btn.addEventListener('click', () => aplicarFiltro(btn.dataset.grupo));
    });
})();
