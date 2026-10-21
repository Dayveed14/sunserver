import { env } from '../../config/env.js';
import { assessmentsRepo } from '../../repos/assessments.js';
import { dealsRepo } from '../../repos/deals.js';
import { imagesRepo } from '../../repos/images.js';
import { productsRepo } from '../../repos/products.js';
import { requestsRepo } from '../../repos/requests.js';
import { vendorsRepo } from '../../repos/vendors.js';
import { createCatalogService } from './catalog.service.js';
import { feesService } from '../delivery/index.js';
import { createOffersService } from './offers.service.js';
import { createShopService } from './shop.service.js';

export const catalogService = createCatalogService({ productsRepo, dealsRepo, requestsRepo, vendorsRepo, imagesRepo });
export const offersService = createOffersService({
  productsRepo,
  dealsRepo,
  requestsRepo,
  assessmentsRepo,
  config: { requireVerified: env.vendorApprovalRequired },
});
export const shopService = createShopService({ productsRepo, dealsRepo, feesService, config: { requireVerified: env.vendorApprovalRequired } });
export { dealsRepo, productsRepo };
