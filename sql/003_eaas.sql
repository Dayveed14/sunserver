-- Solalium — Phase 3 schema: how a vendor prices Energy-as-a-Service on a deal.
-- The monthly price is worked out from these terms (see src/modules/marketplace/eaas.js), never typed in.
-- Safe to re-run: CREATE TABLE IF NOT EXISTS only.

USE solalium;

CREATE TABLE IF NOT EXISTS deal_eaas_terms (
  deal_id           BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  tenor_months      SMALLINT UNSIGNED NOT NULL,
  annual_return     DECIMAL(5,4) NOT NULL,           -- target return, e.g. 0.2400 = 24% a year
  equipment_cost    DECIMAL(14,2) NULL,              -- vendor's own cost; NULL = use their product prices
  installation_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
  installation_mode ENUM('upfront','rolled') NOT NULL DEFAULT 'upfront',
  overage_per_kwh   DECIMAL(10,2) NULL,              -- price of energy used beyond the fair-use allowance
  CONSTRAINT fk_eaas_terms_deal FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
) ENGINE=InnoDB;
