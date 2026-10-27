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
