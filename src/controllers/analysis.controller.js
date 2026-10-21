import { asyncHandler } from '../lib/httpError.js';
import { analysisService } from '../services/index.js';

// What to show in the picker. Public: the assessment is free and needs no account.
export function catalog(req, res) {
  const body = analysisService.publicCatalog(req.params.segment);
  res.set('Cache-Control', 'public, max-age=300');
  res.json(body);
}

// Free, anonymous, stateless. Nothing is stored until the person signs up and saves it.
export const estimate = (req, res) => res.json({ result: analysisService.estimate(req.valid) });

export const saveAssessment = asyncHandler(async (req, res) => res.status(201).json(await analysisService.save(req.user.id, req.valid)));
export const listAssessments = asyncHandler(async (req, res) => res.json(await analysisService.list(req.user.id)));
export const getAssessment = asyncHandler(async (req, res) => res.json(await analysisService.get(req.user.id, req.params.id)));
