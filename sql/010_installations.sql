-- Installation requests: a customer asks for an installer, pays the quoted fee, and the job goes to approved installers in their state.
CREATE TABLE IF NOT EXISTS install_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_ref VARCHAR(20) NOT NULL UNIQUE,
  customer_id BIGINT UNSIGNED NOT NULL,
  status ENUM('quote','awaiting_payment','open','assigned','installer_done','completed','cancelled') NOT NULL DEFAULT 'quote',
  description VARCHAR(1000) NOT NULL,
  system_kw DECIMAL(6,2) NOT NULL,
  band_id VARCHAR(8) NOT NULL,
  band_label VARCHAR(60) NOT NULL,
  price INT UNSIGNED NOT NULL,
  installer_payout INT UNSIGNED NOT NULL,
  state VARCHAR(40) NOT NULL,
  area_id VARCHAR(60) NOT NULL,
  address_line VARCHAR(255) NOT NULL,
  contact_name VARCHAR(160) NOT NULL,
  contact_phone VARCHAR(30) NOT NULL,
  preferred_date DATE NOT NULL,
  installer_id BIGINT UNSIGNED NULL,
  open_at DATETIME NULL,
  assigned_at DATETIME NULL,
  installer_done_at DATETIME NULL,
  completed_at DATETIME NULL,
  alerted_at DATETIME NULL,
  cancelled_at DATETIME NULL,
  cancel_reason VARCHAR(300) NULL,
  refund_needed TINYINT(1) NOT NULL DEFAULT 0,
  payout_status ENUM('none','owed','paid') NOT NULL DEFAULT 'none',
  payout_paid_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ir_customer (customer_id, id),
  KEY idx_ir_status (status, state),
  KEY idx_ir_installer (installer_id, status),
  CONSTRAINT fk_ir_customer FOREIGN KEY (customer_id) REFERENCES users(id),
  CONSTRAINT fk_ir_installer FOREIGN KEY (installer_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS install_payments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  reference VARCHAR(40) NOT NULL UNIQUE,
  amount INT UNSIGNED NOT NULL,
  status ENUM('initiated','success','failed') NOT NULL DEFAULT 'initiated',
  authorization_url VARCHAR(500) NULL,
  access_code VARCHAR(100) NULL,
  paid_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ip_request (request_id, id),
  CONSTRAINT fk_ip_request FOREIGN KEY (request_id) REFERENCES install_requests(id)
) ENGINE=InnoDB;

-- One row per installer the job was sent to.
CREATE TABLE IF NOT EXISTS install_offers (
  request_id BIGINT UNSIGNED NOT NULL,
  installer_id BIGINT UNSIGNED NOT NULL,
  response ENUM('pending','accepted','declined','lost') NOT NULL DEFAULT 'pending',
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME NULL,
  PRIMARY KEY (request_id, installer_id),
  KEY idx_io_installer (installer_id, response),
  CONSTRAINT fk_io_request FOREIGN KEY (request_id) REFERENCES install_requests(id),
  CONSTRAINT fk_io_installer FOREIGN KEY (installer_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS install_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(40) NOT NULL,
  actor VARCHAR(20) NOT NULL,
  note VARCHAR(300) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ie_request (request_id, id),
  CONSTRAINT fk_ie_request FOREIGN KEY (request_id) REFERENCES install_requests(id)
) ENGINE=InnoDB;
