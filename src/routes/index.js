import adminRoutes from './admin.routes.js';
import adminOrdersRoutes from './adminOrders.routes.js';
import analysisRoutes from './analysis.routes.js';
import authRoutes from './auth.routes.js';
import dispatchRoutes from './dispatch.routes.js';
import { adminUploadRouter, vendorUploadRouter, viewRouter } from './images.routes.js';
import offersRoutes from './offers.routes.js';
import ordersRoutes from './orders.routes.js';
import shopRoutes from './shop.routes.js';
import vendorRoutes from './vendor.routes.js';
import vendorFeeRoutes from './vendorFee.routes.js';
import vendorOrdersRoutes from './vendorOrders.routes.js';

// Every URL the API answers. The order matters: more specific paths are listed before general ones
// (/api/vendor/orders before /api/vendor, /api/admin/orders before /api/admin).
export function mountRoutes(app) {
  app.use('/api/auth', authRoutes);
  app.use('/api/analysis', analysisRoutes);
  app.use('/api/vendor/images', vendorUploadRouter);
  app.use('/api/admin/images', adminUploadRouter);
  app.use('/api/images', viewRouter);
  app.use('/api/vendor/fee', vendorFeeRoutes);
  app.use('/api/vendor/orders', vendorOrdersRoutes);
  app.use('/api/vendor', vendorRoutes);
  app.use('/api/admin/orders', adminOrdersRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/dispatch', dispatchRoutes);
  app.use('/api', ordersRoutes);
  app.use('/api/offers', offersRoutes);
  app.use('/api/shop', shopRoutes);
}
