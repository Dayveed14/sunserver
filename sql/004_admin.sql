-- Solalium — Phase 3b schema: password reset links, admin-editable pricing settings, admin audit trail.
-- Safe to re-run: CREATE TABLE IF NOT EXISTS only.

USE solalium;

-- Password reset links. Only a SHA-256 of the token is stored, so a database leak cannot be used to reset accounts.
CREATE TABLE IF NOT EXISTS password_resets (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reset_token (token_hash),
  KEY idx_reset_user (user_id, id),
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Values an admin has changed from the defaults in code. A missing row means "use the default".
CREATE TABLE IF NOT EXISTS pricing_settings (
  setting_key VARCHAR(80) NOT NULL PRIMARY KEY,
  value       DECIMAL(18,6) NOT NULL,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Who changed what, and when.
CREATE TABLE IF NOT EXISTS admin_audit (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admin_id   BIGINT UNSIGNED NULL,
  action     VARCHAR(40) NOT NULL,
  target     VARCHAR(120) NOT NULL,
  detail     JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_created (id)
) ENGINE=InnoDB;
