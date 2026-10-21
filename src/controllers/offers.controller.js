import { asyncHandler } from '../lib/httpError.js';
import { offersService } from '../services/index.js';
import { numId } from '../utils/params.js';

// Everything a customer can choose for one saved assessment, for one way of paying.
export const getOffers = asyncHandler(async (req, res) => {
  res.json(await offersService.getOffers(req.user.id, numId(req.params.id), String(req.query.plan ?? 'buy'), req.user.role));
});

// Prices and checks a DIY selection without sending anything to a vendor.
export const diyQuote = asyncHandler(async (req, res) => res.json(await offersService.quoteDiy(req.user.id, numId(req.params.id), req.valid.items)));

export const createRequests = asyncHandler(async (req, res) => {
  res.status(201).json(await offersService.createRequests(req.user.id, numId(req.params.id), req.valid, req.user.role));
});

export const listMyRequests = asyncHandler(async (req, res) => res.json({ requests: await offersService.listMine(req.user.id) }));

export const cancelRequest = asyncHandler(async (req, res) => {
  await offersService.cancel(req.user.id, numId(req.params.id));
  res.status(204).end();
});
