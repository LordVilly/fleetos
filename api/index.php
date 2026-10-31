<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

$route = fleetos_route();
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
if ($route === 'auth/status' && $method === 'GET') {
    fleetos_session();
    fleetos_json(['authenticated' => !empty($_SESSION['fleetos_user']), 'user' => $_SESSION['fleetos_user'] ?? null, 'csrf' => $_SESSION['csrf'] ?? null]);
}
if ($route === 'auth/login' && $method === 'POST') {
    fleetos_session();
    $body = fleetos_body();
    $username = fleetos_value('FLEETOS_LOGIN_USER');
    $password = fleetos_value('FLEETOS_LOGIN_PASSWORD');
    if ($username === '' || $password === '') fleetos_json(['error' => 'Configurați FLEETOS_LOGIN_USER și FLEETOS_LOGIN_PASSWORD în .env.'], 503);
    $providedUser = (string)($body['username'] ?? '');
    $providedPassword = (string)($body['password'] ?? '');
    if (!hash_equals($username, $providedUser) || !hash_equals($password, $providedPassword)) {
        usleep(250000);
        fleetos_json(['error' => 'Utilizator sau parolă incorectă.'], 401);
    }
    session_regenerate_id(true);
    $_SESSION['fleetos_user'] = $username;
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
    fleetos_json(['authenticated' => true, 'user' => $username, 'csrf' => $_SESSION['csrf']]);
}
if ($route === 'auth/logout' && $method === 'POST') {
    fleetos_require_auth(true);
    $_SESSION = [];
    if (ini_get('session.use_cookies')) { $params = session_get_cookie_params(); setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'] ?? '', $params['secure'], $params['httponly']); }
    session_destroy();
    fleetos_json(['authenticated' => false]);
}

$mutation = in_array($method, ['POST', 'PUT', 'DELETE'], true);
fleetos_require_auth($mutation);
$pdo = fleetos_db();

if ($route === 'health' && $method === 'GET') fleetos_json(['ok' => true, 'databaseConfigured' => true, 'backend' => 'php']);

if ($route === 'state' && $method === 'GET') {
    $row = $pdo->query('SELECT revision, payload FROM fleetos_state WHERE state_id = 1')->fetch();
    fleetos_json(['revision' => (int)($row['revision'] ?? 0), 'state' => $row ? json_decode($row['payload'], true) : null]);
}
if ($route === 'state' && $method === 'PUT') {
    $body = fleetos_body();
    if (!isset($body['state']) || !is_array($body['state']) || !isset($body['revision']) || !is_numeric($body['revision'])) fleetos_json(['error' => 'Sunt necesare datele flotei și versiunea serverului.'], 400);
    $payload = json_encode($body['state'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($payload === false || strlen($payload) > 30000000) fleetos_json(['error' => 'Datele depășesc limita de 30 MB.'], 413);
    try {
        $pdo->beginTransaction();
        $pdo->query('INSERT IGNORE INTO fleetos_state (state_id, revision, payload) VALUES (1, 0, "{}")');
        $current = $pdo->query('SELECT revision FROM fleetos_state WHERE state_id = 1 FOR UPDATE')->fetchColumn();
        if ((int)$current !== (int)$body['revision']) { $pdo->rollBack(); fleetos_json(['error' => 'Datele serverului s-au schimbat de pe celălalt dispozitiv. Încărcați versiunea serverului înainte de a continua.', 'revision' => (int)$current], 409); }
        $next = (int)$current + 1;
        $statement = $pdo->prepare('UPDATE fleetos_state SET revision = ?, payload = ? WHERE state_id = 1');
        $statement->execute([$next, $payload]);
        $pdo->commit();
        fleetos_json(['ok' => true, 'revision' => $next]);
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        error_log('FleetOS state save failed: ' . $error->getMessage());
        fleetos_json(['error' => 'Salvarea în baza de date a eșuat.'], 500);
    }
}

if ($route === 'documents' && $method === 'GET') {
    $id = (string)($_GET['id'] ?? '');
    $statement = $pdo->prepare('SELECT filename, mime_type, contents FROM fleetos_documents WHERE document_id = ?');
    $statement->execute([$id]); $doc = $statement->fetch();
    if (!$doc) fleetos_json(['error' => 'Documentul nu a fost găsit.'], 404);
    header('Content-Type: ' . $doc['mime_type']);
    header('Content-Disposition: attachment; filename="' . rawurlencode($doc['filename']) . '"');
    header('Content-Length: ' . strlen($doc['contents'])); header('Cache-Control: no-store'); echo $doc['contents']; exit;
}
if ($route === 'documents' && $method === 'POST') {
    $id = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($_GET['id'] ?? ''));
    $vehicleId = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($_GET['vehicleId'] ?? ''));
    $filename = basename((string)($_GET['name'] ?? 'document'));
    $contents = file_get_contents('php://input');
    if ($id === '' || $vehicleId === '' || $contents === false || strlen($contents) > 25000000) fleetos_json(['error' => 'Document invalid sau mai mare de 25 MB.'], 400);
    $mime = substr((string)($_SERVER['CONTENT_TYPE'] ?? 'application/octet-stream'), 0, 160);
    $sha = hash('sha256', $contents);
    $metadata = json_encode(['uploadedBy' => $_SESSION['fleetos_user']], JSON_UNESCAPED_UNICODE);
    $statement = $pdo->prepare('INSERT INTO fleetos_documents (document_id, vehicle_id, filename, mime_type, byte_size, sha256, metadata_json, contents) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE vehicle_id=VALUES(vehicle_id), filename=VALUES(filename), mime_type=VALUES(mime_type), byte_size=VALUES(byte_size), sha256=VALUES(sha256), metadata_json=VALUES(metadata_json), contents=VALUES(contents)');
    $statement->execute([$id, $vehicleId, $filename, $mime, strlen($contents), $sha, $metadata, $contents]);
    fleetos_json(['ok' => true, 'sha256' => $sha]);
}
if ($route === 'documents' && $method === 'DELETE') {
    $statement = $pdo->prepare('DELETE FROM fleetos_documents WHERE document_id = ?'); $statement->execute([(string)($_GET['id'] ?? '')]);
    fleetos_json(['ok' => true]);
}

fleetos_json(['error' => 'Endpoint PHP neimplementat încă: ' . $route], 501);
