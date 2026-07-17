(function () {
  // ─── Injectar o HTML do banner no DOM ────────────────────────────────────
  // O banner é criado aqui para garantir que os elementos existem quando os
  // listeners são registados, independentemente de onde o script é carregado.
  function injectBannerHTML() {
    if (document.getElementById('pwaInstallBanner')) return; // já existe

    const banner = document.createElement('div');
    banner.id = 'pwaInstallBanner';
    banner.className = 'pwa-install-banner hidden';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Instalar aplicação');
    banner.innerHTML = `
      <p class="pwa-install-text"></p>
      <div class="pwa-install-actions">
        <button id="pwaInstallButton" class="pwa-install-button" type="button">Instalar</button>
        <button id="pwaInstallClose" class="pwa-install-close" type="button" aria-label="Fechar">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    `;
    document.body.appendChild(banner);
  }

  // ─── Lógica principal ─────────────────────────────────────────────────────
  function init() {
    injectBannerHTML();

    const banner      = document.getElementById('pwaInstallBanner');
    const button      = document.getElementById('pwaInstallButton');
    const closeButton = document.getElementById('pwaInstallClose');
    const text        = banner.querySelector('.pwa-install-text');
    let deferredPrompt = null;

    function setBannerMessage(message) {
      if (text) text.textContent = message;
    }

    function hideBanner() {
      banner.classList.add('hidden');
    }

    function showBanner() {
      banner.classList.remove('hidden');
    }

    function isIos() {
      return /iphone|ipad|ipod/i.test(navigator.userAgent);
    }

    function isInStandaloneMode() {
      return (
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true
      );
    }

    // Registar Service Worker
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('/service-worker.js')
          .then((reg) => console.log('Service Worker registado:', reg.scope))
          .catch((err) => console.warn('Falha ao registar Service Worker:', err));
      });
    }

    // Capturar o evento de instalação antes que o browser o mostre
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredPrompt = event;
      setBannerMessage('Instale SENTINELA no seu dispositivo para acesso rápido e offline.');
      showBanner();
    });

    // Esconder após instalação concluída
    window.addEventListener('appinstalled', () => {
      hideBanner();
      deferredPrompt = null;
      console.log('SENTINELA foi instalada.');
    });

    // Botão "Instalar"
    button.addEventListener('click', async () => {
      // iOS não suporta beforeinstallprompt — mostrar instrução manual
      if (!deferredPrompt) {
        if (isIos() && !isInStandaloneMode()) {
          setBannerMessage('No Safari, toque em "Partilhar" ↑ e depois "Adicionar ao ecrã principal".');
        }
        return;
      }

      try {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          hideBanner();
        } else {
          setBannerMessage('Instalação cancelada. Pode instalar mais tarde.');
        }
      } catch (err) {
        console.warn('Erro ao mostrar prompt de instalação:', err);
      } finally {
        deferredPrompt = null;
      }
    });

    // Botão "Fechar"
    closeButton.addEventListener('click', hideBanner);

    // iOS — mostrar instrução imediatamente se aplicável
    if (isIos() && !isInStandaloneMode()) {
      setBannerMessage('No Safari, toque em "Partilhar" ↑ e depois "Adicionar ao ecrã principal".');
      showBanner();
    }
  }

  // Garantir que o DOM está pronto antes de correr
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
