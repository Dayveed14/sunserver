-- Solariun — Phase 4 schema: delivery prices per vendor, orders, payments.
-- Safe to re-run: CREATE TABLE IF NOT EXISTS only.

USE solalium;

-- What it costs to deliver from a vendor to every area in their state. Worked out when the vendor registers or moves.
CREATE TABLE IF NOT EXISTS vendor_delivery_fees (
  vendor_id   BIGINT UNSIGNED NOT NULL,
  area_id     VARCHAR(60) NOT NULL,
  distance_km DECIMAL(6,1) NOT NULL,
  fee         DECIMAL(10,2) NOT NULL,
  computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (vendor_id, area_id),
  CONSTRAINT fk_vdf_vendor FOREIGN KEY (vendor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One checkout by one customer. It can include several vendors; each vendor's share is a vendor_order below.
CREATE TABLE IF NOT EXISTS orders (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_ref      VARCHAR(24) NOT NULL,
  customer_id     BIGINT UNSIGNED NOT NULL,
  status          ENUM('pending_payment','paid','cancelled') NOT NULL DEFAULT 'pending_payment',
  ship_name       VARCHAR(120) NOT NULL,
  ship_phone      VARCHAR(20)  NOT NULL,
  ship_address    VARCHAR(255) NOT NULL,
  ship_state      VARCHAR(20)  NOT NULL,
  ship_area       VARCHAR(60)  NOT NULL,
  subtotal        DECIMAL(14,2) NOT NULL,
  delivery_fee    DECIMAL(14,2) NOT NULL,
  total           DECIMAL(14,2) NOT NULL,
  -- Sent by the app so that clicking "Pay" twice (or a network retry) cannot create two orders.
  idempotency_key VARCHAR(64) NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at         DATETIME NULL,
  UNIQUE KEY uq_orders_ref (public_ref),
  UNIQUE KEY uq_orders_idem (customer_id, idempotency_key),
  KEY idx_orders_customer (customer_id, id),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- The part of an order that one vendor fulfils, with its own delivery and its own life cycle.
CREATE TABLE IF NOT EXISTS vendor_orders (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id     BIGINT UNSIGNED NOT NULL,
  vendor_id    BIGINT UNSIGNED NOT NULL,
  status       ENUM('awaiting_payment','placed','accepted','preparing','ready_for_pickup','out_for_delivery','delivered','completed','rejected','cancelled') NOT NULL DEFAULT 'awaiting_payment',
  subtotal     DECIMAL(14,2) NOT NULL,
  delivery_fee DECIMAL(14,2) NOT NULL,
  distance_km  DECIMAL(6,1) NOT NULL,
  promised_by  DATETIME NULL,
  accepted_at  DATETIME NULL,
  preparing_at DATETIME NULL,
  ready_at     DATETIME NULL,
  picked_up_at DATETIME NULL,
  delivered_at DATETIME NULL,
  completed_at DATETIME NULL,
  auto_completed TINYINT(1) NOT NULL DEFAULT 0,
  refund_needed  TINYINT(1) NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_vo_vendor (vendor_id, status, id),
  KEY idx_vo_status (status, delivered_at),
  KEY idx_vo_order (order_id),
  CONSTRAINT fk_vo_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_vo_vendor FOREIGN KEY (vendor_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- What was bought, with the name and price as they were at checkout.
CREATE TABLE IF NOT EXISTS order_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id        BIGINT UNSIGNED NOT NULL,
  vendor_order_id BIGINT UNSIGNED NOT NULL,
  kind            ENUM('product','deal') NOT NULL,
  ref_id          BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(160) NOT NULL,
  image_id        BIGINT UNSIGNED NULL,
  unit_price      DECIMAL(14,2) NOT NULL,
  qty             SMALLINT UNSIGNED NOT NULL,
  line_total      DECIMAL(14,2) NOT NULL,
  KEY idx_oi_order (order_id),
  KEY idx_oi_vo (vendor_order_id),
  CONSTRAINT fk_oi_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_oi_vo FOREIGN KEY (vendor_order_id) REFERENCES vendor_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Every step, for the customer's timeline and the admin's monitoring.
CREATE TABLE IF NOT EXISTS order_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id        BIGINT UNSIGNED NOT NULL,
  vendor_order_id BIGINT UNSIGNED NULL,
  actor_type      ENUM('system','customer','vendor','admin','logistics') NOT NULL,
  actor_id        BIGINT UNSIGNED NULL,
  type            VARCHAR(40) NOT NULL,
  note            VARCHAR(255) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_oe_order (order_id, id),
  CONSTRAINT fk_oe_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS payments (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id      BIGINT UNSIGNED NOT NULL,
  reference     VARCHAR(64) NOT NULL,
  provider      VARCHAR(20) NOT NULL DEFAULT 'paystack',
  amount        DECIMAL(14,2) NOT NULL,
  currency      CHAR(3) NOT NULL DEFAULT 'NGN',
  status        ENUM('initiated','success','failed') NOT NULL DEFAULT 'initiated',
  authorization_url VARCHAR(255) NULL,
  access_code   VARCHAR(64) NULL,
  paid_at       DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payments_ref (reference),
  KEY idx_payments_order (order_id),
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Paystack may send the same event more than once. The key is recorded first, so a repeat is recognised and ignored.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_key   VARCHAR(140) NOT NULL PRIMARY KEY,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
