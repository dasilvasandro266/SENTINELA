const urlParams = new URLSearchParams(window.location.search);
const pdfUrl = urlParams.get('pdf');
const loadingScreen = document.getElementById('loading-screen');
const container = document.getElementById('pdf-container');

const handleError = (message, error = null) => {
    console.error(message, error || '');
    alert(message);
    if (loadingScreen) {
        loadingScreen.classList.remove('active');
        loadingScreen.style.display = 'none';
    }
    throw new Error(message);
};

if (!pdfUrl) {
    handleError('Nenhum arquivo PDF foi fornecido. Adicione um parâmetro "pdf" à URL.');
}

let pdfInstance = null;
let pageRenderStatus = {}; // Armazena quais páginas já foram renderizadas

const loadPDF = async () => {
    console.log("Tentando carregar o PDF:", pdfUrl);

    try {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
        pdfInstance = await pdfjsLib.getDocument(pdfUrl).promise;

        if (!pdfInstance) {
            throw new Error("Falha ao carregar o PDF.");
        }

        console.log("PDF carregado com sucesso:", pdfInstance);
        createPagePlaceholders(pdfInstance.numPages);
    } catch (error) {
        handleError("Erro ao carregar o PDF. Verifique se o arquivo existe e é acessível.", error);
    }
};

const createPagePlaceholders = (totalPages) => {
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const pageDiv = document.createElement('div');
        pageDiv.classList.add('pdf-page');
        pageDiv.dataset.page = pageNum;
        pageDiv.style.minHeight = "800px"; // Espaço reservado para cada página
        container.appendChild(pageDiv);
    }

    observePages();
};

const renderPage = async (pageNum) => {
    if (pageRenderStatus[pageNum]) return; // Evita re-renderização

    try {
        const page = await pdfInstance.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const scale = container.offsetWidth / viewport.width;
        const scaledViewport = page.getViewport({ scale });

        const pageDiv = document.querySelector(`.pdf-page[data-page='${pageNum}']`);
        if (!pageDiv) return;

        pageDiv.style.width = `${scaledViewport.width}px`;
        pageDiv.style.height = `${scaledViewport.height}px`;

        const canvas = document.createElement('canvas');
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        pageDiv.appendChild(canvas);

        await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
        pageRenderStatus[pageNum] = true; // Marca a página como renderizada
    } catch (error) {
        handleError(`Erro ao renderizar a página ${pageNum}.`, error);
    }
};

const observePages = () => {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const pageNum = parseInt(entry.target.dataset.page);
                renderPage(pageNum);
            }
        });
    }, { rootMargin: "50px 0px" });

    document.querySelectorAll('.pdf-page').forEach(pageDiv => observer.observe(pageDiv));

    loadingScreen.classList.remove('active');
    loadingScreen.style.display = 'none';
    container.classList.add('visible');
};

window.onload = async () => {
    if (!container) {
        return handleError("Elemento do contêiner de PDF não encontrado no DOM.");
    }

    let attempts = 0;
    const maxAttempts = 20;

    const checkContainer = setInterval(() => {
        if (container.offsetWidth > 0 || attempts >= maxAttempts) {
            clearInterval(checkContainer);
            if (container.offsetWidth > 0) {
                container.style.visibility = "visible";
                container.style.marginTop = "0";
                loadPDF();
            } else {
                handleError("Falha ao detectar tamanho do contêiner. O layout pode estar incorreto.");
            }
        }
        attempts++;
    }, 100);
};

let lastWidth = container.offsetWidth;

window.addEventListener('resize', () => {
    if (container.offsetWidth !== lastWidth) {
        lastWidth = container.offsetWidth;
        pageRenderStatus = {}; // Reseta páginas renderizadas
        document.querySelectorAll('.pdf-page').forEach(page => (page.innerHTML = ""));
        observePages(); // Reinicia o observer
    }
});