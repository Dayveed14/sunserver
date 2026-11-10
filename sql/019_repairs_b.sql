-- Repairs, part B (plan phase 4). The customer approves and pays the quote in the app, the technician repairs (with "waiting for
-- parts" and variations the customer approves), reports completion, the customer confirms (or it closes by itself), the technician's
-- payout is recorded, and the customer leaves a review. New columns on repair_requests / repair_payments / repair_photos are added by
-- scripts/migrate.js (local) or sql/manual/phase4-update.sql (TiDB).
CREATE TABLE IF NOT EXISTS repair_variations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  technician_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  parts JSON NOT NULL,
  labour INT UNSIGNED NOT NULL DEFAULT 0,
  extra_total INT UNSIGNED NOT NULL,
  status ENUM('proposed','approved','declined','withdrawn') NOT NULL DEFAULT 'proposed',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME NULL,
  KEY idx_rv_request (request_id, id),
  CONSTRAINT fk_rv_request FOREIGN KEY (request_id) REFERENCES repair_requests(id),
  CONSTRAINT fk_rv_tech FOREIGN KEY (technician_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS repair_completions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL UNIQUE,
  technician_id BIGINT UNSIGNED NOT NULL,
  summary VARCHAR(2000) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rc_request FOREIGN KEY (request_id) REFERENCES repair_requests(id),
  CONSTRAINT fk_rc_tech FOREIGN KEY (technician_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS repair_reviews (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL UNIQUE,
  customer_id BIGINT UNSIGNED NOT NULL,
  technician_id BIGINT UNSIGNED NOT NULL,
  rating TINYINT UNSIGNED NOT NULL,
  comment VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rrv_tech (technician_id),
  CONSTRAINT fk_rrv_request FOREIGN KEY (request_id) REFERENCES repair_requests(id),
  CONSTRAINT fk_rrv_customer FOREIGN KEY (customer_id) REFERENCES users(id),
  CONSTRAINT fk_rrv_tech FOREIGN KEY (technician_id) REFERENCES users(id)
) ENGINE=InnoDB;
