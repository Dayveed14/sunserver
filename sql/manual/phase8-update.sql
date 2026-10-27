-- Phase 8 update for a database that already has Phase 7 (for example TiDB Cloud's SQL Editor).
-- 1. Select your database first (in the SQL Editor pick it at the top, or add:  USE your_database_name; ).
-- 2. Run the whole file ONCE. The "ALTER TABLE ... ADD COLUMN" lines fail with "Duplicate column name" if run twice;
--    that is harmless, run the remaining statements one by one.
-- Existing vendors become 'seller' and stay 'pending' until an admin approves them.

ALTER TABLE users MODIFY COLUMN role ENUM('individual','business','vendor','admin','installer') NOT NULL;

ALTER TABLE vendor_profiles ADD COLUMN vendor_type ENUM('seller','company') NOT NULL DEFAULT 'seller';
ALTER TABLE vendor_profiles ADD COLUMN documents_submitted_at DATETIME NULL;
ALTER TABLE vendor_profiles ADD COLUMN verification_note VARCHAR(500) NULL;
ALTER TABLE vendor_profiles ADD COLUMN verified_at DATETIME NULL;
ALTER TABLE products ADD COLUMN includes_controller TINYINT(1) NOT NULL DEFAULT 1;

-- ===== 009_verification =====
-- Phase 8: documents for vendor verification, installer accounts and their technical questions.
-- (Columns added to existing tables live in scripts/migrate.js.) Safe to re-run: CREATE TABLE IF NOT EXISTS only.

-- Company documents a vendor uploads for review (CAC certificate, tax number, a photo of the shop ...).
-- These are private: they are never served from the public pictures address, only to the owner and the admin.
CREATE TABLE IF NOT EXISTS verification_documents (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED NOT NULL,
  kind          ENUM('cac','tax','id','shop','other') NOT NULL,
  label         VARCHAR(120) NULL,
  mime          VARCHAR(40)  NOT NULL,
  bytes         INT UNSIGNED NOT NULL,
  data          MEDIUMBLOB NULL,
  remote_url    VARCHAR(500) NULL,
  public_id     VARCHAR(200) NULL,
  resource_type ENUM('image','raw') NOT NULL DEFAULT 'image',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_vdocs_user (user_id, id),
  CONSTRAINT fk_vdocs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A technician who installs for customers. Approved by the admin after the technical questions.
CREATE TABLE IF NOT EXISTS installer_profiles (
  user_id             BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  years_experience    TINYINT UNSIGNED NULL,
  verification_status ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
  verification_note   VARCHAR(500) NULL,
  quiz_submitted_at   DATETIME NULL,
  verified_at         DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_installer_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Every time an installer submits the technical questions. The score is for the admin only.
CREATE TABLE IF NOT EXISTS installer_quiz_attempts (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  answers    JSON NOT NULL,
  score      SMALLINT UNSIGNED NOT NULL,
  total      SMALLINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_quiz_user (user_id, id),
  CONSTRAINT fk_quiz_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ===== 010_installations =====
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

-- ===== 011_blog =====
-- Blog articles written by the admin: a heading, a picture and text. Shown on the home page and /blog.
CREATE TABLE IF NOT EXISTS articles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(120) NOT NULL UNIQUE,
  title VARCHAR(160) NOT NULL,
  summary VARCHAR(300) NOT NULL DEFAULT '',
  body MEDIUMTEXT NOT NULL,
  image_id BIGINT UNSIGNED NULL,
  status ENUM('draft','published') NOT NULL DEFAULT 'draft',
  author_id BIGINT UNSIGNED NULL,
  published_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_articles_pub (status, published_at),
  CONSTRAINT fk_articles_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE SET NULL
) ENGINE=InnoDB;


-- ===== Phase 8b: monthly vendor subscription =====
-- Three new columns on vendor_profiles. TiDB has no "ADD COLUMN IF NOT EXISTS" in every version, so if a line
-- says "Duplicate column name", that column is already there: skip it and carry on.
ALTER TABLE vendor_profiles ADD COLUMN subscription_paid_until DATETIME NULL;
ALTER TABLE vendor_profiles ADD COLUMN sub_reminded_for DATETIME NULL;
ALTER TABLE vendor_profiles ADD COLUMN sub_lapsed_notified_for DATETIME NULL;

-- ===== 012_subscriptions =====
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
