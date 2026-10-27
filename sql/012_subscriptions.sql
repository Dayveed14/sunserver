-- Monthly vendor subscription payments. (Columns added to existing tables live in scripts/migrate.js.)
-- Safe to re-run: CREATE TABLE IF NOT EXISTS only.
CREATE TABLE IF NOT EXISTS subscription_payments (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vendor_id     BIGINT UNSIGNED NOT NULL,
  reference     VARCHAR(64) NOT NULL,
  amount        DECIMAL(14,2) NOT NULL,
  months        TINYINT UNSIGNED NOT NULL DEFAULT 1,
  status        ENUM('initiated','success','failed') NOT NULL DEFAULT 'initiated',
  authorization_url VARCHAR(500) NULL,
  access_code   VARCHAR(100) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at       DATETIME NULL,
  paid_until    DATETIME NULL,
  UNIQUE KEY uq_subpay_reference (reference),
  KEY idx_subpay_vendor (vendor_id, id),
  CONSTRAINT fk_subpay_vendor FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
