-- Installations like repairs (plan phase 5). Run ONCE on TiDB, after phase4-update.sql and before deploying the API.
-- Do not run it twice: the ADD COLUMN lines fail if a column already exists, and the UPDATE lines must only run once.

ALTER TABLE install_requests MODIFY COLUMN status ENUM('quote','awaiting_payment','open','finding','assigned','on_the_way','on_site','in_progress','installer_done','completed','cancelled') NOT NULL DEFAULT 'quote';
-- Jobs that were broadcast to every installer ("open") become "finding"; they have no ranked list, so the admin assigns them by hand.
UPDATE install_requests SET status = 'finding' WHERE status = 'open';

ALTER TABLE install_requests ADD COLUMN payout_amount INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE install_requests ADD COLUMN refund_amount INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE install_requests ADD COLUMN on_the_way_at DATETIME NULL;
ALTER TABLE install_requests ADD COLUMN arrived_at DATETIME NULL;
ALTER TABLE install_requests ADD COLUMN started_at DATETIME NULL;
ALTER TABLE install_requests ADD COLUMN problem_at DATETIME NULL;
ALTER TABLE install_requests ADD COLUMN problem_note VARCHAR(500) NULL;
-- Earlier jobs: the payout and refund amounts they already had.
UPDATE install_requests SET payout_amount = installer_payout;
UPDATE install_requests SET refund_amount = price WHERE refund_needed = 1;

-- The ranked list for a job. Same meaning as repair_matches.
CREATE TABLE IF NOT EXISTS install_matches (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  installer_id BIGINT UNSIGNED NOT NULL,
  rank_no SMALLINT UNSIGNED NOT NULL,
  score DECIMAL(5,1) NOT NULL,
  distance_km DECIMAL(6,1) NOT NULL,
  status ENUM('queued','recommended','offered','accepted','declined','timed_out','passed') NOT NULL DEFAULT 'queued',
  admin_due_at DATETIME NULL,
  tech_due_at DATETIME NULL,
  decided_by VARCHAR(20) NULL,
  responded_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_im (request_id, installer_id),
  KEY idx_im_status (status, admin_due_at, tech_due_at),
  KEY idx_im_installer (installer_id, status),
  CONSTRAINT fk_im_request FOREIGN KEY (request_id) REFERENCES install_requests(id),
  CONSTRAINT fk_im_installer FOREIGN KEY (installer_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- Pictures from the site: before the work and after it. Private to the customer, the assigned installer and the admin.
CREATE TABLE IF NOT EXISTS install_photos (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  uploader_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('before','after') NOT NULL,
  mime VARCHAR(20) NOT NULL,
  bytes INT UNSIGNED NOT NULL,
  data MEDIUMBLOB NULL,
  remote_url VARCHAR(500) NULL,
  public_id VARCHAR(200) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_iph_request (request_id, kind, id),
  CONSTRAINT fk_iph_request FOREIGN KEY (request_id) REFERENCES install_requests(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS install_completions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL UNIQUE,
  installer_id BIGINT UNSIGNED NOT NULL,
  summary VARCHAR(2000) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ic_request FOREIGN KEY (request_id) REFERENCES install_requests(id),
  CONSTRAINT fk_ic_installer FOREIGN KEY (installer_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS install_reviews (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL UNIQUE,
  customer_id BIGINT UNSIGNED NOT NULL,
  installer_id BIGINT UNSIGNED NOT NULL,
  rating TINYINT UNSIGNED NOT NULL,
  comment VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_irv_installer (installer_id),
  CONSTRAINT fk_irv_request FOREIGN KEY (request_id) REFERENCES install_requests(id),
  CONSTRAINT fk_irv_customer FOREIGN KEY (customer_id) REFERENCES users(id),
  CONSTRAINT fk_irv_installer FOREIGN KEY (installer_id) REFERENCES users(id)
) ENGINE=InnoDB;
