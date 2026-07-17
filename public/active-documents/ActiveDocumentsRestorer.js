export default class ActiveDocumentsRestorer {
  constructor(manager, ui) {
    this.manager = manager;
    this.ui = ui;
  }

  async init() {
    if (!this.manager || !this.manager.isEnabled()) return;
    const documents = await this.manager.getActiveDocuments();
    if (documents.length === 0) return;
    if (this.ui && typeof this.ui.showRestoreMessage === 'function') {
      this.ui.showRestoreMessage(documents.length);
    }
  }
}
