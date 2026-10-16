import { HttpError } from '../lib/httpError.js';

// validate(schema) parses req.body and exposes the cleaned result as req.valid.
export const validate = (schema) => (req, res, next) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const fields = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    return next(new HttpError(400, 'VALIDATION_ERROR', 'Please check the highlighted fields.', { fields }));
  }
  req.valid = parsed.data;
  next();
};
