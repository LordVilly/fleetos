CREATE TABLE IF NOT EXISTS fleetos_backups (
    backup_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source_device VARCHAR(24) NOT NULL,
    server_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
    device_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
    server_payload LONGTEXT NULL,
    device_payload LONGTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_fleetos_backups_created (created_at, backup_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
