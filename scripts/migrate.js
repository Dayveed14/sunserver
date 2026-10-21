// Changes MySQL cannot do idempotently in plain SQL (it has no "ADD COLUMN IF NOT EXISTS" or "DROP INDEX IF EXISTS").
// init-db runs this after the .sql files. Every step checks first, so it is safe to run again.
export async function migrate(conn, database = 'sunledger') {
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
}
