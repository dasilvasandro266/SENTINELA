import ActiveDocumentsStorage from './ActiveDocumentsStorage.js';

const DEFAULT_LIMIT = 20;

function isStandaloneDisplayMode() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true
    || window.location.search.includes('standalone=true');
}

export default class ActiveDocumentsManager {
  static async getInstance() {
    if (!ActiveDocumentsManager._instance) {
      const instance = new ActiveDocumentsManager();
      await instance.init();
      ActiveDocumentsManager._instance = instance;
    }
    return ActiveDocumentsManager._instance;
  }

  constructor() {
    this.storage = new ActiveDocumentsStorage();
    this.documents = [];
    this.currentDocumentId = null;
    this.stateProvider = null;
    this.listeners = new Set();
    this.limit = DEFAULT_LIMIT;
    this.isStandalone = isStandaloneDisplayMode();
    this.ready = false;
  }

  async init() {
    if (!this.isStandalone) {
      this.ready = true;
      return;
    }
    this.documents = await this.storage.getAllDocuments();
    this.documents.sort((a, b) => b.lastUsed - a.lastUsed);
    this.ready = true;
  }

  isEnabled() {
    return this.isStandalone;
  }

  async subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async notify() {
    if (!this.isStandalone) return;
    const snapshot = await this.getActiveDocuments();
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('ActiveDocumentsManager listener error:', error);
      }
    });
  }

  async getActiveDocuments() {
    if (!this.isStandalone) return [];
    return [...this.documents].sort((a, b) => b.lastUsed - a.lastUsed);
  }

  async getDocument(id) {
    if (!this.isStandalone || !id) return null;
    return this.documents.find((doc) => doc.id === id) || null;
  }

  async setStateProvider(provider) {
    if (typeof provider !== 'function') {
      this.stateProvider = null;
      return;
    }
    this.stateProvider = provider;
  }

  async suspendCurrentDocument() {
    if (!this.isStandalone || !this.currentDocumentId || !this.stateProvider) return;
    const state = await this.stateProvider();
    if (!state) return;
    const existing = this.documents.find((doc) => doc.id === this.currentDocumentId);
    if (!existing) return;
    const updated = {
      ...existing,
      ...state,
      lastUsed: Date.now(),
    };
    this.documents = [
      updated,
      ...this.documents.filter((doc) => doc.id !== this.currentDocumentId),
    ];
    await this.storage.saveDocument(updated);
    await this.notify();
  }

  async openDocument({ id, title, type, route, params = {}, metadata = {} }) {
    if (!this.isStandalone) {
      return { success: false, reason: 'not_pwa' };
    }
    await this.waitReady();
    if (!id || !route) {
      return { success: false, reason: 'missing_data' };
    }

    const existing = this.documents.find((doc) => doc.id === id);
    if (this.currentDocumentId && this.currentDocumentId !== id) {
      await this.suspendCurrentDocument();
    }

    if (!existing && this.documents.length >= this.limit) {
      const oldest = [...this.documents]
        .sort((a, b) => a.lastUsed - b.lastUsed)
        .slice(0, 3)
        .map((doc) => ({ id: doc.id, title: doc.title, type: doc.type, lastUsed: doc.lastUsed }));
      return {
        success: false,
        reason: 'limit',
        limit: this.limit,
        oldest,
      };
    }

    const now = Date.now();
    const enriched = {
      id,
      title: title || existing?.title || 'Documento ativo',
      type: type || existing?.type || 'Documento',
      route,
      params,
      section: existing?.section || '',
      article: existing?.article || '',
      scrollY: existing?.scrollY || 0,
      zoom: existing?.zoom || 1,
      lastUsed: now,
      createdAt: existing?.createdAt || now,
      metadata: { ...existing?.metadata, ...metadata },
    };

    if (existing) {
      this.documents = [enriched, ...this.documents.filter((doc) => doc.id !== id)];
    } else {
      this.documents = [enriched, ...this.documents];
    }

    await this.storage.saveDocument(enriched);
    this.currentDocumentId = id;
    await this.notify();
    return { success: true, document: enriched };
  }

  async setCurrentDocument(id) {
    if (!this.isStandalone || !id) return;
    const existing = this.documents.find((doc) => doc.id === id);
    if (!existing) return;
    existing.lastUsed = Date.now();
    this.documents = [existing, ...this.documents.filter((doc) => doc.id !== id)];
    this.currentDocumentId = id;
    await this.storage.saveDocument(existing);
    await this.notify();
  }

  async closeDocument(id) {
    if (!this.isStandalone || !id) return;
    this.documents = this.documents.filter((doc) => doc.id !== id);
    if (this.currentDocumentId === id) {
      this.currentDocumentId = null;
    }
    await this.storage.deleteDocument(id);
    await this.notify();
  }

  async closeOthers(id) {
    if (!this.isStandalone) return;
    this.documents = this.documents.filter((doc) => doc.id === id);
    if (this.currentDocumentId !== id) {
      this.currentDocumentId = id;
    }
    const keep = this.documents[0]?.id === id ? this.documents[0] : this.documents.find((doc) => doc.id === id);
    await this.storage.clearAll();
    if (keep) {
      await this.storage.saveDocument(keep);
      this.documents = [keep];
    }
    await this.notify();
  }

  async closeAll() {
    if (!this.isStandalone) return;
    this.documents = [];
    this.currentDocumentId = null;
    await this.storage.clearAll();
    await this.notify();
  }

  async waitReady() {
    if (this.ready) return;
    await new Promise((resolve) => {
      const check = () => {
        if (this.ready) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }
}
