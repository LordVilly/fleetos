(() => {
  'use strict';
  const hosted = ['http:', 'https:'].includes(location.protocol);
  if (!hosted) { window.FleetAuth = { authenticated: true, csrf: '', isAuthenticated: () => true }; return; }
  let csrf = '';
  const gate = document.createElement('div');
  gate.id = 'fleetLoginGate';
  gate.innerHTML = `<div class="fleet-login-card"><div class="brand">Fleet<b>OS</b></div><h1>Autentificare</h1><p class="muted">Conectați-vă pentru a accesa datele flotei.</p><form id="fleetLoginForm"><label for="fleetLoginUser">Utilizator</label><input id="fleetLoginUser" name="username" autocomplete="username" required><label for="fleetLoginPassword">Parolă</label><input id="fleetLoginPassword" name="password" type="password" autocomplete="current-password" required><button class="primary" type="submit">Intră în FleetOS</button><p id="fleetLoginMessage" role="status"></p></form></div>`;
  document.body.append(gate);
  const css = document.createElement('style');
  css.textContent = `#fleetLoginGate{position:fixed;inset:0;z-index:99999;display:none;place-items:center;padding:20px;background:#0b1214f2;backdrop-filter:blur(8px)}#fleetLoginGate.visible{display:grid}.fleet-login-card{width:min(100%,390px);padding:26px;border:1px solid #36484a;border-radius:22px;background:#152023;color:#ecf4ee;box-shadow:0 24px 80px #0008}.fleet-login-card h1{margin:14px 0 4px}.fleet-login-card form{display:grid;gap:10px;margin-top:20px}.fleet-login-card input{min-height:48px;padding:10px 12px;border:1px solid #46595a;border-radius:12px;background:#0d1719;color:#fff;font:inherit}.fleet-login-card button{min-height:48px;margin-top:8px}.fleet-login-card #fleetLoginMessage{color:#ffc274;min-height:1.2em}.fleet-logout{margin-left:8px}`;
  document.head.append(css);
  window.FleetAuth = {
    authenticated: false,
    get csrf() { return csrf; },
    isAuthenticated: () => window.FleetAuth.authenticated,
    async check() {
      try {
        const response = await fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Serverul de autentificare nu este disponibil.');
        csrf = data.csrf || '';
        window.FleetAuth.authenticated = !!data.authenticated;
        gate.classList.toggle('visible', !window.FleetAuth.authenticated);
        if (window.FleetAuth.authenticated) addLogout();
      } catch (error) {
        gate.classList.add('visible');
        const message = gate.querySelector('#fleetLoginMessage');
        message.textContent = 'Backendul PHP nu răspunde. Verificați instalarea pe cPanel și fișierul .env.';
      }
    },
    async login(form) {
      const message = gate.querySelector('#fleetLoginMessage');
      message.textContent = 'Se verifică datele…';
      const fields = new FormData(form);
      try {
        const response = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: fields.get('username'), password: fields.get('password') }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Autentificarea nu a reușit.');
        csrf = data.csrf || '';
        window.FleetAuth.authenticated = true;
        gate.classList.remove('visible');
        form.reset();
        addLogout();
      } catch (error) { message.textContent = error.message; }
    }
  };
  function addLogout() {
    const header = document.querySelector('.topin');
    if (!header || header.querySelector('.fleet-logout')) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'fleet-logout'; button.textContent = 'Ieșire';
    button.addEventListener('click', async () => {
      if (!confirm('Doriți să încheiați sesiunea FleetOS?')) return;
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } });
        window.FleetAuth.authenticated = false; gate.classList.add('visible');
      } catch { gate.querySelector('#fleetLoginMessage').textContent = 'Deconectarea nu a reușit. Verificați conexiunea.'; }
    });
    header.append(button);
  }
  document.querySelector('#fleetLoginForm').addEventListener('submit', event => { event.preventDefault(); window.FleetAuth.login(event.currentTarget); });
  window.FleetAuth.check();
})();
