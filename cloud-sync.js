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
    if (response.status === 401) throw new Error('Sesiunea Agenda a expirat. Autentificați-vă din nou.');
    return response;
  }
  async function getRemote() {
    const response = await request('/api/state');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Nu am putut citi datele de pe server.');
    return data;
  }
  function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  function mergePhoneAuthoritativeRecords(local, remote) {
    const merged = { ...remote, ...local, settings: { ...(remote.settings || {}), ...(local.settings || {}) } };
    for (const key of ['vehicles', 'parts', 'safety', 'orders', 'history', 'alerts', 'alertResolutions']) {
      const phoneRecords = Array.isArray(local[key]) ? local[key] : [];
      const serverRecords = Array.isArray(remote[key]) ? remote[key] : [];
      const phoneIds = new Set(phoneRecords.map(item => item?.id).filter(Boolean));
      merged[key] = [...phoneRecords, ...serverRecords.filter(item => !item?.id || !phoneIds.has(item.id))];
    }
    return merged;
  }
  function countReconciliationChanges(local, remote) {
    const counts = {};
    for (const key of ['vehicles', 'parts', 'safety', 'orders', 'history', 'alerts', 'alertResolutions']) {
      const phoneRecords = Array.isArray(local[key]) ? local[key] : [];
      const serverRecords = Array.isArray(remote[key]) ? remote[key] : [];
      const phoneById = new Map(phoneRecords.filter(item => item?.id).map(item => [item.id, item]));
      const serverById = new Map(serverRecords.filter(item => item?.id).map(item => [item.id, item]));
      counts[key] = {
        phoneOnly: phoneRecords.filter(item => item?.id && !serverById.has(item.id)).length,
        phoneUpdated: phoneRecords.filter(item => item?.id && serverById.has(item.id) && stableSerialize(item) !== stableSerialize(serverById.get(item.id))).length,
        serverOnly: serverRecords.filter(item => item?.id && !phoneById.has(item.id)).length
      };
    }
    return counts;
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
    if (!token()) { context.notify('Autentificați-vă în Agenda pentru a testa conexiunea.'); return; }
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
          context.notify('Baza MySQL este goală. Deschideți Agenda în browserul care conține flota inițială; acesta va publica datele pe server.');
          return;
        }
        const revision = await sendState(local, Number(remote.revision || 0));
        context.enableCloud(revision);
        await uploadPendingDocuments();
        paused = false;
        setStatus('Baza centrală inițializată', true);
        context.notify('Datele Agenda au fost salvate în MySQL. Acest server va fi folosit de dispozitivele conectate.');
        return;
      }
      if (local.settings?.cloudSyncEnabled && localRevision === Number(remote.revision || 0)) {
        paused = false;
        setStatus('Conectat la baza centrală', true);
        return;
      }
      if (local.settings?.cloudSyncEnabled) {
        const counts = countReconciliationChanges(local, remote.state);
        const total = Object.values(counts).reduce((sum, count) => sum + count.phoneOnly + count.phoneUpdated + count.serverOnly, 0);
        if (total > 0) {
          const details = Object.entries(counts).filter(([, count]) => count.phoneOnly + count.phoneUpdated + count.serverOnly > 0).map(([key, count]) => `${count.phoneOnly} noi de pe telefon, ${count.phoneUpdated} actualizate pe telefon, ${count.serverOnly} doar pe server (${key})`).join('; ');
          if (!confirm(`Telefonul este sursa prioritară. Diferențe detectate: ${details}. Înainte de sincronizare se descarcă un backup complet al telefonului și un backup al serverului. Înregistrările cu același ID vor prelua versiunea telefonului; înregistrările care există doar pe server vor fi păstrate. Continuați?`)) {
            paused = true;
            setStatus('Sincronizare în așteptare · datele locale au fost păstrate');
            context.notify('Datele locale au rămas pe dispozitiv. Reluați sincronizarea numai după ce decideți cum doriți să reconciliați diferențele.');
            return;
          }
          await context.downloadFullBackup();
          await context.downloadFullBackup(remote.state, 'server');
          const merged = mergePhoneAuthoritativeRecords(local, remote.state);
          const revision = await sendState(merged, Number(remote.revision || 0));
          context.applyRemote(merged, revision);
          await uploadPendingDocuments();
          paused = false;
          setStatus('Datele telefonului au fost sincronizate', true);
          context.notify('Sincronizare reușită. Telefonul a avut prioritate pentru înregistrările comune; înregistrările unice de pe server au fost păstrate. Backupurile telefonului și serverului au fost descărcate.');
          return;
        }
        paused = true;
        setStatus('Conflict între dispozitive · sincronizare oprită');
        context.notify('Serverul și acest dispozitiv au revizii diferite, dar nu există înregistrări locale noi care să poată fi unite automat în siguranță. Datele locale au fost păstrate; nu s-a trimis nicio modificare.');
        return;
      }
      // A browser with no prior Agenda save is a first-time device (including Incognito).
      // Load the central snapshot instead of displaying the local starter/demo state.
      if (!context.hasLocalSnapshot?.()) {
        context.applyRemote(remote.state, Number(remote.revision || 0));
        paused = false;
        await uploadPendingDocuments();
        setStatus('Conectat la baza centrală', true);
        context.notify('Flota a fost încărcată din baza de date centrală.');
        return;
      }
      // Keep both copies before reconciling; the phone is authoritative for shared IDs.
      const counts = countReconciliationChanges(local, remote.state);
      const total = Object.values(counts).reduce((sum, count) => sum + count.phoneOnly + count.phoneUpdated + count.serverOnly, 0);
      if (!confirm(`Există o copie locală a telefonului și o flotă pe server. Diferențe detectate: ${total} înregistrări. Înainte de sincronizare se descarcă backupul telefonului și backupul serverului. Telefonul este prioritar pentru ID-urile comune, iar înregistrările unice de pe server se păstrează. Continuați?`)) {
        paused = true;
        setStatus('Conectare în așteptare · datele locale au fost păstrate');
        return;
      }
      await context.downloadFullBackup();
      await context.downloadFullBackup(remote.state, 'server');
      const merged = mergePhoneAuthoritativeRecords(local, remote.state);
      const revision = await sendState(merged, Number(remote.revision || 0));
      context.applyRemote(merged, revision);
      await uploadPendingDocuments();
      paused = false;
      setStatus('Conectat la baza centrală', true);
      context.notify('Datele telefonului au fost sincronizate. Telefonul a avut prioritate pentru înregistrările comune, cele unice de pe server au fost păstrate, iar backupurile telefonului și serverului au fost descărcate.');
    } catch (error) {
      setStatus('Conexiune la baza centrală necesită atenție');
      context.notify('Nu am putut încărca datele centrale: ' + error.message);
    } finally { busy = false; }
  }
  async function migrateAndConnect() {
    if (!token()) return context?.notify('Autentificați-vă în Agenda înainte de migrare.');
    if (!confirm('Agenda va crea tabelele lipsă, va aplica migrațiile SQL noi și va inițializa flota numai dacă baza nu conține deja date. Datele existente nu vor fi înlocuite. Continuați?')) return;
    const button = document.querySelector('#fleetMigrateButton');
    if (button) button.disabled = true;
    setStatus('Se verifică și se actualizează schema MySQL…');
    try {
      const response = await request('/api/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: context.getState() }) });
      const raw = await response.text();
      let data = null;
      try { data = JSON.parse(raw); } catch { /* răspunsul serverului poate fi HTML/PHP */ }
      if (!response.ok) {
        if (data?.error) throw new Error(data.error);
        const contentType = response.headers.get('content-type') || 'tip necunoscut';
        throw new Error('Endpointul de migrare a răspuns HTTP ' + response.status + ' (' + contentType + '), fără mesaj JSON. Verificați în cPanel jurnalul PHP și regulile .htaccess pentru /api/migrate.');
      }
      if (!data || typeof data !== 'object') throw new Error('Serverul a răspuns HTTP ' + response.status + ', dar răspunsul de migrare nu este JSON valid. Verificați jurnalul PHP din cPanel.');

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
        context.notify('Tabelele au fost create, dar nu s-a găsit un snapshot Agenda. Reîncărcați pagina din browserul care conține flota pentru inițializare.');
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
    if (!token()) return context.notify('Conectați-vă mai întâi la serverul Agenda.');
    try {
      const remote = await getRemote();
      let revision = Number(remote.revision || 0);
      let outgoing = context.getState();
      if (remote.state && revision !== Number(context.getState().settings.cloudRevision || 0)) {
        if (!confirm('Telefonul este sursa prioritară. Înainte de sincronizare se descarcă backupul telefonului și backupul serverului. Versiunea telefonului va avea prioritate pentru înregistrările cu același ID, iar înregistrările existente doar pe server vor fi păstrate. Continuați?')) return;
        await context.downloadFullBackup();
        await context.downloadFullBackup(remote.state, 'server');
        outgoing = mergePhoneAuthoritativeRecords(context.getState(), remote.state);
      }
      const nextRevision = await sendState(outgoing, revision);
      paused = false;
      context.applyRemote(outgoing, nextRevision);
      await uploadPendingDocuments();
      setStatus('Sincronizat cu serverul', true);
      paused = true;
      context.render();
      paused = false;
      context.notify('Datele telefonului au fost salvate în baza MySQL; înregistrările existente doar pe server au fost păstrate.');
    } catch (error) { setStatus('Sincronizare necesită atenție'); context.notify(error.message); }
  }
  async function syncFromServer() {
    if (!token()) return context.notify('Conectați-vă mai întâi la serverul Agenda.');
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
        context.notify('Au apărut modificări Agenda de pe celălalt dispozitiv. Încărcați versiunea serverului pentru a continua fără suprascriere.');
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
  async function fullBackup(stateOverride) {
    const backupState = stateOverride || context.getState();
    const references = new Map();
    for (const vehicle of backupState.vehicles || []) {
      for (const item of vehicle.documents || []) if (item?.id) references.set(item.id, { ...item, vehicleId: item.vehicleId || vehicle.id });
    }
    const localDocs = new Map((await getLocalDocuments()).filter(item => references.has(item.id)).map(item => [item.id, item]));
    const documents = [];
    let total = 0;
    for (const [id, reference] of references) {
      const local = localDocs.get(id);
      const blob = local?.blob || await downloadDocument(id);
      const size = Number(local?.size || reference.size || blob.size || 0);
      total += size;
      if (total > 120 * 1024 * 1024) throw new Error('Documentele depășesc 120 MB. Descărcați documentele individual înainte de migrare.');
      documents.push({ id, vehicleId: reference.vehicleId, name: local?.name || reference.name || 'document', type: local?.type || reference.type || blob.type || 'application/octet-stream', size, addedAt: local?.addedAt || reference.addedAt, verifiedOfficial: local?.verifiedOfficial ?? reference.verifiedOfficial, sourceUrl: local?.sourceUrl || reference.sourceUrl, sourceName: local?.sourceName || reference.sourceName, sha256: local?.sha256 || reference.sha256, dataBase64: await base64(blob) });
    }
    return { format: 'fleetos-backup', version: 2, exportedAt: new Date().toISOString(), state: backupState, documents };
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

