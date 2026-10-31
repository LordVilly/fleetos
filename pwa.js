(() => {
  'use strict';
  let installPrompt = null;
  let registration = null;
  let updateWaiting = false;
  let status = 'Se verifică instalarea PWA…';
  const secure = () => window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname);

  function panelHtml() {
    const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const install = installed ? '<span class="badge good">Instalată pe acest dispozitiv</span>' : installPrompt ? '<button type="button" class="primary" onclick="FleetPwa.install()">Instalează FleetOS</button>' : '<span class="muted">Deschideți meniul browserului și alegeți «Instalează aplicația» sau «Adaugă pe ecranul principal».</span>';
    const update = updateWaiting ? '<button type="button" onclick="FleetPwa.applyUpdate()">Aplică actualizarea</button>' : '';
    return `<div class="panel"><div class="section-title"><div><h2>Instalare pe telefon și PC</h2><p class="muted">FleetOS poate fi instalat ca aplicație PWA de pe adresa HTTPS și folosește aceleași date MySQL după conectarea la server.</p></div></div><div class="toolbar">${install}${update}</div><p id="fleetPwaStatus" class="muted">${status}</p><p class="muted">Datele offline rămân locale până la sincronizare. GPT și WhatsApp necesită internet.</p></div>`;
  }

  function refreshPanel() {
    const page = document.querySelector('.settings-page');
    if (!page) return;
    const old = page.querySelector('#fleetPwaPanel');
    const wrapper = document.createElement('div');
    wrapper.id = 'fleetPwaPanel';
    wrapper.innerHTML = panelHtml();
    if (old) old.replaceWith(wrapper); else page.append(wrapper);
  }

  async function install() {
    if (!installPrompt) {
      status = secure() ? 'Instalarea se face din meniul browserului acestui dispozitiv.' : 'Instalarea necesită HTTPS.';
      refreshPanel();
      return;
    }
    installPrompt.prompt();
    const result = await installPrompt.userChoice;
    status = result.outcome === 'accepted' ? 'Instalarea FleetOS a fost acceptată.' : 'Instalarea a fost anulată.';
    installPrompt = null;
    refreshPanel();
  }

  async function applyUpdate() {
    const worker = registration?.waiting;
    if (!worker) { status = 'Nu există o actualizare în așteptare.'; updateWaiting = false; refreshPanel(); return; }
    worker.postMessage({ type: 'FLEETOS_ACTIVATE_UPDATE' });
    status = 'Se aplică actualizarea…';
    refreshPanel();
  }

  async function initialize() {
    if (!('serviceWorker' in navigator)) { status = 'Acest browser nu oferă service worker. FleetOS rămâne utilizabil online.'; refreshPanel(); return; }
    if (!secure()) { status = 'Service worker și instalarea necesită HTTPS. Pentru test local folosiți localhost.'; refreshPanel(); return; }
    try {
      registration = await navigator.serviceWorker.register('sw.js', { scope: '/' });
      const check = () => { updateWaiting = !!registration.waiting && !!navigator.serviceWorker.controller; refreshPanel(); };
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', check);
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
      await registration.update().catch(() => {});
      status = 'PWA pregătită. Interfața poate porni offline după prima încărcare completă.';
      check();
    } catch (error) { status = `Nu s-a putut activa modul offline: ${error.message}`; refreshPanel(); }
  }

  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; refreshPanel(); });
  window.addEventListener('appinstalled', () => { status = 'FleetOS a fost instalată pe acest dispozitiv.'; installPrompt = null; refreshPanel(); });
  window.FleetPwa = { panelHtml, install, applyUpdate };
  window.FleetPwaReady?.();
  window.addEventListener('load', initialize, { once: true });
})();
