import { Router } from 'express';
import { HttpError, asyncHandler } from '../../lib/httpError.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { estimateLimiter } from '../../middleware/rateLimits.js';
import { validate } from '../../middleware/validate.js';
import { assessmentsRepo } from '../../repos/assessments.js';
import { buildPublicCatalog, catalogs } from './catalog/index.js';
import { estimate } from './calculator.js';
import { ASSUMPTIONS } from './pricing.js';
import { estimateSchema } from './analysis.schemas.js';

const router = Router();
const deps = { catalogs, assumptions: ASSUMPTIONS };
const customers = requireRole('individual', 'business');

// What to show in the picker. Public: the assessment is free and needs no account.
router.get('/catalog/:segment', (req, res, next) => {
  const catalog = buildPublicCatalog(req.params.segment);
  if (!catalog) return next(new HttpError(404, 'UNKNOWN_SEGMENT', 'Choose home or business.'));
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    ...catalog,
    discos: ASSUMPTIONS.discos.map(({ id, name }) => ({ id, name })),
  });
});

// Free, anonymous, stateless. Nothing is stored until the person signs up and saves it.
router.post('/estimate', estimateLimiter, validate(estimateSchema), (req, res) => {
  res.json({ result: estimate(req.valid, deps) });
});

// Saving recalculates from the raw ticks on the server; we never trust a result sent by the browser.
router.post(
  '/assessments',
  authenticate,
  customers,
  validate(estimateSchema),
  asyncHandler(async (req, res) => {
    const input = req.valid;
    const result = estimate(input, deps);
    const id = await assessmentsRepo.create({
      userId: req.user.id,
      segment: input.segment,
      disco: input.disco,
      supplyBand: input.supplyBand ?? null,
      input,
      result,
    });
    res.status(201).json({ id, result });
  })
);

router.get(
  '/assessments',
  authenticate,
  customers,
  asyncHandler(async (req, res) => {
    const rows = await assessmentsRepo.listByUser(req.user.id);
    res.json({
      assessments: rows.map((r) => ({
        id: Number(r.id),
        segment: r.segment,
        disco: r.disco,
        supplyBand: r.supply_band,
        kwhPerDay: r.kwh_per_day,
        generatorMonthlyCost: r.generator_monthly_cost,
        solarSystemCost: r.solar_system_cost,
        createdAt: r.created_at,
      })),
    });
  })
);

router.get(
  '/assessments/:id',
  authenticate,
  customers,
  asyncHandler(async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Assessment not found.');
    const row = await assessmentsRepo.findForUser(req.params.id, req.user.id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Assessment not found.');
    res.json({ id: Number(row.id), createdAt: row.created_at, input: row.input_json, result: row.result_json });
  })
);

export default router;
