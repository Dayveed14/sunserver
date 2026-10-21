import { HttpError } from '../lib/httpError.js';

// Small helpers for reading and checking values that come from the URL.

// A numeric id such as /products/12. Anything else is treated as "not found".
export function numId(value) {
  if (!/^\d{1,18}$/.test(String(value))) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  return Number(value);
}

// An order reference such as SL-AB12CD34.
export function orderRef(value) {
  if (!/^SL-[A-Z0-9]{8}$/.test(String(value))) throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
  return String(value);
}

// A short trimmed string from a query parameter, or undefined.
export function queryText(value, max = 60) {
  return typeof value === 'string' ? value.trim().slice(0, max) : undefined;
}

// A status word such as "placed" or "out_for_delivery" from a query parameter, or undefined.
export function queryStatus(value) {
  return typeof value === 'string' && /^[a-z_]{3,20}$/.test(value) ? value : undefined;
}
