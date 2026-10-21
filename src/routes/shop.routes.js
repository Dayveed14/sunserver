import { Router } from 'express';
import * as c from '../controllers/shop.controller.js';
import { shopLimiter } from '../middleware/rateLimits.js';

// Mounted at /api/shop. The public shop: anyone can browse, but only vendors in the state they pick.
// Buying needs an account (see orders.routes.js).
const router = Router();
router.use(shopLimiter);

router.get('/products', c.listProducts);
router.get('/deals', c.listDeals);
router.get('/products/:id', c.productPage);
router.get('/deals/:id', c.dealPage);

export default router;
