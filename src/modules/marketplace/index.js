import { env } from '../../config/env.js';
import { assessmentsRepo } from '../../repos/assessments.js';
import { dealsRepo } from '../../repos/deals.js';
import { productsRepo } from '../../repos/products.js';
import { requestsRepo } from '../../repos/requests.js';
import { vendorsRepo } from '../../repos/vendors.js';
import { createCatalogService } from './catalog.service.js';
import { createOffersService } from './offers.service.js';

export const catalogService = createCatalogService({ productsRepo, dealsRepo, requestsRepo, vendorsRepo });
export const offersService = createOffersService({
  productsRepo,
  dealsRepo,
  requestsRepo,
  assessmentsRepo,
  config: { requireVerified: env.vendorApprovalRequired },
});
export { dealsRepo, productsRepo };
