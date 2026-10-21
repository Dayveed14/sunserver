-- Sunledger — Phase 4 schema: lease to own as "pay small small" (3, 4, 6 or 12 months).
-- Safe to re-run: CREATE TABLE IF NOT EXISTS only.

USE sunledger;

CREATE TABLE IF NOT EXISTS deal_lease_terms (
  deal_id     BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  deposit_pct DECIMAL(5,4) NOT NULL,       -- 0.3000 = 30% of the cash price up front
  tenors      VARCHAR(20) NOT NULL,        -- plan lengths offered, e.g. "3,6,12"
  CONSTRAINT fk_lease_terms_deal FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
) ENGINE=InnoDB;
