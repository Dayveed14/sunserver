-- General site audits with admin review (plan phase 6). Run ONCE on TiDB, after phase5-update.sql and before deploying the API.
-- Do not run it twice: the ADD COLUMN lines fail if a column already exists, and the UPDATE lines must only run once.

ALTER TABLE site_audits MODIFY COLUMN status ENUM('requested','assigned','in_progress','submitted','technical_review','completed','reopened') NOT NULL DEFAULT 'requested';
ALTER TABLE site_audits ADD COLUMN submitted_at DATETIME NULL;
ALTER TABLE site_audits ADD COLUMN approved_at DATETIME NULL;
ALTER TABLE site_audits ADD COLUMN approved_version INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE site_audits ADD COLUMN needs_technical TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE site_audits ADD COLUMN technical_note VARCHAR(500) NULL;
ALTER TABLE audit_versions ADD COLUMN approved_at DATETIME NULL;

-- Audits finished before review existed were released the moment they were submitted: mark them approved.
UPDATE site_audits SET approved_version = version, approved_at = completed_at WHERE assessment_id IS NOT NULL;
UPDATE audit_versions SET approved_at = created_at;
-- Old plaza-form audits need no change: they are read through the new layout and upgraded only if reopened.
