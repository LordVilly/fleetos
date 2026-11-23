const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'api', 'index.php'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('diagnostic endpoint remains stateless and validates the vehicle-scoped transcript', () => {
  assert.match(api, /fleetos_vehicle_context\(\$vehicleId\)/);
  assert.match(api, /document_id = \? AND vehicle_id = \?/);
  assert.match(api, /count\(\$conversation\)>20/);
  assert.match(api, /\$expectedRole='user'/);
  assert.match(api, /\$report\?4200:3200/);
  assert.match(api, /'store'=>false/);
});

test('OpenAI failure paths do not return the provider error message or secret', () => {
  assert.match(api, /\$status===401/);
  assert.match(api, /\$status===403/);
  assert.match(api, /\$status===429/);
  assert.match(api, /limita de credit sau de utilizare/);
  assert.match(api, /temporar indisponibil/);
  assert.doesNotMatch(api, /\$data\['error'\]\['message'\].*fleetos_json/);
  assert.match(api, /OPENAI_API_KEY/);
  assert.doesNotMatch(html, /OPENAI_API_KEY\s*=/);
});

test('vehicle GPT UI has follow-up turns, report review, explicit save and retrieval', () => {
  assert.match(html, /function renderVehicleGptChat/);
  assert.match(html, /conversation:s\.conversation/);
  assert.match(html, /mode:'report'/);
  assert.match(html, /function showVehicleGptReportPreview/);
  assert.match(html, /Salvează în istoricul vehiculului/);
  assert.match(html, /gptReport:vehicleGptReportText\(id\)/);
  assert.match(html, /downloadSavedGptReport/);
  assert.match(html, /Nu transforma ipotezele|Raportul nu marchează automat/);
});

test('inline application JavaScript parses without executing application state', () => {
  const open = html.indexOf('<script>');
  const close = html.indexOf('</script>', open);
  assert.ok(open >= 0 && close > open, 'inline script block must exist');
  assert.doesNotThrow(() => new Function(html.slice(open + '<script>'.length, close)));
});
