/**
 * Sincronização offline-first para SENTINELA.
 *
 * Esta camada centraliza o envio de alterações locais, a recuperação de delta
 * remoto e a resolução de conflitos entre cliente e servidor.
 *
 * O objetivo é suportar:
 * - sincronização incremental de anotações, histórico e favoritos
 * - sincronização de cache de conteúdo consultado
 * - reconciliação de dados ao reconectar
 * - filas de ações pendentes para operações de escrita em modo offline
 */

const BACKEND_SYNC_ENDPOINT = '/api/sync';
const SYNC_QUEUE_KEY = 'sentinela-sync-queue';

function createSyncService({ store, networkDetector, apiClient }) {
  return {
    enqueueChange(action) {
      const queue = store.get(SYNC_QUEUE_KEY) || [];
      queue.push({ id: Date.now().toString(), action, createdAt: new Date().toISOString() });
      store.set(SYNC_QUEUE_KEY, queue);
      return queue;
    },

    async flushPendingChanges() {
      const queue = store.get(SYNC_QUEUE_KEY) || [];
      if (!queue.length || !networkDetector.isOnline()) return [];

      const results = [];
      for (const item of queue) {
        try {
          const response = await apiClient.post(BACKEND_SYNC_ENDPOINT, item.action);
          results.push({ id: item.id, success: true, response: response.data });
        } catch (error) {
          results.push({ id: item.id, success: false, error: error.message });
        }
      }

      const failed = results.filter((item) => !item.success).map((item) => item.id);
      store.set(SYNC_QUEUE_KEY, queue.filter((item) => !failed.includes(item.id)));
      return results;
    },

    mergeRemoteState(localState, remoteState) {
      // Exemplo de estratégia simples: latest-write-wins por timestamp.
      return {
        ...localState,
        ...remoteState,
        updatedAt: Math.max(localState?.updatedAt || 0, remoteState?.updatedAt || 0)
      };
    }
  };
}

module.exports = {
  createSyncService,
  BACKEND_SYNC_ENDPOINT
};
