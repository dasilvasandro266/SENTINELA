export default class ActiveDocumentsUI {
  constructor(manager) {
    this.manager = manager;
    this.container = null;
    this.panel = null;
    this.countBadge = null;
    this.listElement = null;
    this.summaryText = null;
    this.limitWarning = null;
    this.openButton = null;
    this.isOpen = false;
    this.unsubscribe = null;
  }

  async mount() {
    if (!this.manager || !this.manager.isEnabled()) return;
    this.injectStyles();
    this.buildUI();
    this.unsubscribe = await this.manager.subscribe(() => this.update());
    await this.update();
    this.initEvents();
  }

  injectStyles() {
    if (document.querySelector('link[href="/active-documents.css"]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/active-documents.css';
    document.head.appendChild(link);
  }

  buildUI() {
    if (this.container) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'active-documents-widget';
    wrapper.innerHTML = `
      <button type="button" class="active-documents-toggle" aria-label="Documentos Activos" id="activeDocumentsToggle">
        <span class="active-documents-icon">📚</span>
        <span class="active-documents-count" id="activeDocumentsCount">0</span>
      </button>
      <div class="active-documents-panel hidden" id="activeDocumentsPanel" role="dialog" aria-label="Workspace Jurídico">
        <div class="active-documents-header">
          <div>
            <strong>Workspace Jurídico</strong>
            <div class="active-documents-subtitle">Documentos activos</div>
          </div>
          <button type="button" class="active-documents-close" id="activeDocumentsClose">×</button>
        </div>
        <div class="active-documents-summary" id="activeDocumentsSummary"></div>
        <div class="active-documents-summary-section hidden" id="activeDocumentsSummarySection">
          <strong>Resumos da Formação</strong>
          <div class="active-documents-summary-list" id="activeDocumentsSummaryList"></div>
        </div>
        <div class="active-documents-list" id="activeDocumentsList"></div>
        <div class="active-documents-actions">
          <button type="button" class="btn-secondary small" id="activeDocumentsCloseOthers">Fechar outros</button>
          <button type="button" class="btn-secondary small" id="activeDocumentsCloseAll">Fechar todos</button>
        </div>
        <div class="active-documents-warning hidden" id="activeDocumentsWarning"></div>
      </div>
    `;
    document.body.appendChild(wrapper);
    this.container = wrapper;
    this.openButton = wrapper.querySelector('#activeDocumentsToggle');
    this.panel = wrapper.querySelector('#activeDocumentsPanel');
    this.countBadge = wrapper.querySelector('#activeDocumentsCount');
    this.listElement = wrapper.querySelector('#activeDocumentsList');
    this.summaryText = wrapper.querySelector('#activeDocumentsSummary');
    this.limitWarning = wrapper.querySelector('#activeDocumentsWarning');
    this.closeButton = wrapper.querySelector('#activeDocumentsClose');
    this.closeOthersButton = wrapper.querySelector('#activeDocumentsCloseOthers');
    this.closeAllButton = wrapper.querySelector('#activeDocumentsCloseAll');
  }

  initEvents() {
    if (!this.openButton || !this.closeButton) return;
    this.openButton.addEventListener('click', () => this.togglePanel());
    this.closeButton.addEventListener('click', () => this.closePanel());
    this.closeOthersButton.addEventListener('click', () => this.closeOthers());
    this.closeAllButton.addEventListener('click', () => this.closeAll());
    if (this.listElement) {
      this.listElement.addEventListener('click', (event) => this.handleListClick(event));
    }
    document.addEventListener('click', (event) => {
      if (!this.isOpen) return;
      const target = event.target;
      if (this.container.contains(target)) return;
      this.closePanel();
    });
    document.addEventListener('keydown', (event) => {
      if (!this.isOpen || event.key !== 'Escape') return;
      this.closePanel();
    });
  }

  async update(limitHint = null) {
    const documents = await this.manager.getActiveDocuments();
    const count = documents.length;
    if (this.countBadge) this.countBadge.textContent = String(count);
    if (this.summaryText) {
      this.summaryText.textContent = count > 0
        ? `Existem ${count} documentos activos. Seleciona um para retomar.`
        : 'Não existem documentos activos no momento. Abra um documento para começar.';
    }

    if (this.listElement) {
      this.listElement.innerHTML = '';
      if (count === 0) {
        const empty = document.createElement('div');
        empty.className = 'active-documents-empty';
        empty.textContent = 'Sem documentos activos.';
        this.listElement.appendChild(empty);
      } else {
        const isMobile = window.matchMedia('(max-width: 780px)').matches;
        documents.forEach((doc) => {
          const item = document.createElement('div');
          item.className = 'active-document-item active-document-clickable';
          item.dataset.id = doc.id;
          item.innerHTML = `
            <div class="active-document-main">
              <div class="active-document-title">${escapeHtml(doc.title)}</div>
              <div class="active-document-meta">${escapeHtml(doc.type)} — ${formatPosition(doc.article, doc.section)}</div>
            </div>
            <div class="active-document-footer">
              <span>${new Date(doc.lastUsed).toLocaleString()}</span>
              <div class="active-document-actions">
                ${isMobile ? '' : `<button type="button" class="btn-secondary small" data-action="restore" data-id="${doc.id}">Retomar</button>`}
                <button type="button" class="btn-secondary small" data-action="close" data-id="${doc.id}">Fechar</button>
              </div>
            </div>
          `;
          this.listElement.appendChild(item);
        });
      }
    }

    if (limitHint && this.limitWarning) {
      this.limitWarning.classList.remove('hidden');
      this.limitWarning.innerHTML = limitHint;
    } else if (this.limitWarning) {
      this.limitWarning.classList.add('hidden');
      this.limitWarning.innerHTML = '';
    }

    this.updateHomeSummaries();
  }

  updateHomeSummaries() {
    const summarySection = document.getElementById('activeDocumentsSummarySection');
    const summaryList = document.getElementById('activeDocumentsSummaryList');
    if (!summarySection || !summaryList) return;

    const activeDocuments = this.listElement?.querySelectorAll('.active-document-item').length || 0;
    const summaries = this.collectHomeSummaries();
    summaryList.innerHTML = '';

    if (summaries.length === 0 || activeDocuments > 0) {
      summarySection.classList.add('hidden');
      return;
    }

    summarySection.classList.remove('hidden');
    summaries.forEach((summary) => {
      const item = document.createElement('div');
      item.className = 'active-summary-item';
      item.dataset.summaryId = summary.id;
      item.innerHTML = `
        <div class="active-document-main">
          <div class="active-document-title">${escapeHtml(summary.title)}</div>
          <div class="active-document-meta">Resumo de Formação</div>
        </div>
      `;
      summaryList.appendChild(item);
    });
  }

  collectHomeSummaries() {
    const cards = Array.from(document.querySelectorAll('.nivel-card[data-summary-id]'));
    return cards.map((card) => ({
      id: card.dataset.summaryId,
      title: card.querySelector('h3')?.textContent?.trim() || 'Resumo',
    }));
  }

  openHomeSummary(id) {
    const card = document.querySelector(`[data-summary-id="${id}"]`);
    const button = card?.querySelector('[data-summary-action="show"]');
    if (button) {
      button.click();
      return;
    }

    window.__workspacePendingSummaryId = id;
    window.history.pushState({}, '', '/app/home');
    window.dispatchEvent(new Event('popstate'));
  }

  handleListClick(event) {
    const button = event.target.closest('[data-action]');
    if (button) {
      const action = button.dataset.action;
      const id = button.dataset.id;
      if (!id) return;
      event.stopPropagation();
      if (action === 'restore') {
        this.closePanel();
        this.manager.setCurrentDocument(id)
          .then(() => this.manager.getDocument(id))
          .then((doc) => {
            if (doc) {
              window.history.pushState({}, '', doc.route + serializeParams(doc.params));
              window.dispatchEvent(new Event('popstate'));
            }
          })
          .catch((error) => console.error('Erro ao restaurar documento:', error));
      } else if (action === 'close') {
        this.manager.closeDocument(id)
          .then(() => this.update())
          .catch((error) => console.error('Erro ao fechar documento:', error));
      }
      return;
    }

    const summaryItem = event.target.closest('.active-summary-item');
    if (summaryItem) {
      const id = summaryItem.dataset.summaryId;
      if (!id) return;
      this.closePanel();
      this.openHomeSummary(id);
      return;
    }

    const docItem = event.target.closest('.active-document-item');
    if (docItem && docItem.dataset.id) {
      const id = docItem.dataset.id;
      this.closePanel();
      this.manager.setCurrentDocument(id)
        .then(() => this.manager.getDocument(id))
        .then((doc) => {
          if (doc) {
            const fullUrl = doc.route + serializeParams(doc.params);
            window.history.pushState({}, '', fullUrl);
            window.dispatchEvent(new Event('popstate'));
          }
        })
        .catch((error) => console.error('Erro ao abrir documento do Workspace:', error));
    }
  }

  async closeOthers() {
    const documents = await this.manager.getActiveDocuments();
    if (documents.length <= 1) return;
    await this.manager.closeOthers(documents[0].id);
    await this.update();
  }

  async closeAll() {
    await this.manager.closeAll();
    await this.update();
  }

  togglePanel() {
    this.isOpen ? this.closePanel() : this.openPanel();
  }

  openPanel() {
    if (!this.panel) return;
    this.panel.classList.add('open');
    this.panel.classList.remove('hidden');
    this.isOpen = true;
  }

  closePanel() {
    if (!this.panel) return;
    this.panel.classList.remove('open');
    this.panel.classList.add('hidden');
    this.isOpen = false;
  }

  showRestoreMessage(count) {
    if (!this.limitWarning) return;
    this.limitWarning.classList.remove('hidden');
    this.limitWarning.innerHTML = `Existem ${count} documentos activos. Abre o painel para retomar o teu Workspace Jurídico.`;
  }

  showLimitWarning(limit, oldest) {
    if (!this.limitWarning) return;
    const titles = oldest.map((doc) => escapeHtml(doc.title)).join(', ');
    this.limitWarning.classList.remove('hidden');
    this.limitWarning.innerHTML = `Limite de ${limit} documentos atingido. Fecha documentos antigos para abrir mais: ${titles}.`;
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (char) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[char];
  });
}

function formatPosition(article, section) {
  if (article) return `Artigo ${article}`;
  if (section) return section;
  return 'Posição guardada';
}

function serializeParams(params) {
  if (!params || typeof params !== 'object' || Object.keys(params).length === 0) return '';
  const query = new URLSearchParams(params).toString();
  return query ? `?${query}` : '';
}
