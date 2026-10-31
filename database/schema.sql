-- FleetOS MySQL schema. Import this file in the cPanel database selected for FleetOS.
-- Application records are stored as a versioned JSON snapshot to preserve the
-- existing single-user data model. Attachments are stored separately as binary data.
CREATE TABLE IF NOT EXISTS fleetos_state (
  state_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  payload LONGTEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fleetos_single_state CHECK (state_id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fleetos_documents (
  document_id VARCHAR(64) NOT NULL PRIMARY KEY,
  vehicle_id VARCHAR(64) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(160) NOT NULL DEFAULT 'application/octet-stream',
  byte_size BIGINT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  metadata_json LONGTEXT NOT NULL,
  contents LONGBLOB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_fleetos_documents_vehicle (vehicle_id),
  CONSTRAINT chk_fleetos_document_metadata CHECK (JSON_VALID(metadata_json))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
