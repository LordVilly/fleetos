<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/api/bootstrap.php';

$path = $argv[1] ?? '';
$replace = in_array('--replace', $argv, true);
if ($path === '' || !is_file($path) || !is_readable($path)) {
    fwrite(STDERR, "Utilizare: php scripts/import-local-backup.php /cale/catre/fleetos-backup.json [--replace]\n");
    exit(2);
}
$backup = json_decode((string)file_get_contents($path), true);
$state = ($backup['format'] ?? '') === 'fleetos-backup' ? ($backup['state'] ?? null) : $backup;
$documents = ($backup['format'] ?? '') === 'fleetos-backup' && is_array($backup['documents'] ?? null) ? $backup['documents'] : [];
if (!is_array($state) || !is_array($state['vehicles'] ?? null) || !is_array($state['history'] ?? null) || !is_array($state['orders'] ?? null) || !is_array($state['settings'] ?? null)) {
    fwrite(STDERR, "Fișierul nu este un backup FleetOS valid.\n"); exit(2);
}

try {
    $pdo = fleetos_db();
    $pdo->beginTransaction();
    $existing = $pdo->query('SELECT revision FROM fleetos_state WHERE state_id = 1 FOR UPDATE')->fetchColumn();
    if ($existing !== false && !$replace) throw new RuntimeException('Baza conține deja date. Importul s-a oprit fără modificări. Folosiți --replace numai după un backup.');
    $payload = json_encode($state, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($existing !== false) {
        $stmt = $pdo->prepare('UPDATE fleetos_state SET revision = revision + 1, payload = ? WHERE state_id = 1'); $stmt->execute([$payload]);
        $pdo->exec('DELETE FROM fleetos_documents');
    } else {
        $stmt = $pdo->prepare('INSERT INTO fleetos_state (state_id, revision, payload) VALUES (1, 1, ?)'); $stmt->execute([$payload]);
    }
    $insert = $pdo->prepare('INSERT INTO fleetos_documents (document_id, vehicle_id, filename, mime_type, byte_size, sha256, metadata_json, contents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    foreach ($documents as $doc) {
        if (!is_array($doc) || empty($doc['id']) || empty($doc['vehicleId']) || !isset($doc['dataBase64'])) continue;
        $contents = base64_decode((string)$doc['dataBase64'], true);
        if ($contents === false) throw new RuntimeException('Documentul ' . ($doc['name'] ?? $doc['id']) . ' are date Base64 invalide.');
        $sha = hash('sha256', $contents);
        if (!empty($doc['sha256']) && !hash_equals($doc['sha256'], $sha)) throw new RuntimeException('Amprenta documentului ' . ($doc['name'] ?? $doc['id']) . ' nu corespunde backupului.');
        $metadata = ['id' => (string)$doc['id'], 'vehicleId' => (string)$doc['vehicleId'], 'name' => substr((string)($doc['name'] ?? 'document'), 0, 255), 'type' => substr((string)($doc['type'] ?? 'application/octet-stream'), 0, 160), 'size' => strlen($contents), 'addedAt' => (string)($doc['addedAt'] ?? date(DATE_ATOM))];
        foreach (['verifiedOfficial', 'sourceUrl', 'sourceName'] as $key) if (isset($doc[$key])) $metadata[$key] = $doc[$key];
        $insert->execute([$metadata['id'], $metadata['vehicleId'], $metadata['name'], $metadata['type'], strlen($contents), $sha, json_encode($metadata, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $contents]);
    }
    $pdo->commit();
    fwrite(STDOUT, sprintf("Import reușit: %d vehicule, %d înregistrări de istoric, %d comenzi, %d documente.\n", count($state['vehicles']), count($state['history']), count($state['orders']), count($documents)));
} catch (Throwable $error) {
    if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
    fwrite(STDERR, 'Import eșuat: ' . $error->getMessage() . "\n"); exit(1);
}
