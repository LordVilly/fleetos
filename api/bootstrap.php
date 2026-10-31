<?php
declare(strict_types=1);

function fleetos_env(): array {
    static $env = null;
    if ($env !== null) return $env;
    $env = [];
    $path = dirname(__DIR__) . '/.env';
    if (is_file($path) && is_readable($path)) {
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $index => $line) {
            if ($index === 0) $line = preg_replace('/^\xEF\xBB\xBF/', '', $line) ?? $line;
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) continue;
            [$key, $value] = explode('=', $line, 2);
            $key = trim($key);
            if (str_starts_with($key, 'export ')) $key = trim(substr($key, 7));
            $value = trim($value);
            if (strlen($value) >= 2 && ($value[0] === '"' || $value[0] === "'")) {
                $quote = $value[0];
                $end = strrpos($value, $quote);
                if ($end > 0) {
                    $tail = trim(substr($value, $end + 1));
                    if ($tail === '' || str_starts_with($tail, '#')) $value = substr($value, 1, $end - 1);
                }
            }
            $env[$key] = $value;
        }
    }
    return $env;
}

function fleetos_value(string $key, string $default = ''): string {
    $env = fleetos_env();
    if (array_key_exists($key, $env)) return (string)$env[$key];
    $value = getenv($key);
    return $value === false ? $default : (string)$value;
}

function fleetos_dotenv_value(string $key, string $default = ''): string {
    $env = fleetos_env();
    return array_key_exists($key, $env) ? (string)$env[$key] : $default;
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
    $host = fleetos_dotenv_value('DB_HOST');
    $port = fleetos_dotenv_value('DB_PORT', '3306');
    $name = fleetos_dotenv_value('DB_NAME');
    $user = fleetos_dotenv_value('DB_USER');
    $pass = fleetos_dotenv_value('DB_PASSWORD');
    if ($host === '' || $name === '' || $user === '' || $pass === '') fleetos_json(['error' => 'Lipsește DB_HOST, DB_NAME, DB_USER sau DB_PASSWORD din fișierul .env al aplicației.'], 503);
    if (!ctype_digit($port) || (int)$port < 1 || (int)$port > 65535) fleetos_json(['error' => 'DB_PORT din fișierul .env trebuie să fie un număr între 1 și 65535.'], 503);
    try {
        $pdo = new PDO("mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4", $user, $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false, PDO::ATTR_TIMEOUT => 8]);
    } catch (Throwable $error) {
        error_log('FleetOS MySQL connection failed: ' . $error->getMessage());
        $detail = strtolower($error->getMessage());
        $errorInfo = $error instanceof PDOException ? ($error->errorInfo ?? []) : [];
        $sqlState = (string)($errorInfo[0] ?? $error->getCode());
        $driverCode = (string)($errorInfo[1] ?? '');
        $code = $driverCode !== '' ? $driverCode : (string)$error->getCode();
        $suffix = ' (SQLSTATE ' . ($sqlState !== '' ? $sqlState : 'necunoscut') . ($driverCode !== '' ? '; cod MySQL ' . $driverCode : '') . ').';
        if (str_contains($detail, 'could not find driver')) $message = 'Extensia PHP PDO MySQL (pdo_mysql) nu este activată în cPanel.';
        elseif ($code === '1045' || str_contains($detail, 'access denied')) $message = 'MySQL a refuzat autentificarea. Verificați DB_USER, DB_PASSWORD și asocierea utilizatorului cu baza.' . $suffix;
        elseif ($code === '1049' || str_contains($detail, 'unknown database')) $message = 'Baza indicată în DB_NAME nu există. Creați-o în cPanel și copiați numele complet cu prefix.' . $suffix;
        elseif ($code === '2002' || $code === '2003' || str_contains($detail, 'connection refused')) $message = 'MySQL nu este accesibil la DB_HOST/DB_PORT. Folosiți hostul indicat de furnizorul cPanel.' . $suffix;
        else $message = 'Conexiunea MySQL nu a reușit. Verificați DB_HOST, DB_PORT, DB_NAME, DB_USER și privilegiile în cPanel.' . $suffix;
        fleetos_json(['error' => $message], 503);
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
    $length = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($length > 32 * 1024 * 1024) fleetos_json(['error' => 'Cererea depășește limita de 32 MB.'], 413);
    $raw = file_get_contents('php://input');
    $body = json_decode($raw ?: '', true);
    if (!is_array($body)) fleetos_json(['error' => 'Corpul cererii nu este JSON valid.'], 400);
    return $body;
}

function fleetos_route(): string {
    return trim((string)($_GET['route'] ?? ''), '/');
}
