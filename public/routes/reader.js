import ActiveDocumentsManager from '/active-documents/ActiveDocumentsManager.js';
import { initializeLeitor, getCurrentLeitorContext } from '/leitor.js';

function parseDocumentQuery() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('legislacao')) {
    return {
      type: 'Legislação',
      id: String(params.get('legislacao') || '').trim(),
      route: '/app/reader',
      params: { legislacao: String(params.get('legislacao') || '').trim() },
    };
  }
  return null;
}

async function setupActiveDocument(docMeta) {
  const manager = await ActiveDocumentsManager.getInstance();
  if (!manager.isEnabled()) return null;

  const result = await manager.openDocument({
    id: `legislacao:${docMeta.id}`,
    title: docMeta.title || `Legislação ${docMeta.id}`,
    type: docMeta.type,
    route: docMeta.route,
    params: docMeta.params,
  });

  if (!result.success) {
    return null;
  }

  manager.setStateProvider(async () => getCurrentLeitorContext());
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      manager.suspendCurrentDocument();
    }
  });
  window.addEventListener('beforeunload', () => {
    manager.suspendCurrentDocument();
  });

  return manager.getDocument(result.document.id);
}

async function render() {
  const docMeta = parseDocumentQuery();
  if (!docMeta || !docMeta.id) {
    const container = document.getElementById('legislacao-container');
    if (container) {
      container.innerHTML = '<p>Documento inválido ou não especificado.</p>';
    }
    return;
  }

  const manager = await ActiveDocumentsManager.getInstance();
  let stored = await manager.getDocument(`legislacao:${docMeta.id}`);
  await setupActiveDocument(docMeta);
  stored = await manager.getDocument(`legislacao:${docMeta.id}`);

  await initializeLeitor(stored || undefined);
}

render().catch((error) => {
  console.error('Erro ao renderizar leitor no PWA:', error);
});
