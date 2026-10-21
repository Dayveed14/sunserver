-- Sunledger — Phase 4 schema: delivery addresses and product/deal pictures.
-- Safe to re-run: CREATE TABLE IF NOT EXISTS only. (The change that lets one email hold several account
-- types is done by scripts/migrate.js, which init-db runs after these files.)

USE sunledger;

-- Where an account is: a customer's delivery address, or a vendor's pickup location.
CREATE TABLE IF NOT EXISTS addresses (
  user_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  address_line VARCHAR(255) NOT NULL,
  state        VARCHAR(20)  NOT NULL,
  area_id      VARCHAR(60)  NOT NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_addresses_state (state, area_id),
  CONSTRAINT fk_addresses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Uploaded pictures. Stored in the database so they survive restarts on hosts with temporary disks.
CREATE TABLE IF NOT EXISTS images (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_id   BIGINT UNSIGNED NOT NULL,
  mime       VARCHAR(20) NOT NULL,
  bytes      INT UNSIGNED NOT NULL,
  data       MEDIUMBLOB NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_images_owner (owner_id),
  CONSTRAINT fk_images_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS product_images (
  product_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  image_id   BIGINT UNSIGNED NOT NULL,
  CONSTRAINT fk_pimg_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_pimg_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS deal_images (
  deal_id  BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  image_id BIGINT UNSIGNED NOT NULL,
  CONSTRAINT fk_dimg_deal FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE,
  CONSTRAINT fk_dimg_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
) ENGINE=InnoDB;
