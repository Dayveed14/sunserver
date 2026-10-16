-- Sunledger — Phase 1 schema (MySQL 8 / MariaDB 10.5+)
-- Run with:  npm run db:init

CREATE DATABASE IF NOT EXISTS sunledger CHARACTER SET utf8mb4;
USE sunledger;

-- One login identity for everyone. Role-specific details live in the profile tables.
CREATE TABLE IF NOT EXISTS users (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email                 VARCHAR(254)  NOT NULL,
  password_hash         VARCHAR(100)  NOT NULL,
  role                  ENUM('individual','business','vendor','admin') NOT NULL,
  full_name             VARCHAR(120)  NOT NULL,
  phone                 VARCHAR(20)   NULL,
  email_verified_at     DATETIME      NULL,
  status                ENUM('active','suspended') NOT NULL DEFAULT 'active',
  -- Bump to invalidate every session this user holds (password change, "log out everywhere").
  token_version         INT UNSIGNED  NOT NULL DEFAULT 0,
  failed_login_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until          DATETIME      NULL,
  created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS individual_profiles (
  user_id    BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  home_type  VARCHAR(40) NULL,
  state      VARCHAR(40) NULL,
  city       VARCHAR(80) NULL,
  disco      VARCHAR(20) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_individual_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS business_profiles (
  user_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  company_name VARCHAR(160) NOT NULL,
  industry     VARCHAR(80)  NULL,
  cac_number   VARCHAR(30)  NULL,
  state        VARCHAR(40)  NULL,
  city         VARCHAR(80)  NULL,
  disco        VARCHAR(20)  NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_business_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS vendor_profiles (
  user_id             BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  company_name        VARCHAR(160) NOT NULL,
  service_types       VARCHAR(255) NULL,
  verification_status ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_vendor_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One-time codes for email verification. Only an HMAC of the code is stored.
CREATE TABLE IF NOT EXISTS email_otps (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  purpose     ENUM('verify_email') NOT NULL DEFAULT 'verify_email',
  code_hash   CHAR(64) NOT NULL,
  expires_at  DATETIME NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  consumed_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_otps_user (user_id, purpose, id),
  CONSTRAINT fk_otps_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Saved energy assessments (individual + business customers).
CREATE TABLE IF NOT EXISTS assessments (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id                BIGINT UNSIGNED NOT NULL,
  segment                ENUM('home','business') NOT NULL,
  disco                  VARCHAR(20) NOT NULL,
  supply_band            CHAR(1) NULL,
  kwh_per_day            DECIMAL(10,2) NOT NULL,
  generator_monthly_cost DECIMAL(14,2) NOT NULL,
  solar_system_cost      DECIMAL(14,2) NOT NULL,
  input_json             JSON NOT NULL,
  result_json            JSON NOT NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_assessments_user (user_id, created_at),
  CONSTRAINT fk_assessments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Later phases keep consumption readings in their own table (meter_readings) so it can
-- move to a time-series store without touching anything above.
