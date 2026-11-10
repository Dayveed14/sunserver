-- Installer registration (plan phase 2). Run ONCE on TiDB before deploying the API. Do not run it twice:
-- the ADD COLUMN lines fail if a column already exists, and the UPDATE near the end must only ever run once.

CREATE TABLE IF NOT EXISTS installer_references (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(120) NOT NULL,
  phone        VARCHAR(30)  NOT NULL,
  relationship VARCHAR(80)  NOT NULL,
  called_at    DATETIME NULL,
  called_by    BIGINT UNSIGNED NULL,
  call_note    VARCHAR(300) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_iref_user (user_id, id),
  CONSTRAINT fk_iref_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

ALTER TABLE installer_profiles ADD COLUMN flow_version TINYINT UNSIGNED NOT NULL DEFAULT 2;
ALTER TABLE installer_profiles ADD COLUMN registration_submitted_at DATETIME NULL;
ALTER TABLE installer_profiles ADD COLUMN business_status ENUM('cac','none','other') NULL;
ALTER TABLE installer_profiles ADD COLUMN travel_km SMALLINT UNSIGNED NULL;
ALTER TABLE installer_profiles ADD COLUMN experience_band ENUM('lt1','y1_3','y4_6','y7_10','gt10') NULL;
ALTER TABLE installer_profiles ADD COLUMN qualification ENUM('yes','no','training') NULL;
ALTER TABLE installer_profiles ADD COLUMN about VARCHAR(1000) NULL;
ALTER TABLE installer_profiles ADD COLUMN project_types JSON NULL;
ALTER TABLE installer_profiles ADD COLUMN capacity TINYINT UNSIGNED NULL;
ALTER TABLE installer_profiles ADD COLUMN response_time ENUM('1h','4h','24h','48h') NULL;
ALTER TABLE installer_profiles ADD COLUMN accepts_repairs TINYINT(1) NOT NULL DEFAULT 1;

-- Installers who already exist keep the original approval rules (no references needed).
UPDATE installer_profiles SET flow_version = 1, registration_submitted_at = quiz_submitted_at;

-- Certificates, work pictures and a profile photo can now be uploaded.
ALTER TABLE verification_documents MODIFY COLUMN kind ENUM('cac','tax','id','shop','other','certificate','work','photo') NOT NULL;
