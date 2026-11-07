-- Phase 10a: "notify me" list for energy categories that are not live yet. Run once on TiDB before deploying the API.
CREATE TABLE IF NOT EXISTS category_interest (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  category VARCHAR(20) NOT NULL,
  email VARCHAR(190) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  UNIQUE KEY uq_interest (category, email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
