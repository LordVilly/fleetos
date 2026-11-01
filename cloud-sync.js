(() => {
  'use strict';
  let context = null;
  let timer = null;
  let busy = false;
  let paused = false;
  let lastMessage = 'Se verifică baza de date centrală…';

  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const token = () => window.FleetAuth?.isAuthenticated?.() ? 'session' : '';
  function setStatus(message, good = false) {
    lastMessage = message;
    const badge = document.querySelector('#fleetCloudStatus');
    if (badge) {
      badge.textContent = message;
      badge.className = `badge ${good ? 'good' : 'warn'}`;
    }
  }
  async function request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.method && options.method !== 'GET' && window.FleetAuth?.csrf) headers.set('X-CSRF-Token', window.FleetAuth.csrf);
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) throw new Error('Sesiunea FleetOS a expirat. Autentificați-vă din nou.');
    return response;
  }
  async function getRemote() {
    const response = await request('/api/state');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Nu am putut citi datele de pe server.');
    return data;
  }
  function mergeUnlinkedLocalRecords(local, remote) {
    const merged = { ...local, ...remote, settings: { ...(local.settings || {}), ...(remote.settings || {}) } };
    for (const key of ['vehicles', 'parts', 'safety', 'orders', 'history', 'alerts', 'alertResolutions']) {
      const central = Array.isArray(remote[key]) ? remote[key] : [];
      const ids = new Set(central.map(item => item?.id).filter(Boolean));
      const localOnly = (Array.isArray(local[key]) ? local[key] : []).filter(item => item?.id && !ids.has(item.id));
      merged[key] = [...central, ...localOnly];
    }
    return merged;
  }
  async function sendState(state, revision) {
    const response = await request('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, revision }) });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409) {
      paused = true;
      setStatus('Conflict între dispozitive · sincronizare oprită');
      throw new Error(data.error || 'Serverul s-a schimbat pe celălalt dispozitiv. Alegeți încărcarea serverului sau confirmați înlocuirea lui.');
    }
    if (!response.ok) throw new Error(data.error || 'Nu am putut salva datele centrale.');
    return data.revision;
  }
  function persistRevision(revision) {
    context.setRevision(revision);
  }
  async function getLocalDocuments() {
    const requestDb = indexedDB.open('fleetos-vehicle-files', 1);
    const db = await new Promise((resolve, reject) => {
      requestDb.onsuccess = () => resolve(requestDb.result);
      requestDb.onerror = () => reject(requestDb.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readonly');
        const req = tx.objectStore('files').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  }
  async function putLocalDocument(document) {
    const requestDb = indexedDB.open('fleetos-vehicle-files', 1);
    const db = await new Promise((resolve, reject) => {
      requestDb.onsuccess = () => resolve(requestDb.result);
      requestDb.onerror = () => reject(requestDb.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put(document);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Tranzacția IndexedDB a fost anulată.'));
      });
    } finally { db.close(); }
  }
  async function uploadPendingDocuments() {
    const documents = await getLocalDocuments();
    const referenced = new Set((context.getState().vehicles || []).flatMap(vehicle => (vehicle.documents || []).map(item => item.id)));
    for (const document of documents) {
      if (!document?.blob || document.cloudSyncedAt || !referenced.has(document.id)) continue;
      const params = new URLSearchParams({ id: document.id, vehicleId: document.vehicleId, name: document.name || 'document' });
      const response = await request(`/api/documents?${params}`, { method: 'POST', headers: { 'Content-Type': document.type || 'application/octet-stream' }, body: document.blob });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Documentul ${document.name || document.id} nu s-a sincronizat.`);
      document.cloudSyncedAt = new Date().toISOString();
      document.sha256 = data.sha256;
      await putLocalDocument(document);
    }
  }
  async function flush() {
    if (!context || busy || paused || !token() || !context.getState().settings?.cloudSyncEnabled || !navigator.onLine) return;
    busy = true;
    setStatus('Se sincronizează…');
    try {
      const current = Number(context.getState().settings.cloudRevision || 0);
      const revision = await sendState(context.getState(), current);
      persistRevision(revision);
      await uploadPendingDocuments();
      setStatus('Sincronizat cu serverul', true);
    } catch (error) {
      setStatus(navigator.onLine ? 'Sincronizare necesită atenție' : 'Offline · modificările rămân pe dispozitiv');
      context.notify(error.message);
    } finally { busy = false; }
  }
  function schedule() {
    if (!context || !context.getState().settings?.cloudSyncEnabled || paused) return;
    clearTimeout(timer);
    setStatus(navigator.onLine ? 'Modificări locale · sincronizare în așteptare' : 'Offline · modificările rămân pe dispozitiv');
    timer = setTimeout(flush, 900);
  }
  async function connect() {
    if (!token()) { context.notify('Autentificați-vă în FleetOS pentru a testa conexiunea.'); return; }
    paused = false;
    try {
      const remote = await getRemote();
      cloudRevision = Number(remote.revision || 0);
      const localRevision = Number(context.getState().settings.cloudRevision || 0);
      const serverChanged = Number(remote.revision || 0) !== localRevision;
      if (context.getState().settings.cloudSyncEnabled && remote.state && cloudRevision === localRevision) schedule();
      else if (context.getState().settings.cloudSyncEnabled && serverChanged) {
        paused = true;
      }
      setStatus(context.getState().settings.cloudSyncEnabled && serverChanged ? 'Serverul s-a schimbat · încărcați versiunea serverului' : remote.state ? `Conectat · server revizia ${cloudRevision}` : 'Conectat · baza de date este goală', !(context.getState().settings.cloudSyncEnabled && serverChanged));
      context.notify(remote.state ? 'Conexiunea la baza MySQL a reușit. Alegeți dacă încărcați datele serverului sau ale acestui dispozitiv.' : 'Conexiunea la MySQL a reușit. Baza este pregătită pentru primul upload.');
    } catch (error) {
      setStatus('Conexiune indisponibilă');
      context.notify(error.message);
    }
  }
  async function bootstrap() {
    if (!context || !token() || busy || !navigator.onLine) return;
    busy = true;
    try {
      const remote = await getRemote();
      const local = context.getState();
      const localRevision = Number(local.settings?.cloudRevision || 0);
      if (!remote.state) {
        if (!context.hasLocalSnapshot?.()) {
          setStatus('Baza centrală goală · așteaptă dispozitivul cu datele flotei');
          context.notify('Baza MySQL este goală. Deschideți FleetOS în browserul care conține flota inițială; acesta va publica datele pe server.');
          return;
        }
        const revision = await sendState(local, Number(remote.revision || 0));
        context.enableCloud(revision);
        await uploadPendingDocuments();
        paused = false;
        setStatus('Baza centrală inițializată', true);
        context.notify('Datele FleetOS au fost salvate în MySQL. Acest server va fi folosit de dispozitivele conectate.');
        return;
      }
      if (local.settings?.cloudSyncEnabled && localRevision === Number(remote.revision || 0)) {
        paused = false;
        setStatus('Conectat la baza centrală', true);
        return;
      }
      if (local.settings?.cloudSyncEnabled) {
        paused = true;
        setStatus('Conflict între dispozitive · sincronizare oprită');
        context.notify('Serverul are modificări mai noi decât acest dispozitiv. Verificați Setări → Sincronizare înainte de a continua.');
        return;
      }
      // A browser with no prior FleetOS save is a first-time device (including Incognito).
      // Load the central snapshot instead of displaying the local starter/demo state.
      if (!context.hasLocalSnapshot?.()) {
        context.applyRemote(remote.state, Number(remote.revision || 0));
        paused = false;
        await uploadPendingDocuments();
        setStatus('Conectat la baza centrală', true);
        context.notify('Flota a fost încărcată din baza de date centrală.');
        return;
      }
      // The server is authoritative, but retain a downloadable local copy before replacing
      // a browser that already contains unsynchronized data.
      if (!confirm('Există date locale nesincronizate și o flotă pe server. FleetOS va păstra datele de pe server, va adăuga înregistrările locale cu identificatori inexistenți acolo și va descărca un backup local. Pentru aceiași identificatori, versiunea serverului rămâne prioritară. Continuați?')) {
        paused = true;
        setStatus('Conectare în așteptare · datele locale au fost păstrate');
        return;
      }
      await context.downloadFullBackup();
      const merged = mergeUnlinkedLocalRecords(local, remote.state);
      const revision = await sendState(merged, Number(remote.revision || 0));
      context.applyRemote(merged, revision);
      await uploadPendingDocuments();
      paused = false;
      setStatus('Conectat la baza centrală', true);
      context.notify('Datele locale care lipseau pe server au fost adăugate. Înregistrările centrale existente au fost păstrate, iar backupul local a fost descărcat.');
    } catch (error) {
      setStatus('Conexiune la baza centrală necesită atenție');
      context.notify('Nu am putut încărca datele centrale: ' + error.message);
    } finally { busy = false; }
  }
  async function migrateAndConnect() {
    if (!token()) return context?.notify('Autentificați-vă în FleetOS înainte de migrare.');
    if (!confirm('FleetOS va crea tabelele lipsă, va aplica migrațiile SQL noi și va inițializa flota numai dacă baza nu conține deja date. Datele existente nu vor fi înlocuite. Continuați?')) return;
    const button = document.querySelector('#fleetMigrateButton');
    if (button) button.disabled = true;
    setStatus('Se verifică și se actualizează schema MySQL…');
    try {
      const response = await request('/api/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: context.getState() }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Migrarea bazei de date nu a reușit.');
      if (data.stateInserted) {
        context.enableCloud(Number(data.revision || 1));
        paused = false;
        await uploadPendingDocuments();
        setStatus('Baza centrală inițializată', true);
        context.notify('Baza MySQL a fost migrată și flota locală inițială a fost salvată.');
      } else if (data.stateExists) {
        await bootstrap();
        if (data.applied?.length) setStatus('Baza a fost actualizată · ' + data.applied.length + ' migrații', true);
        else if (!context.getState().settings?.cloudSyncEnabled) setStatus('Schema este la zi · conectați flota centrală');
        context.notify(data.applied?.length ? 'Migrarea a reușit: ' + data.applied.join(', ') : 'Schema bazei de date este deja la zi.');
      } else {
        setStatus('Schema pregătită · flota locală încă nu a fost inițializată', true);
        context.notify('Tabelele au fost create, dar nu s-a găsit un snapshot FleetOS. Reîncărcați pagina din browserul care conține flota pentru inițializare.');
      }
      context.render();
    } catch (error) {
      setStatus('Migrarea necesită atenție');
      context.notify(error.message);
    } finally { if (button?.isConnected) button.disabled = false; }
  }
  async function syncForExit() {
    if (!token()) throw new Error('Autentificați-vă pentru a trimite datele în baza centrală.');
    if (!navigator.onLine) throw new Error('Dispozitivul este offline. Datele au rămas salvate local; conectați-vă la internet și încercați din nou.');
    for (let attempt = 0; busy && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    if (busy) throw new Error('O altă sincronizare este încă în curs. Așteptați puțin și încercați din nou.');
    clearTimeout(timer);
    busy = true;
    setStatus('Se salvează datele înainte de ieșire…');
    try {
      const revision = Number(context.getState().settings?.cloudRevision || 0);
      const nextRevision = await sendState(context.getState(), revision);
      persistRevision(nextRevision);
      await uploadPendingDocuments();
      setStatus('Sincronizat cu serverul', true);
      return { synced: true, revision: nextRevision };
    } catch (error) {
      setStatus('Salvarea înainte de ieșire a eșuat');
      throw error;
    } finally { busy = false; }
  }
  async function syncToServer() {
    if (!token()) return context.notify('Conectați-vă mai întâi la serverul FleetOS.');
    try {
      const remote = await getRemote();
      let revision = Number(remote.revision || 0);
      if (remote.state && revision !== Number(context.getState().settings.cloudRevision || 0)) {
        if (!confirm('Baza centrală are date sau modificări care nu sunt în copia acestui dispozitiv. Doriți să le ÎNLOCUIȚI cu datele locale? Înainte de continuare se va descărca un backup local complet.')) return;
        await context.downloadFullBackup();
      }
      const nextRevision = await sendState(context.getState(), revision);
      paused = false;
      context.enableCloud(nextRevision);
      await uploadPendingDocuments();
      setStatus('Sincronizat cu serverul', true);
      paused = true;
      context.render();
      paused = false;
      context.notify('Datele locale au fost salvate în baza MySQL.');
    } catch (error) { setStatus('Sincronizare necesită atenție'); context.notify(error.message); }
  }
  async function syncFromServer() {
    if (!token()) return context.notify('Conectați-vă mai întâi la serverul FleetOS.');
    try {
      const remote = await getRemote();
      if (!remote.state) return context.notify('Baza de date nu conține încă o flotă. Încărcați datele de pe dispozitivul inițial.');
      if (!confirm('Datele locale de pe acest dispozitiv vor fi înlocuite cu versiunea din server. Se va descărca mai întâi un backup local complet. Continuați?')) return;
      await context.downloadFullBackup();
      context.applyRemote(remote.state, Number(remote.revision || 0));
      paused = false;
      setStatus('Sincronizat cu serverul', true);
      paused = true;
      context.render();
      paused = false;
      context.notify('Datele centrale au fost încărcate pe acest dispozitiv.');
    } catch (error) { setStatus('Sincronizare necesită atenție'); context.notify(error.message); }
  }
  async function checkRemoteRevision() {
    if (!context || busy || paused || !token() || !navigator.onLine || !context.getState().settings?.cloudSyncEnabled) return;
    try {
      const remote = await getRemote();
      const localRevision = Number(context.getState().settings.cloudRevision || 0);
      if (Number(remote.revision || 0) !== localRevision) {
        paused = true;
        setStatus('Serverul s-a schimbat · încărcați versiunea serverului');
        context.notify('Au apărut modificări FleetOS de pe celălalt dispozitiv. Încărcați versiunea serverului pentru a continua fără suprascriere.');
      }
    } catch (error) { setStatus('Verificarea serverului a eșuat'); }
  }
  async function downloadDocument(id) {
    const response = await request(`/api/documents?id=${encodeURIComponent(id)}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Documentul nu a putut fi descărcat de pe server.');
    }
    return response.blob();
  }
  async function deleteDocument(id) {
    if (!token() || !navigator.onLine) return;
    const response = await request(`/api/documents?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Documentul nu a putut fi șters din baza centrală.');
  }
  async function base64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(binary);
  }
  async function fullBackup() {
    const referenced = new Set((context.getState().vehicles || []).flatMap(vehicle => (vehicle.documents || []).map(item => item.id)));
    const docs = (await getLocalDocuments()).filter(item => referenced.has(item.id));
    const total = docs.reduce((sum, item) => sum + Number(item.size || item.blob?.size || 0), 0);
    if (total > 120 * 1024 * 1024) throw new Error('Documentele depășesc 120 MB. Descărcați documentele individual înainte de migrare.');
    const documents = [];
    for (const item of docs) {
      if (!item.blob) continue;
      documents.push({ id: item.id, vehicleId: item.vehicleId, name: item.name, type: item.type, size: item.size, addedAt: item.addedAt, verifiedOfficial: item.verifiedOfficial, sourceUrl: item.sourceUrl, sourceName: item.sourceName, sha256: item.sha256, dataBase64: await base64(item.blob) });
    }
    return { format: 'fleetos-backup', version: 2, exportedAt: new Date().toISOString(), state: context.getState(), documents };
  }
  function panelHtml() {
    return `<div class="panel"><div class="section-title"><div><h2>Migrare / actualizare bază de date</h2><p class="muted">Creează tabelele lipsă, rulează fișierele SQL noi din database/migrations și inițializează MySQL numai dacă este gol. Nu înlocuiește date existente.</p></div><button id="fleetMigrateButton" class="primary" type="button" onclick="FleetCloud.migrateAndConnect()">Migrare / actualizare</button></div><p class="muted">Utilizatorul MySQL trebuie să aibă privilegiile CREATE și ALTER. Actualizările fișierelor aplicației se publică separat în cPanel.</p></div>`;
  }  function init(value) { context = value; if (context.getState().settings?.cloudSyncEnabled && token()) schedule(); }
  window.FleetCloud = { init, panelHtml, request, schedule, connect, bootstrap, migrateAndConnect, syncToServer, syncForExit, syncFromServer, downloadDocument, deleteDocument, fullBackup };
  window.FleetCloudReady?.();
  window.addEventListener('online', schedule);
  window.addEventListener('online', () => { if (token()) bootstrap(); });
  window.setInterval(checkRemoteRevision, 30000);
  window.addEventListener('focus', checkRemoteRevision);
})();
