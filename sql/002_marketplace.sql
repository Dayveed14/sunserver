-- Sunledger — Phase 2 schema: vendor products, combos/deals, and customer requests.
-- Safe to run on an existing database: every statement is CREATE TABLE IF NOT EXISTS.
-- Run with:  npm run db:init

USE sunledger;

-- A single sellable item a vendor lists. `rating` means a different unit per category:
--   panel    -> watts per panel (e.g. 550)
--   inverter -> kVA (e.g. 1.5)
--   battery  -> usable kWh per unit (e.g. 2.4)
-- system_voltage is the unit voltage for inverters and batteries (12, 24 or 48).
CREATE TABLE IF NOT EXISTS products (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vendor_id      BIGINT UNSIGNED NOT NULL,
  category       ENUM('panel','inverter','battery') NOT NULL,
  name           VARCHAR(120) NOT NULL,
  brand          VARCHAR(60)  NULL,
  rating         DECIMAL(10,2) NOT NULL,
  system_voltage TINYINT UNSIGNED NULL,
  battery_type   ENUM('lithium','gel','tubular','agm') NULL,
  price          DECIMAL(14,2) NOT NULL,
  in_stock       TINYINT(1) NOT NULL DEFAULT 1,
  warranty_years TINYINT UNSIGNED NULL,
  description    VARCHAR(500) NULL,
  -- 'archived' is how a vendor "deletes" a product: deals and past requests keep pointing at it.
  status         ENUM('active','hidden','archived') NOT NULL DEFAULT 'active',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_products_vendor (vendor_id, status),
  KEY idx_products_category (category, status, rating),
  CONSTRAINT fk_products_vendor FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A package the vendor curates from their own products, with their own prices.
-- Which plans it is offered under is decided by which price columns are filled in.
-- System size (kWp / kVA / kWh) is always worked out from the items, never typed in.
CREATE TABLE IF NOT EXISTS deals (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  vendor_id             BIGINT UNSIGNED NOT NULL,
  title                 VARCHAR(120) NOT NULL,
  description           VARCHAR(600) NULL,
  installation_included TINYINT(1) NOT NULL DEFAULT 1,
  warranty_years        TINYINT UNSIGNED NULL,
  buy_price             DECIMAL(14,2) NULL,
  lease_deposit         DECIMAL(14,2) NULL,
  lease_monthly         DECIMAL(14,2) NULL,
  lease_months          SMALLINT UNSIGNED NULL,
  rent_monthly          DECIMAL(14,2) NULL,
  eaas_monthly          DECIMAL(14,2) NULL,
  eaas_months           SMALLINT UNSIGNED NULL,
  status                ENUM('draft','active','paused','archived') NOT NULL DEFAULT 'draft',
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_deals_vendor (vendor_id, status),
  KEY idx_deals_status (status),
  CONSTRAINT fk_deals_vendor FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS deal_items (
  deal_id    BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  qty        SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (deal_id, product_id),
  CONSTRAINT fk_deal_items_deal FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE,
  CONSTRAINT fk_deal_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- A customer asking a vendor for a deal, or for the parts they picked in the DIY builder.
-- summary_json is a snapshot of exactly what was offered and at what price when they asked,
-- so later edits to the vendor's listing never change an existing request.
CREATE TABLE IF NOT EXISTS quote_requests (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id   BIGINT UNSIGNED NOT NULL,
  vendor_id     BIGINT UNSIGNED NOT NULL,
  assessment_id BIGINT UNSIGNED NULL,
  kind          ENUM('deal','diy') NOT NULL,
  deal_id       BIGINT UNSIGNED NULL,
  plan          ENUM('buy','lease','rent','eaas') NOT NULL,
  upfront_price DECIMAL(14,2) NULL,
  monthly_price DECIMAL(14,2) NULL,
  summary_json  JSON NOT NULL,
  message       VARCHAR(500) NULL,
  status        ENUM('new','contacted','won','lost','cancelled') NOT NULL DEFAULT 'new',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_requests_vendor (vendor_id, status, id),
  KEY idx_requests_customer (customer_id, id),
  CONSTRAINT fk_requests_customer FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_requests_vendor FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_requests_assessment FOREIGN KEY (assessment_id) REFERENCES assessments(id) ON DELETE SET NULL,
  CONSTRAINT fk_requests_deal FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL
) ENGINE=InnoDB;
