<?php
declare(strict_types=1);

// Local PHP development router. cPanel uses Apache rewrite rules in .htaccess.
if (PHP_SAPI !== 'cli-server') { http_response_code(404); exit; }
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (preg_match('#^/api/([a-zA-Z0-9/_-]+)$#', $path, $match)) {
    $_GET['route'] = trim($match[1], '/');
    require __DIR__ . '/api/index.php';
    exit;
}
$public = ['/index.html','/cloud-sync.js','/pwa.js','/auth.js','/manifest.webmanifest','/icons/fleetos-192.png','/icons/fleetos-512.png','/icons/apple-touch-icon.png'];
if (in_array($path, $public, true)) return false;
if ($path === '/' || $path === '/index.html') { readfile(__DIR__ . '/index.html'); return true; }
http_response_code(404); echo 'Fișierul nu a fost găsit.';
