<?php
declare(strict_types=1);

function fleetos_env(): array {
    static $env = null;
    if ($env !== null) return $env;
    $env = [];
    $path = dirname(__DIR__) . '/.env';
    if (is_file($path) && is_readable($path)) {
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) continue;
            [$key, $value] = explode('=', $line, 2);
            $value = trim($value);
            if (strlen($value) >= 2 && (($value[0] === '"' && str_ends_with($value, '"')) || ($value[0] === "'" && str_ends_with($value, "'")))) $value = substr($value, 1, -1);
            $env[trim($key)] = $value;
        }
    }
    return $env;
}

function fleetos_value(string $key, string $default = ''): string {
    $env = fleetos_env();
    return (string)($env[$key] ?? getenv($key) ?: $default);
}

function fleetos_json(array $data, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function fleetos_db(): PDO {
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;
    $host = fleetos_value('DB_HOST');
    $name = fleetos_value('DB_NAME');
    $user = fleetos_value('DB_USER');
    $pass = fleetos_value('DB_PASSWORD');
    if ($host === '' || $name === '' || $user === '') fleetos_json(['error' => 'Configurați DB_HOST, DB_NAME, DB_USER și DB_PASSWORD în fișierul .env.'], 503);
    try {
        $pdo = new PDO("mysql:host={$host};dbname={$name};charset=utf8mb4", $user, $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false]);
    } catch (Throwable $error) {
        error_log('FleetOS MySQL connection failed: ' . $error->getMessage());
        fleetos_json(['error' => 'Conexiunea la MySQL a eșuat. Verificați datele din .env și drepturile utilizatorului bazei.'], 503);
    }
    return $pdo;
}

function fleetos_session(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    session_name('fleetos_session');
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Strict']);
    session_start();
}

function fleetos_require_auth(bool $mutation = false): void {
    fleetos_session();
    if (empty($_SESSION['fleetos_user'])) fleetos_json(['error' => 'Sesiune expirată. Autentificați-vă din nou.'], 401);
    if ($mutation) {
        $given = (string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
        if (empty($_SESSION['csrf']) || !hash_equals($_SESSION['csrf'], $given)) fleetos_json(['error' => 'Cererea a expirat. Reîncărcați pagina și autentificați-vă din nou.'], 403);
    }
}

function fleetos_body(): array {
    $raw = file_get_contents('php://input');
    $body = json_decode($raw ?: '', true);
    if (!is_array($body)) fleetos_json(['error' => 'Corpul cererii nu este JSON valid.'], 400);
    return $body;
}

function fleetos_route(): string {
    return trim((string)($_GET['route'] ?? ''), '/');
}
