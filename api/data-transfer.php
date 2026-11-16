<?php
declare(strict_types=1);

/* Admin-only, disk-backed Agenda data transfer. No archive is placed under the document root. */
const FDT_FORMAT = 'agenda-database-transfer';
const FDT_FORMAT_VERSION = 1;
const FDT_EXPORT_TTL = 900;
const FDT_IMPORT_TTL = 1800;

final class FdtHttpException extends RuntimeException { public function __construct(string $message, public readonly int $status = 400) { parent::__construct($message); } }
function fdt_fail(string $message, int $status = 400): never { throw new FdtHttpException($message, $status); }
function fdt_cleanup_private_dir(string $dir): void {
    foreach (glob($dir . DIRECTORY_SEPARATOR . 'token-*.json') ?: [] as $tokenFile) {
        $record=json_decode((string)@file_get_contents($tokenFile),true);
        if (!is_array($record) || (int)($record['expiresAt']??0)>=time()) continue;
        $archive=basename((string)($record['archive']??''));
        if (preg_match('/^agenda-(?:transfer|import)-[a-zA-Z0-9-]+\.zip$/',$archive)) @unlink($dir . DIRECTORY_SEPARATOR . $archive);
        @unlink($tokenFile);
    }
    foreach (array_merge(glob($dir . DIRECTORY_SEPARATOR . 'agenda-transfer-*.zip') ?: [], glob($dir . DIRECTORY_SEPARATOR . 'agenda-import-*.zip') ?: []) as $archive) {
        if (is_file($archive) && (filemtime($archive) ?: time()) < time() - 86400) @unlink($archive);
    }
}
function fdt_private_dir(): string {
    $root = realpath(dirname(__DIR__, 2));
    $docRoot = realpath((string)($_SERVER['DOCUMENT_ROOT'] ?? dirname(__DIR__)));
    if ($root === false) fdt_fail('Nu pot determina directorul privat al contului. Exportul nu a fost pornit.', 503);
    $dir = $root . DIRECTORY_SEPARATOR . '.agenda-private';
    if ($docRoot !== false && ($dir === $docRoot || str_starts_with($dir . DIRECTORY_SEPARATOR, rtrim($docRoot, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR))) {
        fdt_fail('Directorul privat ar cădea în spațiul web public. Configurați un director privat în afara document root.', 503);
    }
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) fdt_fail('Nu s-a putut crea spațiul privat pentru arhive. Verificați permisiunile contului cPanel.', 503);
    @chmod($dir, 0700);
    $real = realpath($dir);
    if ($real === false || ($docRoot !== false && ($real === $docRoot || str_starts_with($real . DIRECTORY_SEPARATOR, rtrim($docRoot, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR)))) fdt_fail('Arhivele nu pot fi păstrate în siguranță în afara spațiului public.', 503);
    fdt_cleanup_private_dir($real);
    return $real;
}
function fdt_random_id(): string { return bin2hex(random_bytes(32)); }
function fdt_token_path(string $token): string {
    if (!preg_match('/^[a-f0-9]{64}$/', $token)) fdt_fail('Linkul temporar nu este valid.', 404);
    return fdt_private_dir() . DIRECTORY_SEPARATOR . 'token-' . hash('sha256', $token) . '.json';
}
function fdt_create_token(array $record): string {
    $token = fdt_random_id();
    $path = fdt_token_path($token);
    if (file_put_contents($path, json_encode($record, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) fdt_fail('Nu s-a putut crea linkul temporar. Verificați spațiul și permisiunile cPanel.', 503);
    @chmod($path, 0600);
    return $token;
}
function fdt_consume_token(string $token, string $kind): array {
    $path = fdt_token_path($token);
    $fp = @fopen($path, 'c+');
    if (!$fp || !flock($fp, LOCK_EX)) fdt_fail('Linkul a fost deja folosit, a expirat sau nu există.', 410);
    rewind($fp); $record = json_decode((string)stream_get_contents($fp), true);
    if (!is_array($record) || ($record['kind'] ?? '') !== $kind || (int)($record['expiresAt'] ?? 0) < time()) {
        flock($fp, LOCK_UN); fclose($fp); @unlink($path);
        fdt_fail('Linkul a fost deja folosit, a expirat sau nu există.', 410);
    }
    ftruncate($fp, 0); fflush($fp); flock($fp, LOCK_UN); fclose($fp); @unlink($path);
    return $record;
}
function fdt_consume_staged_token(string $token, string $kind): array {
    $path = fdt_token_path($token);
    $fp = @fopen($path, 'c+');
    if (!$fp || !flock($fp, LOCK_EX)) fdt_fail('Sesiunea temporară de import a expirat sau a fost folosită.', 410);
    rewind($fp); $record = json_decode((string)stream_get_contents($fp), true);
    if (!is_array($record) || ($record['kind'] ?? '') !== $kind || (int)($record['expiresAt'] ?? 0) < time() || ($record['user'] ?? '') !== (string)($_SESSION['fleetos_user'] ?? '')) {
        flock($fp, LOCK_UN); fclose($fp); @unlink($path);
        fdt_fail('Sesiunea temporară de import a expirat sau nu aparține utilizatorului autentificat.', 410);
    }
    ftruncate($fp, 0); fflush($fp); flock($fp, LOCK_UN); fclose($fp); @unlink($path);
    return $record;
}
function fdt_schema(PDO $pdo, string $table): array {
    $stmt = $pdo->query('SHOW COLUMNS FROM `' . str_replace('`', '``', $table) . '`');
    return array_map(static fn(array $c): array => ['name'=>$c['Field'], 'type'=>strtolower((string)$c['Type']), 'nullable'=>$c['Null']==='YES', 'key'=>(string)$c['Key'], 'extra'=>strtolower((string)$c['Extra'])], $stmt->fetchAll());
}
function fdt_tables(PDO $pdo): array {
    $status = $pdo->query('SHOW TABLE STATUS')->fetchAll(); $engines=[];
    foreach($status as $row) $engines[(string)$row['Name']] = strtoupper((string)($row['Engine']??''));
    $all = array_keys(array_filter($engines, static fn($engine)=>$engine!==''));
    $tables = array_values(array_filter($all, static fn($t) => preg_match('/^fleetos_[a-z0-9_]+$/i', (string)$t)));
    sort($tables, SORT_STRING);
    if (!in_array('fleetos_state', $tables, true) || !in_array('fleetos_documents', $tables, true) || !in_array('fleetos_migrations', $tables, true)) fdt_fail('Schema Agenda nu este completă. Rulați întâi Setări → Migrare / actualizare bază de date pe ambele servere.', 409);
    foreach($tables as $table) if(($engines[$table]??'')!=='INNODB') fdt_fail('Tabelul ' . $table . ' nu folosește InnoDB. Importul tranzacțional/rollback nu poate fi garantat.',409);
    return $tables;
}
function fdt_schema_version(PDO $pdo): array {
    $rows = $pdo->query('SELECT version, checksum FROM fleetos_migrations ORDER BY version')->fetchAll();
    if (!$rows) fdt_fail('Nu există istoric de migrare în baza de date. Rulați migrarea aplicației înainte de export/import.', 409);
    $normalized = array_map(static fn($r) => ['version'=>(string)$r['version'], 'checksum'=>(string)$r['checksum']], $rows);
    return ['migrations'=>$normalized, 'fingerprint'=>hash('sha256', json_encode($normalized, JSON_UNESCAPED_SLASHES))];
}
function fdt_write_all($handle, string $data): void {
    $offset = 0; $length = strlen($data);
    while ($offset < $length) { $written = fwrite($handle, substr($data, $offset)); if ($written === false || $written === 0) throw new RuntimeException('Nu s-au putut scrie toate datele arhivei. Verificați spațiul pe disc.'); $offset += $written; }
}
function fdt_build_archive(PDO $pdo): string {
    if (!class_exists('ZipArchive')) fdt_fail('Extensia PHP ZipArchive nu este activată. Activați ZIP în cPanel → Select PHP Version.', 503);
    $dir = fdt_private_dir(); $tmp = $dir . DIRECTORY_SEPARATOR . 'build-' . fdt_random_id();
    if (!mkdir($tmp, 0700)) fdt_fail('Nu s-a putut crea spațiul temporar privat pentru export.', 503);
    $zipPath = $dir . DIRECTORY_SEPARATOR . 'agenda-transfer-' . gmdate('Ymd-His') . '-' . bin2hex(random_bytes(4)) . '.zip';
    $zip = new ZipArchive();
    if ($zip->open($zipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) { @rmdir($tmp); fdt_fail('Arhiva ZIP nu a putut fi creată. Verificați spațiul disponibil.', 503); }
    $files = []; $tableMeta = []; $tables = fdt_tables($pdo); $snapshotStarted=false;
    try {
        $pdo->exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        $pdo->exec('START TRANSACTION WITH CONSISTENT SNAPSHOT'); $snapshotStarted=true;
        foreach ($tables as $table) {
            $entry = 'database/' . $table . '.jsonl'; $local = $tmp . DIRECTORY_SEPARATOR . $table . '.jsonl';
            $out = fopen($local, 'wb'); if (!$out) throw new RuntimeException('Nu s-a putut crea dump-ul tabelului ' . $table . '.');
            $columns = fdt_schema($pdo, $table); $stmt = $pdo->query('SELECT * FROM `' . str_replace('`', '``', $table) . '`'); $count = 0;
            while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
                if ($table === 'fleetos_documents') {
                    $bytes = (string)($row['contents'] ?? '');
                    $fileEntry = 'files/' . hash('sha256', (string)$row['document_id']) . '.bin';
                    $fileLocal = $tmp . DIRECTORY_SEPARATOR . basename($fileEntry);
                    if (file_put_contents($fileLocal, $bytes, LOCK_EX) !== strlen($bytes)) throw new RuntimeException('Atașamentul ' . $row['filename'] . ' nu a putut fi scris integral.');
                    if (!$zip->addFile($fileLocal, $fileEntry)) throw new RuntimeException('Atașamentul ' . $row['filename'] . ' nu a putut fi inclus în arhivă.');
                    $files[$fileEntry] = ['sha256'=>hash('sha256', $bytes), 'bytes'=>strlen($bytes)];
                    unset($row['contents']); $row['_archiveFile'] = $fileEntry;
                }
                $line = json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
                if ($line === false) throw new RuntimeException('Un rând din ' . $table . ' nu poate fi serializat JSON.');
                fdt_write_all($out, $line . "\n"); $count++;
            }
            fclose($out);
            if (!$zip->addFile($local, $entry)) throw new RuntimeException('Dump-ul tabelului ' . $table . ' nu a putut fi adăugat.');
            $files[$entry] = ['sha256'=>hash_file('sha256', $local), 'bytes'=>filesize($local)];
            $tableMeta[$table] = ['rows'=>$count, 'columns'=>$columns, 'file'=>$entry];
        }
        $buildFiles=['index.html','cloud-sync.js','sw.js','api/index.php','api/bootstrap.php','api/data-transfer.php','database/schema.sql']; $buildParts=[];
        foreach($buildFiles as $relative) { $file=dirname(__DIR__) . DIRECTORY_SEPARATOR . str_replace('/',DIRECTORY_SEPARATOR,$relative); $buildParts[$relative]=is_file($file)?hash_file('sha256',$file):null; }
        $manifest = ['format'=>FDT_FORMAT, 'formatVersion'=>FDT_FORMAT_VERSION, 'application'=>'Agenda', 'applicationBuild'=>'sha256:' . hash('sha256', json_encode($buildParts, JSON_UNESCAPED_SLASHES)), 'schemaVersion'=>fdt_schema_version($pdo), 'createdAt'=>gmdate(DATE_ATOM), 'tables'=>$tableMeta, 'files'=>$files, 'includesSecrets'=>false];
        $json = json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false || !$zip->addFromString('manifest.json', $json)) throw new RuntimeException('Manifestul arhivei nu a putut fi creat.');
        if (!$zip->close()) throw new RuntimeException('Arhiva ZIP nu s-a finalizat corect.');
        $pdo->commit(); $snapshotStarted=false;
        @chmod($zipPath, 0600);
        return $zipPath;
    } catch (Throwable $error) {
        $zip->close(); if($snapshotStarted&&$pdo->inTransaction())$pdo->rollBack(); @unlink($zipPath); throw $error;
    } finally {
        foreach (glob($tmp . DIRECTORY_SEPARATOR . '*') ?: [] as $f) @unlink($f);
        @rmdir($tmp);
    }
}
function fdt_file_hash(ZipArchive $zip, string $entry): array {
    $stream = $zip->getStream($entry); if (!$stream) throw new RuntimeException('Lipsește fișierul din arhivă: ' . $entry);
    $ctx = hash_init('sha256'); $bytes = 0;
    while (!feof($stream)) { $chunk = fread($stream, 1024 * 1024); if ($chunk === false) { fclose($stream); throw new RuntimeException('Nu s-a putut citi ' . $entry . '.'); } $bytes += strlen($chunk); hash_update($ctx, $chunk); }
    fclose($stream); return ['sha256'=>hash_final($ctx), 'bytes'=>$bytes];
}
function fdt_safe_entry(string $entry): bool { return $entry !== '' && !str_contains($entry, '..') && !str_contains($entry, '\\') && $entry[0] !== '/' && (bool)preg_match('#^(manifest\.json|database/fleetos_[a-z0-9_]+\.jsonl|files/[a-f0-9]{64}\.bin)$#i', $entry); }
function fdt_inspect_archive(string $path, PDO $pdo): array {
    if (!class_exists('ZipArchive')) fdt_fail('Extensia PHP ZipArchive nu este activată.', 503);
    $zip = new ZipArchive(); if ($zip->open($path, ZipArchive::RDONLY) !== true) fdt_fail('Fișierul încărcat nu este o arhivă ZIP validă.', 400);
    try {
        $raw = $zip->getFromName('manifest.json'); $manifest = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($manifest) || ($manifest['format'] ?? '') !== FDT_FORMAT || (int)($manifest['formatVersion'] ?? 0) !== FDT_FORMAT_VERSION) fdt_fail('Formatul arhivei Agenda nu este acceptat.', 422);
        if (!empty($manifest['includesSecrets'])) fdt_fail('Arhiva este marcată ca incluzând secrete și a fost respinsă.', 422);
        $localSchema = fdt_schema_version($pdo);
        if (!hash_equals((string)$localSchema['fingerprint'], (string)($manifest['schemaVersion']['fingerprint'] ?? ''))) fdt_fail('Versiunea schemei nu corespunde. Faceți pull și rulați migrarea pe ambele servere înainte de import.', 409);
        $currentTables = fdt_tables($pdo); $archiveTables = array_keys(is_array($manifest['tables'] ?? null) ? $manifest['tables'] : []); sort($archiveTables, SORT_STRING);
        if ($currentTables !== $archiveTables) fdt_fail('Lista tabelelor aplicației diferă între servere. Importul a fost oprit fără modificări.', 409);
        foreach ($currentTables as $table) if (fdt_schema($pdo, $table) !== ($manifest['tables'][$table]['columns'] ?? null)) fdt_fail('Structura tabelului ' . $table . ' diferă. Actualizați schema înainte de transfer.', 409);
        $expectedFiles = $manifest['files'] ?? null; if (!is_array($expectedFiles)) fdt_fail('Manifestul nu conține lista de verificare a fișierelor.', 422);
        $zipNames = [];
        for ($i=0; $i<$zip->numFiles; $i++) { $st=$zip->statIndex($i); if (!$st) continue; $name=(string)$st['name']; if ($name === 'manifest.json') continue; if (!fdt_safe_entry($name) || isset($zipNames[$name])) fdt_fail('Arhiva conține o cale neașteptată sau duplicată.', 422); $zipNames[$name]=true; }
        if (array_diff(array_keys($expectedFiles), array_keys($zipNames)) || array_diff(array_keys($zipNames), array_keys($expectedFiles))) fdt_fail('Fișierele din arhivă nu corespund manifestului.', 422);
        foreach ($expectedFiles as $entry=>$meta) { if (!fdt_safe_entry((string)$entry) || !is_array($meta)) fdt_fail('Manifestul conține o cale nepermisă.', 422); $actual=fdt_file_hash($zip,(string)$entry); if (!hash_equals((string)($meta['sha256']??''),$actual['sha256']) || (int)($meta['bytes']??-1)!==$actual['bytes']) fdt_fail('Verificarea checksum a eșuat pentru ' . $entry . '.', 422); }
        $vehicleIds = []; $counts = [];
        foreach ($manifest['tables'] as $table=>$meta) {
            $entry=(string)($meta['file']??''); if (!fdt_safe_entry($entry) || !isset($expectedFiles[$entry])) fdt_fail('Dump invalid pentru tabelul ' . $table . '.', 422);
            $stream=$zip->getStream($entry); if (!$stream) fdt_fail('Dump lipsă pentru tabelul ' . $table . '.', 422); $counts[$table]=0;
            while (($line=fgets($stream))!==false) { if (trim($line)==='') continue; $row=json_decode($line,true); if (!is_array($row)) { fclose($stream); fdt_fail('Rând JSON invalid în ' . $table . '.', 422); } $counts[$table]++;
                if ($table==='fleetos_state' && (int)($row['state_id']??0)===1) { $state=json_decode((string)($row['payload']??''),true); if (!is_array($state) || !is_array($state['vehicles']??null)) { fclose($stream); fdt_fail('Snapshotul flotei din arhivă este invalid.', 422); } foreach($state['vehicles'] as $v) if (!empty($v['id'])) $vehicleIds[(string)$v['id']]=true; }
                if ($table==='fleetos_documents') {
                    $expected='files/' . hash('sha256',(string)($row['document_id']??'')) . '.bin';
                    if (($row['_archiveFile']??'')!==$expected || empty($expectedFiles[$expected]) || (int)($row['byte_size']??-1)!==(int)$expectedFiles[$expected]['bytes'] || !hash_equals((string)($row['sha256']??''),(string)$expectedFiles[$expected]['sha256'])) { fclose($stream); fdt_fail('Atașamentul nu corespunde ID-ului, dimensiunii sau checksum-ului din baza de date.',422); }
                }
            }
            fclose($stream); if ($counts[$table] !== (int)($meta['rows']??-1)) fdt_fail('Numărul de rânduri pentru ' . $table . ' nu corespunde manifestului.',422);
        }
        $stream=$zip->getStream((string)$manifest['tables']['fleetos_documents']['file']);
        while (($line=fgets($stream))!==false) { $row=json_decode($line,true); if (!is_array($row) || !isset($vehicleIds[(string)($row['vehicle_id']??'')])) { fclose($stream); fdt_fail('Există un document fără vehicul asociat în snapshotul flotei.',422); } }
        fclose($stream);
        $existing=(int)$pdo->query('SELECT COUNT(*) FROM fleetos_state')->fetchColumn()>0;
        return ['manifest'=>$manifest,'counts'=>$counts,'existingData'=>$existing,'zipEntries'=>count($zipNames)];
    } finally { $zip->close(); }
}
function fdt_insert_archive(PDO $pdo, ZipArchive $zip, array $manifest): array {
    $tables=array_keys($manifest['tables']); $done=[];
    foreach (array_reverse($tables) as $table) { $pdo->exec('DELETE FROM `' . str_replace('`','``',$table) . '`'); }
    foreach ($tables as $table) {
        $meta=$manifest['tables'][$table]; $columns=array_column($meta['columns'],'name');
        $quoted=implode(',',array_map(static fn($c)=>'`'.str_replace('`','``',$c).'`',$columns)); $marks=implode(',',array_fill(0,count($columns),'?'));
        $insert=$pdo->prepare('INSERT INTO `' . str_replace('`','``',$table) . '` (' . $quoted . ') VALUES (' . $marks . ')');
        $stream=$zip->getStream($meta['file']); if (!$stream) throw new RuntimeException('Dump lipsă pentru ' . $table . '.');
        while (($line=fgets($stream))!==false) {
            if (trim($line)==='') continue; $row=json_decode($line,true); if (!is_array($row)) throw new RuntimeException('Rând invalid în ' . $table . '.');
            if ($table==='fleetos_documents') { $file=(string)($row['_archiveFile']??''); unset($row['_archiveFile']); $blob=$zip->getFromName($file); if (!is_string($blob)) throw new RuntimeException('Atașamentul ' . $file . ' nu a putut fi citit.'); $row['contents']=$blob; }
            $values=[]; foreach($columns as $column) { if (!array_key_exists($column,$row)) throw new RuntimeException('Coloana ' . $column . ' lipsește din rândul ' . $table . '.'); $values[]=$row[$column]; }
            $insert->execute($values);
        }
        fclose($stream); $done[$table]=(int)$meta['rows'];
    }
    return $done;
}
function fdt_dispatch(string $route, string $method): never {
    $pdo=fleetos_db(); $dir=fdt_private_dir();
    if ($route==='data-transfer/export-link' && $method==='POST') {
        $archive=fdt_build_archive($pdo); $token=fdt_create_token(['kind'=>'export','archive'=>basename($archive),'user'=>(string)$_SESSION['fleetos_user'],'expiresAt'=>time()+FDT_EXPORT_TTL]);
        fleetos_json(['ok'=>true,'downloadUrl'=>'/api/data-transfer/download?token='.$token,'expiresIn'=>FDT_EXPORT_TTL,'message'=>'Arhiva a fost creată în spațiul privat. Linkul expiră în 15 minute și se poate folosi o singură dată.']);
    }
    if ($route==='data-transfer/download' && $method==='GET') {
        $record=fdt_consume_token((string)($_GET['token']??''),'export'); $name=(string)($record['archive']??'');
        if (!preg_match('/^agenda-transfer-[a-zA-Z0-9-]+\.zip$/',$name)) fdt_fail('Arhiva temporară nu este validă.',404);
        $path=$dir.DIRECTORY_SEPARATOR.$name; if (!is_file($path)) fdt_fail('Arhiva a expirat sau a fost descărcată deja.',410);
        header('Content-Type: application/zip'); header('Content-Disposition: attachment; filename="Agenda-transfer-' . gmdate('Y-m-d') . '.zip"'); header('Content-Length: ' . filesize($path)); header('Cache-Control: no-store, private'); header('X-Content-Type-Options: nosniff'); readfile($path); @unlink($path); exit;
    }
    if ($route==='data-transfer/prepare' && $method==='POST') {
        if (!class_exists('ZipArchive')) fdt_fail('Extensia PHP ZipArchive nu este activată.',503);
        $upload=$_FILES['archive']??null; if (!is_array($upload)||($upload['error']??UPLOAD_ERR_NO_FILE)!==UPLOAD_ERR_OK||!is_uploaded_file((string)$upload['tmp_name'])) fdt_fail('Selectați o arhivă ZIP validă. Dacă fișierul este mare, verificați limita upload_max_filesize/post_max_size din cPanel.',413);
        $staged='agenda-import-' . fdt_random_id() . '.zip'; $path=$dir.DIRECTORY_SEPARATOR.$staged;
        if (!move_uploaded_file((string)$upload['tmp_name'],$path)) fdt_fail('Fișierul nu a putut fi păstrat în spațiul temporar privat.',503); @chmod($path,0600);
        try { $preview=fdt_inspect_archive($path,$pdo); }
        catch(Throwable $e) { @unlink($path); throw $e; }
        $token=fdt_create_token(['kind'=>'import','archive'=>$staged,'user'=>(string)$_SESSION['fleetos_user'],'expiresAt'=>time()+FDT_IMPORT_TTL,'preview'=>$preview]);
        unset($preview['manifest']['files']);
        fleetos_json(['ok'=>true,'token'=>$token,'expiresIn'=>FDT_IMPORT_TTL,'preview'=>$preview,'message'=>'Arhiva este integră și compatibilă. Baza nu a fost modificată.']);
    }
    if ($route==='data-transfer/cancel' && $method==='POST') {
        $body=fleetos_body(); $record=fdt_consume_staged_token((string)($body['token']??''),'import'); @unlink($dir.DIRECTORY_SEPARATOR.basename((string)$record['archive'])); @unlink(fdt_token_path((string)$body['token'])); fleetos_json(['ok'=>true]);
    }
    if ($route==='data-transfer/import' && $method==='POST') {
        $body=fleetos_body(); $token=(string)($body['token']??'');
        if (($body['confirmation']??'')!=='IMPORTAȚI DATELE PESTE BAZA EXISTENTĂ') fdt_fail('Confirmarea explicită nu a fost furnizată. Baza de date nu a fost modificată.',400);
        $record=fdt_consume_staged_token($token,'import'); $path=$dir.DIRECTORY_SEPARATOR.basename((string)($record['archive']??'')); if (!is_file($path)) fdt_fail('Arhiva temporară de import nu mai există.',410);
        try { $preview=fdt_inspect_archive($path,$pdo); $before=fdt_build_archive($pdo); }
        catch(Throwable $e) { @unlink($path); throw $e; }
        $zip=new ZipArchive(); if ($zip->open($path,ZipArchive::RDONLY)!==true) { @unlink($before); fdt_fail('Arhiva nu a putut fi redeschisă după validare.',422); }
        try { $pdo->beginTransaction(); $counts=fdt_insert_archive($pdo,$zip,$preview['manifest']); $pdo->commit(); }
        catch(Throwable $e) { if($pdo->inTransaction())$pdo->rollBack(); $zip->close(); @unlink($path); throw new FdtHttpException('Importul a fost anulat și tranzacția a fost readusă la starea inițială. Baza țintă a rămas intactă. Corectați cauza și încărcați din nou arhiva.',500); }
        $zip->close(); @unlink($path); @unlink(fdt_token_path($token));
        $backupToken=fdt_create_token(['kind'=>'export','archive'=>basename($before),'user'=>(string)$_SESSION['fleetos_user'],'expiresAt'=>time()+FDT_EXPORT_TTL]);
        fleetos_json(['ok'=>true,'counts'=>$counts,'filesRestored'=>$counts['fleetos_documents']??0,'backupDownloadUrl'=>'/api/data-transfer/download?token='.$backupToken,'message'=>'Import finalizat. Baza a fost înlocuită după confirmare, iar backupul anterior este disponibil prin link temporar.']);
    }
    fdt_fail('Endpoint de transfer necunoscut.',404);
}
function fdt_handle(string $route, string $method): never {
    try { fdt_dispatch($route,$method); }
    catch (FdtHttpException $error) { fleetos_json(['error'=>$error->getMessage()],$error->status); }
    catch (Throwable $error) { error_log('Agenda data transfer failed: ' . $error->getMessage()); fleetos_json(['error'=>'Operația de transfer a eșuat. Verificați jurnalul PHP din cPanel; datele țintă au fost păstrate sau tranzacția a fost anulată.'],500); }
}


