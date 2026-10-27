import { stateOf, subscriptionOkSql } from '../utils/subscription.js';
import { query, withTransaction } from '../db/pool.js';

const SELECT = `
  SELECT d.id, d.vendor_id, d.title, d.description, d.installation_included, d.warranty_years,
         d.buy_price, d.lease_deposit, d.lease_monthly, d.lease_months, d.rent_monthly,
         d.eaas_monthly, d.eaas_months, d.status, d.created_at, d.updated_at,
         v.company_name AS vendor_name, v.verification_status AS vendor_verification, v.vendor_type, v.subscription_paid_until,
         di.image_id, va.state AS vendor_state, va.area_id AS vendor_area
  FROM deals d
  JOIN vendor_profiles v ON v.user_id = d.vendor_id
  LEFT JOIN deal_images di ON di.deal_id = d.id
  LEFT JOIN addresses va ON va.user_id = d.vendor_id`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

const toDeal = (r) => ({
  id: Number(r.id),
  vendorId: Number(r.vendor_id),
  vendorName: r.vendor_name,
  vendorVerified: r.vendor_verification === 'verified',
  vendorVerification: r.vendor_verification,
  vendorSubscriptionOk: stateOf({ vendorType: r.vendor_type, paidUntil: r.subscription_paid_until }).ok,
  vendorState: r.vendor_state ?? null,
  vendorArea: r.vendor_area ?? null,
  imageId: r.image_id == null ? null : Number(r.image_id),
  imageUrl: r.image_id == null ? null : `/api/images/${r.image_id}`,
  title: r.title,
  description: r.description,
  installationIncluded: Boolean(r.installation_included),
  warrantyYears: r.warranty_years,
  buyPrice: num(r.buy_price),
  leaseDeposit: num(r.lease_deposit),
  leaseMonthly: num(r.lease_monthly),
  leaseMonths: num(r.lease_months),
  rentMonthly: num(r.rent_monthly),
  eaasMonthly: num(r.eaas_monthly),
  eaasMonths: num(r.eaas_months),
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  eaasTerms: null,
  leaseTerms: null,
  items: [],
});

async function attachItems(deals) {
  if (deals.length === 0) return deals;
  const marks = deals.map(() => '?').join(',');
  const rows = await query(
    `SELECT i.deal_id, i.qty, p.id AS product_id, p.name, p.brand, p.category, p.rating, p.system_voltage,
            p.battery_type, p.price, p.status AS product_status
     FROM deal_items i JOIN products p ON p.id = i.product_id
     WHERE i.deal_id IN (${marks}) ORDER BY FIELD(p.category, 'panel', 'inverter', 'battery')`,
    deals.map((d) => d.id)
  );
  const byDeal = new Map(deals.map((d) => [d.id, d]));
  const terms = await query(
    `SELECT deal_id, tenor_months, annual_return, equipment_cost, installation_cost, installation_mode, overage_per_kwh
     FROM deal_eaas_terms WHERE deal_id IN (${marks})`,
    deals.map((d) => d.id)
  );
  const leases = await query(`SELECT deal_id, deposit_pct, tenors FROM deal_lease_terms WHERE deal_id IN (${marks})`, deals.map((d) => d.id));
  for (const l of leases) {
    byDeal.get(Number(l.deal_id)).leaseTerms = { depositPct: Number(l.deposit_pct), tenors: String(l.tenors).split(',').map(Number) };
  }
  for (const t of terms) {
    byDeal.get(Number(t.deal_id)).eaasTerms = {
      tenorMonths: Number(t.tenor_months),
      annualReturn: Number(t.annual_return),
      equipmentCost: num(t.equipment_cost),
      installationCost: Number(t.installation_cost),
      installationMode: t.installation_mode,
      overagePerKwh: num(t.overage_per_kwh),
    };
  }
  for (const r of rows) {
    byDeal.get(Number(r.deal_id)).items.push({
      productId: Number(r.product_id),
      name: r.name,
      brand: r.brand,
      category: r.category,
      rating: Number(r.rating),
      systemVoltage: r.system_voltage,
      batteryType: r.battery_type,
      price: Number(r.price),
      productStatus: r.product_status,
      qty: Number(r.qty),
    });
  }
  return deals;
}

const dealFields = (d) => [
  d.title, d.description ?? null, d.installationIncluded ? 1 : 0, d.warrantyYears ?? null,
  d.buyPrice ?? null, d.leaseDeposit ?? null, d.leaseMonthly ?? null, d.leaseMonths ?? null,
  d.rentMonthly ?? null, d.eaasMonthly ?? null, d.eaasMonths ?? null, d.status,
];

const writeItems = async (conn, dealId, items) => {
  await conn.execute('DELETE FROM deal_items WHERE deal_id = ?', [dealId]);
  for (const it of items) {
    await conn.execute('INSERT INTO deal_items (deal_id, product_id, qty) VALUES (?, ?, ?)', [dealId, it.productId, it.qty]);
  }
};

const writeTerms = async (conn, dealId, t) => {
  await conn.execute('DELETE FROM deal_eaas_terms WHERE deal_id = ?', [dealId]);
  if (!t) return;
  await conn.execute(
    `INSERT INTO deal_eaas_terms (deal_id, tenor_months, annual_return, equipment_cost, installation_cost, installation_mode, overage_per_kwh)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [dealId, t.tenorMonths, t.annualReturn, t.equipmentCost ?? null, t.installationCost ?? 0, t.installationMode, t.overagePerKwh ?? null]
  );
};

const writeLease = async (conn, dealId, t) => {
  await conn.execute('DELETE FROM deal_lease_terms WHERE deal_id = ?', [dealId]);
  if (!t) return;
  await conn.execute('INSERT INTO deal_lease_terms (deal_id, deposit_pct, tenors) VALUES (?, ?, ?)', [dealId, t.depositPct, [...t.tenors].sort((a, b) => a - b).join(',')]);
};

export const dealsModel = {
  async setImage(dealId, imageId) {
    if (imageId == null) await query('DELETE FROM deal_images WHERE deal_id = ?', [dealId]);
    else {
      await query(
        'INSERT INTO deal_images (deal_id, image_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE image_id = VALUES(image_id)',
        [dealId, imageId]
      );
    }
  },

  async listByVendor(vendorId) {
    const rows = await query(`${SELECT} WHERE d.vendor_id = ? AND d.status <> 'archived' ORDER BY d.id DESC`, [vendorId]);
    return attachItems(rows.map(toDeal));
  },

  async findOwned(id, vendorId) {
    const rows = await query(`${SELECT} WHERE d.id = ? AND d.vendor_id = ? AND d.status <> 'archived' LIMIT 1`, [id, vendorId]);
    const [deal] = await attachItems(rows.map(toDeal));
    return deal ?? null;
  },

  async findActive(id, { requireVerified }) {
    const rows = await query(
      `${SELECT} WHERE d.id = ? AND d.status = 'active' AND ${requireVerified ? `v.verification_status = 'verified' AND ${subscriptionOkSql('v')}` : "v.verification_status <> 'rejected'"} LIMIT 1`,
      [id]
    );
    const [deal] = await attachItems(rows.map(toDeal));
    return deal ?? null;
  },

  async listActive({ requireVerified, state }) {
    const rows = await query(
      `${SELECT} WHERE d.status = 'active' AND ${requireVerified ? `v.verification_status = 'verified' AND ${subscriptionOkSql('v')}` : "v.verification_status <> 'rejected'"}${state ? ' AND va.state = ?' : ''} ORDER BY d.id DESC LIMIT 1000`,
      state ? [state] : []
    );
    return attachItems(rows.map(toDeal));
  },

  async create(vendorId, d) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute(
        `INSERT INTO deals (vendor_id, title, description, installation_included, warranty_years, buy_price,
                            lease_deposit, lease_monthly, lease_months, rent_monthly, eaas_monthly, eaas_months, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [vendorId, ...dealFields(d)]
      );
      await writeItems(conn, res.insertId, d.items);
      await writeTerms(conn, res.insertId, d.eaasTerms);
      await writeLease(conn, res.insertId, d.leaseTerms);
      return res.insertId;
    });
  },

  async update(id, vendorId, d) {
    return withTransaction(async (conn) => {
      const [res] = await conn.execute(
        `UPDATE deals SET title = ?, description = ?, installation_included = ?, warranty_years = ?, buy_price = ?,
                lease_deposit = ?, lease_monthly = ?, lease_months = ?, rent_monthly = ?, eaas_monthly = ?, eaas_months = ?, status = ?
         WHERE id = ? AND vendor_id = ? AND status <> 'archived'`,
        [...dealFields(d), id, vendorId]
      );
      if (res.affectedRows === 0) return false;
      await writeItems(conn, id, d.items);
      await writeTerms(conn, id, d.eaasTerms);
      await writeLease(conn, id, d.leaseTerms);
      return true;
    });
  },

  async setStatus(id, vendorId, status) {
    const res = await query("UPDATE deals SET status = ? WHERE id = ? AND vendor_id = ? AND status <> 'archived'", [status, id, vendorId]);
    return res.affectedRows > 0;
  },

  async countActiveByVendor(vendorId) {
    const rows = await query("SELECT COUNT(*) AS n FROM deals WHERE vendor_id = ? AND status = 'active'", [vendorId]);
    return Number(rows[0].n);
  },
};
