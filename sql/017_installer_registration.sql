-- Phase 2: installer registration. People who vouch for an installer; the admin phones them before approving.
-- (Columns added to installer_profiles live in scripts/migrate.js.) Safe to re-run: CREATE TABLE IF NOT EXISTS only.
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
