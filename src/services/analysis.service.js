import { HttpError } from '../lib/httpError.js';
import { estimate } from '../utils/calculator.js';
import { buildPublicCatalog, catalogs } from '../utils/catalog/index.js';
import { ASSUMPTIONS } from '../utils/pricing.js';

// The free solar assessment: what to show in the picker, the estimate itself, and saving a result.
export function createAnalysisService({ assessmentsModel }) {
  const deps = { catalogs, assumptions: ASSUMPTIONS };
  const notFound = () => new HttpError(404, 'NOT_FOUND', 'Assessment not found.');

  return {
    publicCatalog(segment) {
      const catalog = buildPublicCatalog(segment);
      if (!catalog) throw new HttpError(404, 'UNKNOWN_SEGMENT', 'Choose home or business.');
      return { ...catalog, discos: ASSUMPTIONS.discos.map(({ id, name }) => ({ id, name })) };
    },

    estimate: (input) => estimate(input, deps),

    // Saving recalculates from the raw ticks on the server; we never trust a result sent by the browser.
    async save(userId, input) {
      const result = estimate(input, deps);
      const id = await assessmentsModel.create({
        userId, segment: input.segment, disco: input.disco, supplyBand: input.supplyBand ?? null, input, result,
      });
      return { id, result };
    },

    async list(userId) {
      const rows = await assessmentsModel.listByUser(userId);
      return {
        assessments: rows.map((r) => ({
          id: Number(r.id), segment: r.segment, disco: r.disco, supplyBand: r.supply_band,
          kwhPerDay: r.kwh_per_day, generatorMonthlyCost: r.generator_monthly_cost,
          solarSystemCost: r.solar_system_cost, createdAt: r.created_at,
        })),
      };
    },

    async get(userId, id) {
      if (!/^\d{1,18}$/.test(String(id))) throw notFound();
      const row = await assessmentsModel.findForUser(id, userId);
      if (!row) throw notFound();
      return { id: Number(row.id), createdAt: row.created_at, input: row.input_json, result: row.result_json };
    },
  };
}
