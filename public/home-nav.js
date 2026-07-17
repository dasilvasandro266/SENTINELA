(function () {
  function normalizeFileName(name) {
    return (name || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function normalizePath(path) {
    if (!path) return 'home.html';
    const clean = String(path).replace(/[#?].*$/, '').replace(/\/$/, '');
    const name = clean.split('/').pop() || 'home.html';
    return normalizeFileName(decodeURIComponent(name));
  }

  function setGlowPosition(glow, target, nav) {
    if (!glow || !target || !nav) return;
    const navRect = nav.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const x = targetRect.left - navRect.left;
    glow.style.width = targetRect.width + 'px';
    glow.style.transform = 'translateX(' + x + 'px)';
  }

  function initAnimeNav() {
    const nav = document.getElementById('animeNav');
    const glow = document.getElementById('animeNavGlow');
    const items = Array.from(document.querySelectorAll('[data-nav-item]'));

    if (!nav || !glow || !items.length) return;

    const current = normalizePath(window.location.pathname);
    let activeItem = items.find((item) => {
      const href = normalizeFileName(item.getAttribute('href') || '');
      return href === current;
    });

    if (!activeItem) {
      activeItem = items.find((item) => item.classList.contains('is-active')) || items[0];
    }

    items.forEach((item) => item.classList.remove('is-active'));
    activeItem.classList.add('is-active');
    let isUpdatingGlow = false;
    let rafId = null;

    const scheduleGlowRefresh = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        isUpdatingGlow = true;
        setGlowPosition(glow, activeItem, nav);
        isUpdatingGlow = false;
      });
    };

    scheduleGlowRefresh();

    const refreshGlow = () => scheduleGlowRefresh();
    window.addEventListener('resize', refreshGlow);
    window.addEventListener('load', refreshGlow);
    setTimeout(refreshGlow, 60);
    setTimeout(refreshGlow, 220);

    const mutationHandler = () => {
      if (isUpdatingGlow) return;
      refreshGlow();
    };
    const observer = new MutationObserver(mutationHandler);
    observer.observe(nav, {
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'class', 'style'],
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAnimeNav);
  } else {
    initAnimeNav();
  }
})();