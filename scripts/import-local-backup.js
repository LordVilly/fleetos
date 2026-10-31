#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const inputPath = process.argv[2];
const replaceExisting = process.argv.includes('--replace');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Lipsește variabila ${name}. Configurați-o în mediul serverului.`);
  return value;
}

function unwrapBackup(value) {
  const state = value?.format === 'fleetos-backup' ? value.state : value;
  if (!state || !Array.isArray(state.vehicles) || !Array.isArray(state.history) || !Array.isArray(state.orders) || !state.settings) {
    throw new Error('Fișierul nu este un backup FleetOS valid.');
  }
  const documents = value?.format === 'fleetos-backup' && Array.isArray(value.documents) ? value.documents : [];
  return { state, documents };
}

async function main() {
  if (!inputPath) throw new Error('Utilizare: node scripts/import-local-backup.js <backup.json> [--replace]');
  const resolved = path.resolve(inputPath);
  const backup = unwrapBackup(JSON.parse(fs.readFileSync(resolved, 'utf8')));
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection({
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    charset: 'utf8mb4',
    ...(process.env.DB_SSL === '1' ? { ssl: { rejectUnauthorized: true } } : {})
  });

  try {
    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT revision FROM fleetos_state WHERE state_id = 1 FOR UPDATE');
    if (existing.length && !replaceExisting) throw new Error('Baza conține deja date. Importul a fost oprit fără modificări. Pentru înlocuire explicită, adăugați argumentul --replace după ce păstrați un backup.');

    const [schema] = await connection.execute('SELECT DATABASE() AS databaseName');
    if (!schema[0]?.databaseName) throw new Error('Conexiunea MySQL nu are o bază de date selectată.');
    const stateJson = JSON.stringify(backup.state);
    if (existing.length) {
      await connection.execute('UPDATE fleetos_state SET revision = revision + 1, payload = ? WHERE state_id = 1', [stateJson]);
      await connection.execute('DELETE FROM fleetos_documents');
    } else {
      await connection.execute('INSERT INTO fleetos_state (state_id, revision, payload) VALUES (1, 1, ?)', [stateJson]);
    }

    for (const doc of backup.documents) {
      if (!doc || !doc.id || !doc.vehicleId || typeof doc.dataBase64 !== 'string') continue;
      const contents = Buffer.from(doc.dataBase64, 'base64');
      const digest = crypto.createHash('sha256').update(contents).digest('hex');
      if (doc.sha256 && doc.sha256 !== digest) throw new Error(`Amprenta documentului ${doc.name || doc.id} nu corespunde backupului.`);
      const metadata = { id: String(doc.id), vehicleId: String(doc.vehicleId), name: String(doc.name || 'document').slice(0, 255), type: String(doc.type || 'application/octet-stream').slice(0, 160), size: contents.length, addedAt: doc.addedAt || new Date().toISOString(), ...(doc.verifiedOfficial ? { verifiedOfficial: true } : {}), ...(doc.sourceUrl ? { sourceUrl: doc.sourceUrl } : {}), ...(doc.sourceName ? { sourceName: doc.sourceName } : {}) };
      await connection.execute('INSERT INTO fleetos_documents (document_id, vehicle_id, filename, mime_type, byte_size, sha256, metadata_json, contents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [metadata.id, metadata.vehicleId, metadata.name, metadata.type, metadata.size, digest, JSON.stringify(metadata), contents]);
    }

    await connection.commit();
    console.log(`Import reușit în baza ${schema[0].databaseName}: ${backup.state.vehicles.length} vehicule, ${backup.state.history.length} înregistrări de istoric, ${backup.state.orders.length} comenzi și ${backup.documents.length} documente atașate.`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(`Import eșuat: ${error.message}`);
  process.exitCode = 1;
});
