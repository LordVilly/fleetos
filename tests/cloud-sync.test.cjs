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

function makeHarness({ local: initialLocal, remote: initialRemote, confirmResult = true, hasSnapshot = true, role = 'phone' }) {
  let local = clone(initialLocal);
  let remoteState = initialRemote.state ? clone(initialRemote.state) : null;
  let remoteRevision = initialRemote.revision || 0;
  const calls = [];
  const messages = [];
  const timeline = [];
  const backups = [];
  let confirmCalls = 0;

  async function fakeFetch(url, options = {}) {
    const method = options.method || 'GET';
    calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/state' && method === 'GET') {
      return response({ revision: remoteRevision, state: clone(remoteState) });
    }
    if (url === '/api/state' && method === 'PUT') {
      const body = JSON.parse(options.body);
      if (Number(body.revision) !== Number(remoteRevision)) {
        return response({ error: 'revision conflict', revision: remoteRevision }, 409);
      }
      remoteState = clone(body.state);
      remoteRevision += 1;
      timeline.push('put');
      return response({ revision: remoteRevision });
    }
    if (url.startsWith('/api/documents?id=') && method === 'GET') return response({ ok: true });
    throw new Error(`Unexpected request: ${method} ${url}`);
  }

  const fakeIndexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          transaction() {
            return {
              objectStore() {
                return {
                  getAll() {
                    const result = {};
                    queueMicrotask(() => { result.result = []; result.onsuccess?.(); });
                    return result;
                  }
                };
              }
            };
          },
          close() {}
        };
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
  const localStorage = { getItem(key) { return key === 'agendaSyncRole' ? role : null; }, setItem() {} };
  const document = { querySelector() { return null; } };
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
    setTimeout() { return 1; },
    clearTimeout() {},
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
    getLocal: () => local,
    getRemote: () => ({ revision: remoteRevision, state: remoteState }),
    getConfirmCalls: () => confirmCalls
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

test('bootstrap merges phone records after backup, with the phone version winning shared IDs', async () => {
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
  const harness = makeHarness({ local, remote });

  await harness.cloud.bootstrap();

  const uploaded = harness.getRemote().state;
  assert.deepEqual(uploaded.vehicles.map(vehicle => vehicle.id), ['shared-1', 'utility-local', 'server-1']);
  assert.equal(uploaded.vehicles.find(vehicle => vehicle.id === 'shared-1').name, 'Nume vechi pe telefon');
  assert.equal(uploaded.vehicles.find(vehicle => vehicle.id === 'utility-local').category, 'Utilaj');
  assert.deepEqual(harness.timeline, ['confirm', 'backup:telefon', 'backup:server', 'put', 'apply']);
  assert.equal(harness.getRemote().revision, 534);
  assert.equal(harness.getLocal().settings.cloudSyncEnabled, true);
  assert.match(harness.messages.at(-1), /Datele telefonului au avut prioritate/);
});

test('declining reconciliation preserves local data and sends no write request', async () => {
  const local = state([{ id: 'phone-utility', name: 'Utilaj local', category: 'Utilaj' }], {
    settings: { cloudSyncEnabled: false, cloudRevision: 0 }
  });
  const harness = makeHarness({
    local,
    remote: { revision: 3, state: state([{ id: 'server-car', name: 'Autoturism server', category: 'Autoturism' }]) },
    confirmResult: false
  });

  await harness.cloud.bootstrap();

  assert.equal(harness.calls.filter(call => call.method === 'PUT').length, 0);
  assert.deepEqual(harness.getLocal().vehicles, local.vehicles);
  assert.equal(harness.timeline.includes('backup'), false);
  assert.equal(harness.getConfirmCalls(), 1);
  assert.equal(harness.getLocal().settings.cloudSyncEnabled, false);
});

test('phone with no data differences adopts the newer central revision without uploading', async () => {
  const shared = { id: 'shared-1', name: 'Vehicul comun', category: 'Autoturism' };
  const local = state([shared], { settings: { cloudSyncEnabled: true, cloudRevision: 4 } });
  const harness = makeHarness({
    local,
    remote: { revision: 5, state: state([shared]) }
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
  assert.equal(harness.timeline.includes('backup'), false);
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
  assert.deepEqual(harness.timeline, ['confirm', 'backup:calculator', 'apply']);
});

test('work computer cannot publish its local snapshot to the central database', async () => {
  const harness = makeHarness({
    local: state([{ id: 'pc-only', name: 'Local PC data' }], { settings: { cloudSyncEnabled: true, cloudRevision: 3 } }),
    remote: { revision: 4, state: state([{ id: 'server', name: 'Central data' }]) },
    role: 'computer'
  });

  await harness.cloud.syncToServer();

  assert.equal(harness.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(harness.getRemote().state.vehicles[0].id, 'server');
  assert.match(harness.messages.at(-1), /configurat să preia/);
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

test('reconciliation merges all supported record groups and keeps phone versions for shared IDs', async () => {
  const groups = ['parts', 'safety', 'orders', 'history', 'alerts', 'alertResolutions'];
  const local = state([{ id: 'vehicle-1', name: 'Local vehicle' }], { settings: { cloudSyncEnabled: false, cloudRevision: 0 } });
  const remote = state([{ id: 'vehicle-1', name: 'Server vehicle' }]);
  for (const group of groups) {
    local[group] = [{ id: `${group}-shared`, name: 'local version' }, { id: `${group}-local`, name: 'local only' }];
    remote[group] = [{ id: `${group}-shared`, name: 'server version' }, { id: `${group}-server`, name: 'server only' }];
  }
  const harness = makeHarness({ local, remote: { revision: 7, state: remote } });

  await harness.cloud.bootstrap();

  const merged = harness.getRemote().state;
  for (const group of groups) {
    assert.deepEqual(merged[group].map(item => item.id), [`${group}-shared`, `${group}-local`, `${group}-server`]);
    assert.equal(merged[group][0].name, 'local version');
  }
});

test('same-ID phone edits trigger reconciliation and are uploaded only after confirmation and backups', async () => {
  const local = state([{ id: 'shared-1', name: 'Corect pe telefon' }], { settings: { cloudSyncEnabled: true, cloudRevision: 12 } });
  const remote = { revision: 13, state: state([{ id: 'shared-1', name: 'Vechi pe server' }]) };
  const harness = makeHarness({ local, remote });

  await harness.cloud.bootstrap();

  assert.equal(harness.getRemote().state.vehicles[0].name, 'Corect pe telefon');
  assert.deepEqual(harness.timeline, ['confirm', 'backup:telefon', 'backup:server', 'put', 'apply']);
  assert.equal(harness.backups[1].snapshot.vehicles[0].name, 'Vechi pe server');
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

test('manual phone-to-server sync retains server-only records and confirms before replacing shared IDs', async () => {
  const local = state([{ id: 'shared', name: 'Telefon corect' }, { id: 'phone-only', name: 'Telefon nou' }], {
    settings: { cloudSyncEnabled: true, cloudRevision: 2 }
  });
  const remote = { revision: 3, state: state([{ id: 'shared', name: 'Server vechi' }, { id: 'server-only', name: 'Server unic' }]) };
  const harness = makeHarness({ local, remote });

  await harness.cloud.syncToServer();

  assert.deepEqual(harness.getRemote().state.vehicles.map(vehicle => vehicle.id), ['shared', 'phone-only', 'server-only']);
  assert.equal(harness.getRemote().state.vehicles[0].name, 'Telefon corect');
  assert.deepEqual(harness.timeline, ['confirm', 'backup:telefon', 'backup:server', 'put', 'apply']);
});

test('manual phone sync still uploads local edits when the stored revision matches the server', async () => {
  const local = state([{ id: 'vehicle-1', name: 'Updated on phone' }], { settings: { cloudSyncEnabled: true, cloudRevision: 8 } });
  const remote = { revision: 8, state: state([{ id: 'vehicle-1', name: 'Old central name' }]) };
  const harness = makeHarness({ local, remote });

  await harness.cloud.syncToServer();

  assert.equal(harness.getRemote().state.vehicles[0].name, 'Updated on phone');
  assert.equal(harness.getRemote().revision, 9);
  assert.deepEqual(harness.timeline, ['confirm', 'backup:telefon', 'backup:server', 'put', 'apply']);
});

