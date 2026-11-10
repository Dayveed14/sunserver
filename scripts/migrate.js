import { PRODUCT_CATEGORIES } from '../src/utils/productCategories.js';

// Changes MySQL cannot do idempotently in plain SQL (it has no "ADD COLUMN IF NOT EXISTS" or "DROP INDEX IF EXISTS").
// init-db runs this after the .sql files. Every step checks first, so it is safe to run again.
export async function migrate(conn, database = 'solalium') {
  const indexes = async (table) => {
    const [rows] = await conn.query(
      'SELECT index_name AS name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? GROUP BY index_name',
      [database, table]
    );
    return new Map(rows.map((r) => [r.name, r.cols]));
  };

  // One email may hold one account of each type (individual, business, vendor), but never two of the same type.
  const idx = await indexes('users');
  if (idx.has('uq_users_email') && idx.get('uq_users_email') === 'email') {
    await conn.query('ALTER TABLE users ADD UNIQUE KEY uq_users_email_role (email, role)');
    await conn.query('ALTER TABLE users DROP INDEX uq_users_email');
    console.log('Migrated: users are now unique per (email, role).');
  } else if (!idx.has('uq_users_email_role')) {
    await conn.query('ALTER TABLE users ADD UNIQUE KEY uq_users_email_role (email, role)');
  }

  // Columns added in later phases. Each is checked first, so this is safe to run again.
  const hasColumn = async (table, column) => {
    const [rows] = await conn.query('SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?', [database, table, column]);
    return rows.length > 0;
  };
  const addColumn = async (table, column, definition) => {
    if (!(await hasColumn(table, column))) {
      await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`Migrated: ${table}.${column} added.`);
    }
  };
  // Vendors who joined before registration became paid stay 'waived' (free for good).
  await addColumn('vendor_profiles', 'registration_fee_status', "ENUM('waived','unpaid','paid') NOT NULL DEFAULT 'waived'");
  await addColumn('vendor_profiles', 'registration_paid_at', 'DATETIME NULL');
  // The service charge the customer paid, and the platform fee held back from the vendor, are saved on each order.
  await addColumn('orders', 'service_charge', 'DECIMAL(14,2) NOT NULL DEFAULT 0');
  await addColumn('vendor_orders', 'service_charge', 'DECIMAL(14,2) NOT NULL DEFAULT 0');
  await addColumn('vendor_orders', 'commission', 'DECIMAL(14,2) NOT NULL DEFAULT 0');
  // Pictures can live on Cloudinary: then only the web address is kept here and the bytes are not.
  await addColumn('images', 'remote_url', 'VARCHAR(500) NULL');
  await addColumn('images', 'public_id', 'VARCHAR(200) NULL');
  const [dataCol] = await conn.query("SELECT is_nullable AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = 'images' AND column_name = 'data'", [database]);
  if (dataCol[0]?.n === 'NO') {
    await conn.query('ALTER TABLE images MODIFY data MEDIUMBLOB NULL');
    console.log('Migrated: images.data may now be empty (Cloudinary).');
  }

  // More kinds of solar product (controllers, cables, pumps, kits ...). New values are only ever added at the end of the list.
  const [catCol] = await conn.query("SELECT column_type AS t FROM information_schema.columns WHERE table_schema = ? AND table_name = 'products' AND column_name = 'category'", [database]);
  if (catCol[0] && !catCol[0].t.includes("'kit'")) {
    await conn.query(`ALTER TABLE products MODIFY COLUMN category ENUM(${PRODUCT_CATEGORIES.map((c) => `'${c}'`).join(',')}) NOT NULL`);
    console.log('Migrated: products.category now accepts all solar product types.');
  }

  // Phase 8: installers are a new kind of account, and vendors come in two types and go through document verification.
  const [roleCol] = await conn.query("SELECT column_type AS t FROM information_schema.columns WHERE table_schema = ? AND table_name = 'users' AND column_name = 'role'", [database]);
  if (roleCol[0] && !roleCol[0].t.includes("'installer'")) {
    await conn.query("ALTER TABLE users MODIFY COLUMN role ENUM('individual','business','vendor','admin','installer') NOT NULL");
    console.log('Migrated: users.role now accepts installers.');
  }
  // Phase 9: field agents (created by the admin) run site audits for businesses.
  if (roleCol[0] && !(await conn.query("SELECT column_type AS t FROM information_schema.columns WHERE table_schema = ? AND table_name = 'users' AND column_name = 'role'", [database]))[0][0].t.includes("'field_agent'")) {
    await conn.query("ALTER TABLE users MODIFY COLUMN role ENUM('individual','business','vendor','admin','installer','field_agent') NOT NULL");
    console.log('Migrated: users.role now accepts field agents.');
  }
  // Site photos and signatures are private: the public picture address refuses them.
  await addColumn('images', 'is_private', 'TINYINT(1) NOT NULL DEFAULT 0');
  // 'seller' sells only. 'company' sells, installs and may offer Energy-as-a-Service. Everyone who joined before is a seller until the admin says otherwise.
  await addColumn('vendor_profiles', 'vendor_type', "ENUM('seller','company') NOT NULL DEFAULT 'seller'");
  await addColumn('vendor_profiles', 'documents_submitted_at', 'DATETIME NULL');
  await addColumn('vendor_profiles', 'verification_note', 'VARCHAR(500) NULL');
  await addColumn('vendor_profiles', 'verified_at', 'DATETIME NULL');
  // Monthly subscription: when a vendor is paid up to, and which reminders were already sent for that date.
  // Blog sections and categories; every existing article stays in News.
  await addColumn('articles', 'section', "VARCHAR(12) NOT NULL DEFAULT 'news'");
  await addColumn('articles', 'category', "VARCHAR(30) NOT NULL DEFAULT 'news'");
  await addColumn('articles', 'event_date', 'DATE NULL');
  await addColumn('articles', 'event_place', 'VARCHAR(120) NULL');

  // Product descriptions can be long now (up to 5,000 characters).
  const [descCol] = await conn.query("SELECT data_type AS t FROM information_schema.columns WHERE table_schema = ? AND table_name = 'products' AND column_name = 'description'", [database]);
  if (descCol[0] && String(descCol[0].t).toLowerCase() === 'varchar') {
    await conn.query('ALTER TABLE products MODIFY COLUMN description TEXT NULL');
    console.log('Migrated: products.description is now TEXT.');
  }
  await addColumn('vendor_profiles', 'subscription_paid_until', 'DATETIME NULL');
  await addColumn('vendor_profiles', 'sub_reminded_for', 'DATETIME NULL');
  await addColumn('vendor_profiles', 'sub_lapsed_notified_for', 'DATETIME NULL');
  // Does an inverter already contain the solar charge controller (most hybrid inverters do)? If not, buyers are told to add one.
  await addColumn('products', 'includes_controller', 'TINYINT(1) NOT NULL DEFAULT 1');

  // Phase 2 (installer registration): the fuller sign-up, two references and optional photos and a certificate.
  // Installers who joined before this stay on the old rules (flow_version 1): they keep working and are not asked for references.
  const hadFlowVersion = await hasColumn('installer_profiles', 'flow_version');
  await addColumn('installer_profiles', 'flow_version', 'TINYINT UNSIGNED NOT NULL DEFAULT 2');
  await addColumn('installer_profiles', 'registration_submitted_at', 'DATETIME NULL');
  await addColumn('installer_profiles', 'business_status', "ENUM('cac','none','other') NULL");
  await addColumn('installer_profiles', 'travel_km', 'SMALLINT UNSIGNED NULL');
  await addColumn('installer_profiles', 'experience_band', "ENUM('lt1','y1_3','y4_6','y7_10','gt10') NULL");
  await addColumn('installer_profiles', 'qualification', "ENUM('yes','no','training') NULL");
  await addColumn('installer_profiles', 'about', 'VARCHAR(1000) NULL');
  await addColumn('installer_profiles', 'project_types', 'JSON NULL');
  await addColumn('installer_profiles', 'capacity', 'TINYINT UNSIGNED NULL');
  await addColumn('installer_profiles', 'response_time', "ENUM('1h','4h','24h','48h') NULL");
  await addColumn('installer_profiles', 'accepts_repairs', 'TINYINT(1) NOT NULL DEFAULT 1');
  if (!hadFlowVersion) {
    await conn.query('UPDATE installer_profiles SET flow_version = 1, registration_submitted_at = quiz_submitted_at');
    console.log('Migrated: existing installers stay on the original approval rules.');
  }
  const [docKind] = await conn.query("SELECT column_type AS t FROM information_schema.columns WHERE table_schema = ? AND table_name = 'verification_documents' AND column_name = 'kind'", [database]);
  if (docKind[0] && !docKind[0].t.includes("'certificate'")) {
    await conn.query("ALTER TABLE verification_documents MODIFY COLUMN kind ENUM('cac','tax','id','shop','other','certificate','work','photo') NOT NULL");
    console.log('Migrated: verification_documents.kind now accepts installer certificates and photos.');
  }
  // Phase 4 (repairs, part B): quote approval and payment, the repair itself, completion, payout.
  const hadAgreed = await hasColumn('repair_requests', 'agreed_total');
  await addColumn('repair_requests', 'agreed_total', 'INT UNSIGNED NULL');
  await addColumn('repair_requests', 'paid_amount', 'INT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('repair_requests', 'approved_at', 'DATETIME NULL');
  await addColumn('repair_requests', 'repair_started_at', 'DATETIME NULL');
  await addColumn('repair_requests', 'repair_done_at', 'DATETIME NULL');
  await addColumn('repair_requests', 'completed_at', 'DATETIME NULL');
  await addColumn('repair_requests', 'confirm_due_at', 'DATETIME NULL');
  await addColumn('repair_requests', 'problem_at', 'DATETIME NULL');
  await addColumn('repair_requests', 'problem_note', 'VARCHAR(500) NULL');
  await addColumn('repair_requests', 'parts_note', 'VARCHAR(300) NULL');
  await addColumn('repair_requests', 'payout_amount', 'INT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('repair_requests', 'payout_status', "ENUM('none','owed','paid') NOT NULL DEFAULT 'none'");
  await addColumn('repair_requests', 'payout_paid_at', 'DATETIME NULL');
  await addColumn('repair_payments', 'variation_id', 'BIGINT UNSIGNED NULL');
  if (!hadAgreed) await conn.query('UPDATE repair_requests SET paid_amount = call_out_fee WHERE paid_at IS NOT NULL AND status <> \'cancelled\'');
  const [photoKind] = await conn.query("SELECT column_type AS t FROM information_schema.columns WHERE table_schema = ? AND table_name = 'repair_photos' AND column_name = 'kind'", [database]);
  if (photoKind[0] && !photoKind[0].t.includes("'completion'")) {
    await conn.query("ALTER TABLE repair_photos MODIFY COLUMN kind ENUM('fault','inspection','completion') NOT NULL");
    console.log('Migrated: repair_photos.kind now accepts completion pictures.');
  }
  // Phase 5 (installations like repairs): more statuses, visit steps, problems, amounts.
  const [instStatus] = await conn.query("SELECT column_type AS t FROM information_schema.columns WHERE table_schema = ? AND table_name = 'install_requests' AND column_name = 'status'", [database]);
  if (instStatus[0] && !instStatus[0].t.includes("'finding'")) {
    await conn.query("ALTER TABLE install_requests MODIFY COLUMN status ENUM('quote','awaiting_payment','open','finding','assigned','on_the_way','on_site','in_progress','installer_done','completed','cancelled') NOT NULL DEFAULT 'quote'");
    await conn.query("UPDATE install_requests SET status = 'finding' WHERE status = 'open'");
    console.log('Migrated: install_requests has the repair-style statuses; open jobs are now "finding".');
  }
  const hadPayoutAmount = await hasColumn('install_requests', 'payout_amount');
  await addColumn('install_requests', 'payout_amount', 'INT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('install_requests', 'refund_amount', 'INT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('install_requests', 'on_the_way_at', 'DATETIME NULL');
  await addColumn('install_requests', 'arrived_at', 'DATETIME NULL');
  await addColumn('install_requests', 'started_at', 'DATETIME NULL');
  await addColumn('install_requests', 'problem_at', 'DATETIME NULL');
  await addColumn('install_requests', 'problem_note', 'VARCHAR(500) NULL');
  if (!hadPayoutAmount) {
    await conn.query('UPDATE install_requests SET payout_amount = installer_payout');
    await conn.query('UPDATE install_requests SET refund_amount = price WHERE refund_needed = 1');
  }
}
