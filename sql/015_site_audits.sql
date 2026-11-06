-- Field site audits: a business asks for an assessment, the admin assigns a field agent, the agent surveys the site.
CREATE TABLE IF NOT EXISTS site_audits (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_ref VARCHAR(20) NOT NULL UNIQUE,
  business_id BIGINT UNSIGNED NOT NULL,
  status ENUM('requested','assigned','in_progress','completed','reopened') NOT NULL DEFAULT 'requested',
  contact_name VARCHAR(160) NOT NULL,
  contact_phone VARCHAR(30) NOT NULL,
  state VARCHAR(40) NOT NULL,
  area_id VARCHAR(60) NOT NULL,
  address_line VARCHAR(255) NOT NULL,
  preferred_date DATE NULL,
  notes VARCHAR(500) NULL,
  agent_id BIGINT UNSIGNED NULL,
  assigned_at DATETIME NULL,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  version INT UNSIGNED NOT NULL DEFAULT 0,
  form_json JSON NULL,
  result_json JSON NULL,
  assessment_id BIGINT UNSIGNED NULL,
  kwh_per_day DECIMAL(10,2) NULL,
  eaas_eligible TINYINT(1) NULL,
  review_note VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_audits_business (business_id, id),
  KEY idx_audits_agent (agent_id, status),
  KEY idx_audits_status (status, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_photos (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  audit_id BIGINT UNSIGNED NOT NULL,
  slot VARCHAR(20) NOT NULL,
  image_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_audit_slot (audit_id, slot),
  KEY idx_audit_photo_image (image_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  audit_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(30) NOT NULL,
  actor VARCHAR(20) NOT NULL,
  note VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_events (audit_id, id)
) ENGINE=InnoDB;

-- Every submitted version is kept, so a reopened audit never overwrites what the customer was shown.
CREATE TABLE IF NOT EXISTS audit_versions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  audit_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  form_json JSON NOT NULL,
  result_json JSON NOT NULL,
  assessment_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_audit_version (audit_id, version)
) ENGINE=InnoDB;
