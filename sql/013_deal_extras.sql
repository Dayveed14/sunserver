-- Items a vendor types into a deal that are not in their product list (a name, how many, and a price each).
-- Safe to re-run: CREATE TABLE IF NOT EXISTS only. (The longer product description is changed in scripts/migrate.js.)
CREATE TABLE IF NOT EXISTS deal_extras (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  deal_id    BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(120) NOT NULL,
  qty        SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  unit_price DECIMAL(14,2) NOT NULL,
  KEY idx_deal_extras_deal (deal_id),
  CONSTRAINT fk_deal_extras_deal FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
) ENGINE=InnoDB;
