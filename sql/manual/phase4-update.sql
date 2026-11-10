-- Repairs, part B (plan phase 4). Run ONCE on TiDB, after phase3-update.sql and before deploying the API.
-- Do not run it twice: the ADD COLUMN lines fail if a column already exists, and the UPDATE below must only run once.

ALTER TABLE repair_requests ADD COLUMN agreed_total INT UNSIGNED NULL;
ALTER TABLE repair_requests ADD COLUMN paid_amount INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE repair_requests ADD COLUMN approved_at DATETIME NULL;
ALTER TABLE repair_requests ADD COLUMN repair_started_at DATETIME NULL;
ALTER TABLE repair_requests ADD COLUMN repair_done_at DATETIME NULL;
ALTER TABLE repair_requests ADD COLUMN completed_at DATETIME NULL;
ALTER TABLE repair_requests ADD COLUMN confirm_due_at DATETIME NULL;
ALTER TABLE repair_requests ADD COLUMN problem_at DATETIME NULL;
ALTER TABLE repair_requests ADD COLUMN problem_note VARCHAR(500) NULL;
ALTER TABLE repair_requests ADD COLUMN parts_note VARCHAR(300) NULL;
ALTER TABLE repair_requests ADD COLUMN payout_amount INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE repair_requests ADD COLUMN payout_status ENUM('none','owed','paid') NOT NULL DEFAULT 'none';
ALTER TABLE repair_requests ADD COLUMN payout_paid_at DATETIME NULL;
ALTER TABLE repair_payments ADD COLUMN variation_id BIGINT UNSIGNED NULL;
ALTER TABLE repair_photos MODIFY COLUMN kind ENUM('fault','inspection','completion') NOT NULL;
-- Requests paid before this phase: count the call-out fee they already paid.
UPDATE repair_requests SET paid_amount = call_out_fee WHERE paid_at IS NOT NULL AND status <> 'cancelled';

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
