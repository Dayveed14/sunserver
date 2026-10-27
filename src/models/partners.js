import { query } from '../db/pool.js';
import { subscriptionOkSql } from '../utils/subscription.js';

// The public directory: only accounts that are verified, active and (for vendors) paid up. No email, phone or street address.
export const partnersModel = {
  async vendors() {
    return query(
      `SELECT v.company_name, v.vendor_type, v.service_types, a.state AS state, a.area_id AS area_id,
              (SELECT COUNT(*) FROM products p WHERE p.vendor_id = v.user_id AND p.status = 'active' AND p.in_stock = 1) AS products
       FROM vendor_profiles v
       JOIN users u ON u.id = v.user_id
       LEFT JOIN addresses a ON a.user_id = v.user_id
       WHERE v.verification_status = 'verified' AND u.status = 'active' AND u.email_verified_at IS NOT NULL AND ${subscriptionOkSql('v')}
       ORDER BY v.company_name LIMIT 1000`);
  },
  async installers() {
    return query(
      `SELECT u.full_name, i.years_experience, a.state AS state, a.area_id AS area_id,
              (SELECT COUNT(*) FROM install_requests r WHERE r.installer_id = u.id AND r.status = 'completed') AS jobs_completed
       FROM installer_profiles i
       JOIN users u ON u.id = i.user_id
       LEFT JOIN addresses a ON a.user_id = u.id
       WHERE i.verification_status = 'verified' AND u.status = 'active' AND u.email_verified_at IS NOT NULL
       ORDER BY u.full_name LIMIT 1000`);
  },
};
