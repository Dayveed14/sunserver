-- Repairs, part A (plan phase 3). Run ONCE on TiDB before deploying the API. Safe to re-run: every statement is CREATE TABLE IF NOT EXISTS.

-- Repairs (plan phase 3). A customer reports a fault and pays a call-out fee; the system ranks technicians and recommends one
-- to the admin; the technician visits, inspects and reports; the customer sees an itemised cost. (Paying for the repair itself,
-- variations, completion and reviews arrive in phase 4: their statuses are already in the enum.)
CREATE TABLE IF NOT EXISTS repair_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_ref VARCHAR(20) NOT NULL UNIQUE,
  customer_id BIGINT UNSIGNED NOT NULL,
  status ENUM('quote','awaiting_payment','finding','assigned','on_the_way','on_site','inspected','approved','in_repair','awaiting_parts','repair_done','completed','cancelled') NOT NULL DEFAULT 'quote',
  fault_type VARCHAR(20) NOT NULL,
  description VARCHAR(1500) NOT NULL,
  equipment JSON NOT NULL,
  urgency ENUM('normal','urgent') NOT NULL DEFAULT 'normal',
  state VARCHAR(40) NOT NULL,
  area_id VARCHAR(60) NOT NULL,
  address_line VARCHAR(255) NOT NULL,
  contact_name VARCHAR(160) NOT NULL,
  contact_phone VARCHAR(30) NOT NULL,
  call_out_fee INT UNSIGNED NOT NULL,
  fee_band VARCHAR(8) NOT NULL,
  distance_km DECIMAL(6,1) NOT NULL,
  technician_id BIGINT UNSIGNED NULL,
  paid_at DATETIME NULL,
  assigned_at DATETIME NULL,
  on_the_way_at DATETIME NULL,
  arrived_at DATETIME NULL,
  inspected_at DATETIME NULL,
  cancelled_at DATETIME NULL,
  cancel_reason VARCHAR(300) NULL,
  refund_amount INT UNSIGNED NOT NULL DEFAULT 0,
  refund_needed TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rr_customer (customer_id, id),
  KEY idx_rr_status (status),
  KEY idx_rr_tech (technician_id, status),
  CONSTRAINT fk_rr_customer FOREIGN KEY (customer_id) REFERENCES users(id),
  CONSTRAINT fk_rr_tech FOREIGN KEY (technician_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS repair_payments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  purpose VARCHAR(20) NOT NULL DEFAULT 'call_out',
  reference VARCHAR(40) NOT NULL UNIQUE,
  amount INT UNSIGNED NOT NULL,
  status ENUM('initiated','success','failed') NOT NULL DEFAULT 'initiated',
  authorization_url VARCHAR(500) NULL,
  access_code VARCHAR(100) NULL,
  paid_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rp_request (request_id, id),
  CONSTRAINT fk_rp_request FOREIGN KEY (request_id) REFERENCES repair_requests(id)
) ENGINE=InnoDB;

-- The ranked list for a job. status: queued (waiting its turn), recommended (the admin decides), offered (the admin approved:
-- the technician decides), accepted, declined, timed_out, passed (the admin said no).
CREATE TABLE IF NOT EXISTS repair_matches (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  technician_id BIGINT UNSIGNED NOT NULL,
  rank_no SMALLINT UNSIGNED NOT NULL,
  score DECIMAL(5,1) NOT NULL,
  distance_km DECIMAL(6,1) NOT NULL,
  status ENUM('queued','recommended','offered','accepted','declined','timed_out','passed') NOT NULL DEFAULT 'queued',
  admin_due_at DATETIME NULL,
  tech_due_at DATETIME NULL,
  decided_by VARCHAR(10) NULL,
  responded_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rm (request_id, technician_id),
  KEY idx_rm_status (status, admin_due_at, tech_due_at),
  KEY idx_rm_tech (technician_id, status),
  CONSTRAINT fk_rm_request FOREIGN KEY (request_id) REFERENCES repair_requests(id),
  CONSTRAINT fk_rm_tech FOREIGN KEY (technician_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS repair_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(40) NOT NULL,
  actor VARCHAR(20) NOT NULL,
  note VARCHAR(300) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_re_request (request_id, id),
  CONSTRAINT fk_re_request FOREIGN KEY (request_id) REFERENCES repair_requests(id)
) ENGINE=InnoDB;

-- Pictures: of the fault (customer) or of the inspection (technician). Private to the customer, the assigned technician and the admin.
CREATE TABLE IF NOT EXISTS repair_photos (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  uploader_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('fault','inspection') NOT NULL,
  mime VARCHAR(20) NOT NULL,
  bytes INT UNSIGNED NOT NULL,
  data MEDIUMBLOB NULL,
  remote_url VARCHAR(500) NULL,
  public_id VARCHAR(200) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rph_request (request_id, kind, id),
  CONSTRAINT fk_rph_request FOREIGN KEY (request_id) REFERENCES repair_requests(id)
) ENGINE=InnoDB;

-- The technician's inspection report. parts is a list of { name, qty, unitPrice }.
CREATE TABLE IF NOT EXISTS repair_reports (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL UNIQUE,
  technician_id BIGINT UNSIGNED NOT NULL,
  findings VARCHAR(2000) NOT NULL,
  parts JSON NOT NULL,
  labour INT UNSIGNED NOT NULL DEFAULT 0,
  estimated_hours SMALLINT UNSIGNED NOT NULL,
  total INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rrep_request FOREIGN KEY (request_id) REFERENCES repair_requests(id),
  CONSTRAINT fk_rrep_tech FOREIGN KEY (technician_id) REFERENCES users(id)
) ENGINE=InnoDB;
