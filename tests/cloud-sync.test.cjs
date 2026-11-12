const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appCloudSync = path.join(__dirname, '..', 'cloud-sync.js');
const fixtureCloudSync = path.join(__dirname, 'cloud-sync.js');
const cloudSyncSource = fs.readFileSync(fs.existsSync(appCloudSync) ? appCloudSync : fixtureCloudSync, 'utf8');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Conflict',
    headers: { get: () => 'application/json' },
    json: async () => data,
    text: async () => JSON.stringify(data),
    blob: async () => new Blob(['test document'], { type: 'text/plain' })
  };
}

function makeHarness({ local: initialLocal, remote: initialRemote, confirmResult = true, hasSnapshot = true, role = 'phone', backupFails = false, dirty = false, conflictOnce = false }) {
  let local = clone(initialLocal);
  let remoteState = initialRemote.state ? clone(initialRemote.state) : null;
  let remoteRevision = initialRemote.revision || 0;
  let shouldConflictOnce = conflictOnce;
  const calls = [];
  const messages = [];
  const timeline = [];
  const backups = [];
  const localBackups = new Map();
  let confirmCalls = 0;

  async function fakeFetch(url, options = {}) {
    const method = options.method || 'GET';
    calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/state' && method === 'GET') {
      return response({ revision: remoteRevision, state: clone(remoteState) });
    }
    if (url === '/api/state' && method === 'PUT') {
      const body = JSON.parse(options.body);
      if (shouldConflictOnce) { shouldConflictOnce = false; remoteState = clone(remoteState); remoteState.vehicles.push({ id: 'server-race', name: 'Înregistrare simultană pe server' }); remoteRevision += 1; return response({ error: 'revision conflict', revision: remoteRevision }, 409); }
      if (Number(body.revision) !== Number(remoteRevision)) {
        return response({ error: 'revision conflict', revision: remoteRevision }, 409);
      }
      remoteState = clone(body.state);
      remoteRevision += 1;
      timeline.push('put');
      return response({ revision: remoteRevision });
    }
    if (url === '/api/backups' && method === 'POST') {
      if (backupFails) return response({ error: 'backup write failed' }, 503);
      const body = JSON.parse(options.body);
      backups.push({ snapshot: clone(body.state), source: body.source, serverSnapshot: clone(remoteState) });
      timeline.push('server-backup');
      return response({ ok: true, backupId: backups.length });
    }
    if (url === '/api/backups' && method === 'GET') return response({ backups: [] });
    if (url.startsWith('/api/documents?id=') && method === 'GET') return response({ ok: true });
    throw new Error(`Unexpected request: ${method} ${url}`);
  }

  const fakeIndexedDB = {
    open(name) {
      const request = {};
      queueMicrotask(() => {
        const stores = name === 'agenda-automatic-backups' ? ['snapshots'] : ['files'];
        request.result = {
          objectStoreNames: { contains(store) { return stores.includes(store); } },
          createObjectStore(store) { stores.push(store); },
          transaction() {
            const tx = { objectStore() {
              return {
                getAll() {
                  const result = {};
                  queueMicrotask(() => { result.result = name === 'agenda-automatic-backups' ? [...localBackups.values()] : []; result.onsuccess?.(); });
                  return result;
                },
                put(record) { localBackups.set(record.id, clone(record)); queueMicrotask(() => tx.oncomplete?.()); },
                delete(id) { localBackups.delete(id); queueMicrotask(() => tx.oncomplete?.()); }
              };
            } };
            return tx;
          },
          close() {}
        };
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };

  const window = {
    FleetAuth: { isAuthenticated: () => true, csrf: 'test-csrf' },
    addEventListener() {},
    setInterval() { return 1; }
  };
  const storage = new Map([['agendaSyncRole', role]]);
  if (dirty) storage.set('agendaCloudDirty', '1');
  const localStorage = { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, String(value)); }, removeItem(key) { storage.delete(key); } };
  const document = { querySelector() { return null; } };
  const timers = new Map();
  let nextTimer = 1;
  const fakeSetTimeout = (callback, delay = 0) => { if (!delay) return 0; const id = nextTimer++; timers.set(id, { callback, delay }); return id; };
  const fakeClearTimeout = id => timers.delete(id);
  const runTimers = async maxDelay => { for (const [id, timer] of [...timers]) if (timer.delay <= maxDelay) { timers.delete(id); await timer.callback(); } };
  const sandbox = {
    window,
    document,
    navigator: { onLine: true, userAgent: role === 'phone' ? 'Android' : 'Windows' },
    localStorage,
    indexedDB: fakeIndexedDB,
    fetch: fakeFetch,
    Headers,
    URLSearchParams,
    Blob,
    btoa,
    confirm() { confirmCalls += 1; timeline.push('confirm'); return confirmResult; },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    console
  };

  vm.runInNewContext(cloudSyncSource, sandbox, { filename: 'cloud-sync.js' });
  window.FleetCloud.init({
    getState: () => local,
    hasLocalSnapshot: () => hasSnapshot,
    notify: message => messages.push(String(message)),
    render() {},
    setRevision(revision) { local.settings.cloudRevision = Number(revision); },
    enableCloud(revision) {
      local.settings.cloudSyncEnabled = true;
      local.settings.cloudRevision = Number(revision);
    },
    applyRemote(state, revision) {
      local = clone(state);
      local.settings = local.settings || {};
      local.settings.cloudSyncEnabled = true;
      local.settings.cloudRevision = Number(revision);
      timeline.push('apply');
    },
    async downloadFullBackup(snapshot, label) { timeline.push(`backup:${label || 'local'}`); backups.push({ snapshot, label }); return { format: 'test-backup' }; }
  });

  return {
    cloud: window.FleetCloud,
    calls,
    messages,
    timeline,
    backups,
    localBackups,
    getLocal: () => local,
    getRemote: () => ({ revision: remoteRevision, state: remoteState }),
    getConfirmCalls: () => confirmCalls,
    runTimers,
    getStorage: key => storage.get(key)
  };
}

function state(vehicles, extra = {}) {
  return {
    vehicles,
    parts: [], safety: [], orders: [], history: [], alerts: [], alertResolutions: [],
    settings: {},
    ...extra
  };
}

test('bootstrap automatically merges edits and backs up both conflict versions', async () => {
  const local = state([
    { id: 'shared-1', name: 'Nume vechi pe telefon', category: 'Autoturism' },
    { id: 'utility-local', name: 'Utilaj păstrat pe telefon', category: 'Utilaj' }
  ], { settings: { cloudSyncEnabled: false, cloudRevision: 0 } });
  const remote = {
    revision: 533,
    state: state([
      { id: 'shared-1', name: 'Nume central', category: 'Autoturism' },
      { id: 'server-1', name: 'Vehicul existent pe server', category: 'Transport' }
    ])
  };
  const harness = makeHarness({ local, remote, dirty: true });

  await harness.cloud.bootstrap();

  const uploaded = harness.getRemote().state;
  assert.deepEqual(uploaded.vehicles.map(vehicle => vehicle.id), ['shared-1', 'utility-local', 'server-1']);
  assert.equal(uploaded.vehicles.find(vehicle => vehicle.id === 'shared-1').name, 'Nume vechi pe telefon');
  assert.equal(uploaded.vehicles.find(vehicle => vehicle.id === 'utility-local').category, 'Utilaj');
  assert.deepEqual(harness.timeline, ['server-backup', 'server-backup', 'put', 'apply']);
  assert.equal(harness.getRemote().revision, 534);
  assert.equal(harness.getLocal().settings.cloudSyncEnabled, true);
  assert.ok(harness.localBackups.size >= 2);
  assert.equal(harness.backups[1].source, 'phone');
  assert.equal(harness.getConfirmCalls(), 0);
});

test('automatic reconciliation combines local and server records without confirmation', async () => {
  const local = state([{ id: 'phone-utility', name: 'Utilaj local', category: 'Utilaj' }], {
    settings: { cloudSyncEnabled: false, cloudRevision: 0 }
  });
  const harness = makeHarness({
    local,
    remote: { revision: 3, state: state([{ id: 'server-car', name: 'Autoturism server', category: 'Autoturism' }]) },
    confirmResult: false,
    dirty: true
  });

  await harness.cloud.bootstrap();

  assert.equal(harness.calls.filter(call => call.method === 'PUT').length, 1);
  assert.deepEqual(harness.getRemote().state.vehicles.map(vehicle => vehicle.id), ['phone-utility', 'server-car']);
  assert.equal(harness.getConfirmCalls(), 0);
  assert.equal(harness.getLocal().settings.cloudSyncEnabled, true);
});

test('device with no local edits adopts the newer central revision without uploading', async () => {
  const shared = { id: 'shared-1', name: 'Vehicul comun', category: 'Autoturism' };
  const local = state([shared], { settings: { cloudSyncEnabled: true, cloudRevision: 4 } });
  const harness = makeHarness({
    local,
    remote: { revision: 5, state: state([shared], { settings: { cloudSyncEnabled: true } }) }
  });

  await harness.cloud.bootstrap();

  assert.equal(harness.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(harness.timeline.includes('apply'), true);
  assert.equal(harness.getLocal().settings.cloudRevision, 5);
});

test('empty central database is initialized from the device snapshot without replacing existing data', async () => {
  const local = state([{ id: 'phone-utility', name: 'Utilaj inițial', category: 'Utilaj' }], {
    settings: { cloudSyncEnabled: false, cloudRevision: 0 }
  });
  const harness = makeHarness({ local, remote: { revision: 0, state: null } });

  await harness.cloud.bootstrap();

  assert.equal(harness.getRemote().state.vehicles[0].id, 'phone-utility');
  assert.equal(harness.getRemote().revision, 1);
  assert.equal(harness.getLocal().settings.cloudSyncEnabled, true);
  assert.equal(harness.backups.length, 1);
  assert.match(harness.messages.at(-1), /salvate în MySQL/);
});

test('first browser without a local snapshot loads the central fleet without uploading demo data', async () => {
  const remoteState = state([{ id: 'central-42', name: 'Vehicul din MySQL', category: 'Utilaj' }]);
  const harness = makeHarness({
    local: state([{ id: 'demo-only', name: 'Date locale inițiale' }], { settings: { cloudSyncEnabled: false, cloudRevision: 0 } }),
    remote: { revision: 42, state: remoteState },
    hasSnapshot: false
  });

  await harness.cloud.bootstrap();

  assert.deepEqual(harness.getLocal().vehicles.map(vehicle => vehicle.id), ['central-42']);
  assert.equal(harness.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(harness.getLocal().settings.cloudRevision, 42);
});

test('work computer replaces a 31-vehicle local snapshot with all 69 central vehicles', async () => {
  const localVehicles = Array.from({ length: 31 }, (_, index) => ({ id: `vehicle-${index + 1}`, name: `old-${index + 1}` }));
  const centralVehicles = Array.from({ length: 69 }, (_, index) => ({ id: `vehicle-${index + 1}`, name: `central-${index + 1}` }));
  const harness = makeHarness({
    local: state(localVehicles, { settings: { cloudSyncEnabled: true, cloudRevision: 10 } }),
    remote: { revision: 12, state: state(centralVehicles) },
    role: 'computer'
  });

  await harness.cloud.bootstrap();

  assert.equal(harness.getLocal().vehicles.length, 69);
  assert.equal(harness.getLocal().vehicles[0].name, 'central-1');
  assert.equal(harness.getLocal().settings.cloudRevision, 12);
  assert.equal(harness.calls.filter(call => call.method === 'PUT').length, 0);
  assert.deepEqual(harness.timeline, ['apply']);
  assert.equal(harness.localBackups.size, 1);
});

test('computer can publish its local-only data using manual synchronization', async () => {
  const harness = makeHarness({
    local: state([{ id: 'pc-only', name: 'Local PC data' }], { settings: { cloudSyncEnabled: true, cloudRevision: 3 } }),
    remote: { revision: 4, state: state([{ id: 'server', name: 'Central data' }], { settings: { cloudSyncEnabled: true } }) },
    role: 'computer'
  });

  await harness.cloud.syncToServer();

  assert.equal(harness.calls.filter(call => call.method === 'PUT').length, 1);
  assert.deepEqual(harness.getRemote().state.vehicles.map(vehicle => vehicle.id), ['pc-only', 'server']);
  assert.deepEqual(harness.timeline, ['server-backup', 'put', 'apply']);
});

test('computer never initializes an empty central database from its local snapshot', async () => {
  const harness = makeHarness({
    local: state([{ id: 'pc-data', name: 'Local PC' }], { settings: { cloudSyncEnabled: false, cloudRevision: 0 } }),
    remote: { revision: 0, state: null },
    role: 'computer'
  });

  await harness.cloud.bootstrap();

  assert.equal(harness.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(harness.getRemote().state, null);
  assert.match(harness.messages.at(-1), /nu am inițializat baza de date din acest calculator/i);
});

test('reconciliation merges all supported record groups and keeps current-device versions for shared IDs', async () => {
  const groups = ['parts', 'safety', 'orders', 'history', 'alerts', 'alertResolutions'];
  const local = state([{ id: 'vehicle-1', name: 'Local vehicle' }], { settings: { cloudSyncEnabled: false, cloudRevision: 0 } });
  const remote = state([{ id: 'vehicle-1', name: 'Server vehicle' }]);
  for (const group of groups) {
    local[group] = [{ id: `${group}-shared`, name: 'local version' }, { id: `${group}-local`, name: 'local only' }];
    remote[group] = [{ id: `${group}-shared`, name: 'server version' }, { id: `${group}-server`, name: 'server only' }];
  }
  const harness = makeHarness({ local, remote: { revision: 7, state: remote }, dirty: true });

  await harness.cloud.bootstrap();

  const merged = harness.getRemote().state;
  for (const group of groups) {
    assert.deepEqual(merged[group].map(item => item.id), [`${group}-shared`, `${group}-local`, `${group}-server`]);
    assert.equal(merged[group][0].name, 'local version');
  }
});

test('same-record sync preserves fields that changed on either device', async () => {
  const local = state([{ id: 'vehicle-1', name: 'Denumire laptop', vin: 'VIN local', odometer: 1200 }], {
    settings: { cloudSyncEnabled: true, cloudRevision: 3 }
  });
  const remote = { revision: 4, state: state([{ id: 'vehicle-1', name: 'Denumire server', category: 'Utilaj', odometer: 1100 }], { settings: { cloudSyncEnabled: true } }) };
  const harness = makeHarness({ local, remote, dirty: true });

  await harness.cloud.bootstrap();

  const vehicle = harness.getRemote().state.vehicles[0];
  assert.equal(vehicle.name, 'Denumire laptop');
  assert.equal(vehicle.vin, 'VIN local');
  assert.equal(vehicle.category, 'Utilaj');
  assert.equal(vehicle.odometer, 1200);
  assert.equal(harness.getConfirmCalls(), 0);
});
test('same-ID device edits synchronize automatically after backups', async () => {
  const local = state([{ id: 'shared-1', name: 'Corect pe telefon' }], { settings: { cloudSyncEnabled: true, cloudRevision: 12 } });
  const remote = { revision: 13, state: state([{ id: 'shared-1', name: 'Vechi pe server' }]) };
  const harness = makeHarness({ local, remote, dirty: true });

  await harness.cloud.bootstrap();

  assert.equal(harness.getRemote().state.vehicles[0].name, 'Corect pe telefon');
  assert.deepEqual(harness.timeline, ['server-backup', 'server-backup', 'put', 'apply']);
  assert.equal(harness.backups[0].snapshot.vehicles[0].name, 'Vechi pe server');
  assert.equal(harness.backups[1].snapshot.vehicles[0].name, 'Corect pe telefon');
  assert.equal(harness.getConfirmCalls(), 0);
});

test('automatic laptop edits are backed up and uploaded to MySQL', async () => {
  const local = state([{ id: 'vehicle-1', name: 'Nume actualizat pe laptop' }], { settings: { cloudSyncEnabled: true, cloudRevision: 4 } });
  const remote = { revision: 4, state: state([{ id: 'vehicle-1', name: 'Nume vechi pe server' }]) };
  const harness = makeHarness({ local, remote, role: 'computer', dirty: true });

  harness.cloud.schedule();
  await harness.runTimers(1000);

  assert.equal(harness.getRemote().state.vehicles[0].name, 'Nume actualizat pe laptop');
  assert.equal(harness.getRemote().revision, 5);
  assert.deepEqual(harness.timeline, ['server-backup', 'server-backup', 'put']);
  assert.equal(harness.getStorage('agendaCloudDirty'), undefined);
});

test('simultaneous server write is retried automatically without confirmation', async () => {
  const local = state([{ id: 'vehicle-1', name: 'Editat pe laptop' }], { settings: { cloudSyncEnabled: true, cloudRevision: 4 } });
  const remote = { revision: 4, state: state([{ id: 'vehicle-1', name: 'Nume vechi' }], { settings: { cloudSyncEnabled: true } }) };
  const harness = makeHarness({ local, remote, role: 'computer', dirty: true, conflictOnce: true });

  harness.cloud.schedule();
  await harness.runTimers(1000);

  assert.equal(harness.getRemote().state.vehicles.find(vehicle => vehicle.id === 'vehicle-1').name, 'Editat pe laptop');
  assert.equal(harness.getRemote().state.vehicles.some(vehicle => vehicle.id === 'server-race'), true);
  assert.equal(harness.getRemote().revision, 6);
  assert.equal(harness.getConfirmCalls(), 0);
});
test('clean laptop automatically adopts changes made on the phone', async () => {
  const local = state([{ id: 'vehicle-1', name: 'Nume vechi pe laptop' }], { settings: { cloudSyncEnabled: true, cloudRevision: 4 } });
  const remote = { revision: 5, state: state([{ id: 'vehicle-1', name: 'Nume nou de pe telefon' }]) };
  const harness = makeHarness({ local, remote, role: 'computer' });

  await harness.cloud.bootstrap();

  assert.equal(harness.getLocal().vehicles[0].name, 'Nume nou de pe telefon');
  assert.equal(harness.getLocal().settings.cloudRevision, 5);
  assert.equal(harness.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(harness.localBackups.size, 1);
});

test('full backup includes document binaries referenced by the server snapshot', async () => {
  const serverState = state([{ id: 'vehicle-1', name: 'Vehicle', documents: [{ id: 'doc-1', name: 'manual.txt' }] }]);
  const harness = makeHarness({ local: state([], { settings: {} }), remote: { revision: 1, state: serverState } });

  const backup = await harness.cloud.fullBackup(serverState);

  assert.equal(backup.state.vehicles[0].documents[0].id, 'doc-1');
  assert.equal(backup.documents[0].id, 'doc-1');
  assert.equal(backup.documents[0].name, 'manual.txt');
  assert.ok(backup.documents[0].dataBase64.length > 0);
});

test('manual sync retains server-only records without confirmation', async () => {
  const local = state([{ id: 'shared', name: 'Telefon corect' }, { id: 'phone-only', name: 'Telefon nou' }], {
    settings: { cloudSyncEnabled: true, cloudRevision: 2 }
  });
  const remote = { revision: 3, state: state([{ id: 'shared', name: 'Server vechi' }, { id: 'server-only', name: 'Server unic' }]) };
  const harness = makeHarness({ local, remote, role: 'phone' });

  await harness.cloud.syncToServer();

  assert.deepEqual(harness.getRemote().state.vehicles.map(vehicle => vehicle.id), ['shared', 'phone-only', 'server-only']);
  assert.equal(harness.getRemote().state.vehicles[0].name, 'Telefon corect');
  assert.deepEqual(harness.timeline, ['server-backup', 'server-backup', 'put', 'apply']);
  assert.equal(harness.backups[0].snapshot.vehicles[0].name, 'Server vechi');
  assert.equal(harness.getConfirmCalls(), 0);
});

test('manual phone sync still uploads local edits when the stored revision matches the server', async () => {
  const local = state([{ id: 'vehicle-1', name: 'Updated on phone' }], { settings: { cloudSyncEnabled: true, cloudRevision: 8 } });
  const remote = { revision: 8, state: state([{ id: 'vehicle-1', name: 'Old central name' }]) };
  const harness = makeHarness({ local, remote });

  await harness.cloud.syncToServer();

  assert.equal(harness.getRemote().state.vehicles[0].name, 'Updated on phone');
  assert.equal(harness.getRemote().revision, 9);
  assert.deepEqual(harness.timeline, ['server-backup', 'server-backup', 'put', 'apply']);
  const backupCall = harness.calls.findIndex(call => call.url === '/api/backups' && call.method === 'POST');
  const stateWriteCall = harness.calls.findIndex(call => call.url === '/api/state' && call.method === 'PUT');
  assert.ok(backupCall >= 0 && backupCall < stateWriteCall);
  assert.equal(harness.localBackups.size, 3);
});

test('a failed automatic server backup stops synchronization before any state write', async () => {
  const local = state([{ id: 'vehicle-1', name: 'Phone copy' }], { settings: { cloudSyncEnabled: true, cloudRevision: 2 } });
  const remote = { revision: 3, state: state([{ id: 'vehicle-1', name: 'Server copy' }]) };
  const harness = makeHarness({ local, remote, backupFails: true });

  await harness.cloud.syncToServer();

  assert.equal(harness.calls.filter(call => call.url === '/api/state' && call.method === 'PUT').length, 0);
  assert.equal(harness.getRemote().state.vehicles[0].name, 'Server copy');
  assert.ok(harness.localBackups.size >= 2);
  assert.match(harness.messages.at(-1), /backup write failed/);
});

test('local automatic backups retain the latest twenty recoverable snapshots', async () => {
  const harness = makeHarness({ local: state([], { settings: {} }), remote: { revision: 0, state: null } });
  for (let index = 0; index < 25; index++) {
    await harness.cloud.saveLocalBackupSnapshot(state([{ id: `vehicle-${index}`, name: `Snapshot ${index}` }]), 'autosave');
  }

  assert.equal(harness.localBackups.size, 20);
});

