import { query } from '../db/pool.js';

// MySQL returns JSON columns already parsed; MariaDB returns strings.
const parseJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

export const assessmentsRepo = {
  async create({ userId, segment, disco, supplyBand, input, result }) {
    const res = await query(
      `INSERT INTO assessments
        (user_id, segment, disco, supply_band, kwh_per_day, generator_monthly_cost, solar_system_cost, input_json, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        segment,
        disco,
        supplyBand ?? null,
        result.usage.kwhPerDay,
        result.generator.monthlyCost,
        result.solar.systemCost,
        JSON.stringify(input),
        JSON.stringify(result),
      ]
    );
    return res.insertId;
  },

  async listByUser(userId) {
    return query(
      `SELECT id, segment, disco, supply_band, kwh_per_day, generator_monthly_cost, solar_system_cost, created_at
       FROM assessments WHERE user_id = ? ORDER BY id DESC LIMIT 100`,
      [userId]
    );
  },

  async findForUser(id, userId) {
    const rows = await query(
      'SELECT id, segment, disco, supply_band, input_json, result_json, created_at FROM assessments WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId]
    );
    const row = rows[0];
    if (!row) return null;
    return { ...row, input_json: parseJson(row.input_json), result_json: parseJson(row.result_json) };
  },
};
