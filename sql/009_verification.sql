-- Phase 8: documents for vendor verification, installer accounts and their technical questions.
-- (Columns added to existing tables live in scripts/migrate.js.) Safe to re-run: CREATE TABLE IF NOT EXISTS only.

-- Company documents a vendor uploads for review (CAC certificate, tax number, a photo of the shop ...).
-- These are private: they are never served from the public pictures address, only to the owner and the admin.
CREATE TABLE IF NOT EXISTS verification_documents (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NOT NULL,
  kind          ENUM('cac','tax','id','shop','other') NOT NULL,
  label         VARCHAR(120) NULL,
  mime          VARCHAR(40)  NOT NULL,
  bytes         INT UNSIGNED NOT NULL,
  data          MEDIUMBLOB NULL,
  remote_url    VARCHAR(500) NULL,
  public_id     VARCHAR(200) NULL,
  resource_type ENUM('image','raw') NOT NULL DEFAULT 'image',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_vdocs_user (user_id, id),
  CONSTRAINT fk_vdocs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A technician who installs for customers. Approved by the admin after the technical questions.
CREATE TABLE IF NOT EXISTS installer_profiles (
  user_id             BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  years_experience    TINYINT UNSIGNED NULL,
  verification_status ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
  verification_note   VARCHAR(500) NULL,
  quiz_submitted_at   DATETIME NULL,
  verified_at         DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_installer_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Every time an installer submits the technical questions. The score is for the admin only.
CREATE TABLE IF NOT EXISTS installer_quiz_attempts (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  answers    JSON NOT NULL,
  score      SMALLINT UNSIGNED NOT NULL,
  total      SMALLINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_quiz_user (user_id, id),
  CONSTRAINT fk_quiz_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
