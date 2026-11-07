import { HttpError } from '../lib/httpError.js';
import { estimate } from '../utils/calculator.js';
import { buildPublicCatalog, catalogs } from '../utils/catalog/index.js';
import { ASSUMPTIONS } from '../utils/pricing.js';
import { BACKUP_BY_KEY } from '../utils/catalog/hours.js';
import { buildConfigurations, publicConfigurations } from '../utils/configurations.js';

// The free solar assessment: what to show in the picker, the estimate itself, and saving a result.
export function createAnalysisService({ assessmentsModel }) {
  const deps = { catalogs, assumptions: ASSUMPTIONS };

  // The guided flow sends a backup time, priorities and which configuration to price. Older requests have none of that and
  // get exactly the result they always did.
  const guided = (input) => Boolean(input.backupKey || input.priorities?.length || input.configKey || input.criticalIds?.length);

  function compute(input) {
    if (!guided(input)) return { ...estimate(input, deps), budget: input.budget || null };
    const backupHours = input.backupKey ? BACKUP_BY_KEY.get(input.backupKey).hours : undefined;
    const known = new Set(input.items.map((i) => i.applianceId));
    const base = { ...input, backupHours, criticalIds: (input.criticalIds ?? []).filter((id) => known.has(id)) };
    const built = buildConfigurations(base, deps);
    const wanted = input.configKey && input.configKey !== 'auto' ? input.configKey : built.recommended;
    // If the one asked for no longer exists (answers changed), fall back to the one we suggest.
    const chosen = built.ordered.find((c) => c.key === wanted) ?? built.ordered.find((c) => c.key === built.recommended);
    return { ...chosen.result, budget: input.budget || null, configurations: publicConfigurations(built, chosen.key) };
  }

  const notFound = () => new HttpError(404, 'NOT_FOUND', 'Assessment not found.');

  return {
    publicCatalog(segment) {
      const catalog = buildPublicCatalog(segment);
      if (!catalog) throw new HttpError(404, 'UNKNOWN_SEGMENT', 'Choose home or business.');
      return { ...catalog, discos: ASSUMPTIONS.discos.map(({ id, name }) => ({ id, name })) };
    },

    estimate: (input) => compute(input),

    // Saving recalculates from the raw ticks on the server; we never trust a result sent by the browser.
    async save(userId, input) {
      const result = compute(input);
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
