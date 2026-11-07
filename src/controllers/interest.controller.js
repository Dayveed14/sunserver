import { asyncHandler } from '../lib/httpError.js';
import { interestService } from '../services/index.js';

export const add = asyncHandler(async (req, res) => res.status(201).json(await interestService.add(req.valid)));
export const summary = asyncHandler(async (req, res) => res.json(await interestService.summary()));
