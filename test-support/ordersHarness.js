import crypto from 'node:crypto';
import { createFeesService } from '../src/services/deliveryFees.service.js';
import { createDispatchTokens } from '../src/lib/dispatchToken.js';
import { createPaystack } from '../src/lib/paystack.js';
import { createNotifier } from '../src/services/notifier.js';
import { createOrdersService } from '../src/services/orders.service.js';
import { createMemoryOrdersModel } from './memoryOrders.js';

// A small shop to buy from: two Lagos vendors and one in Abuja, all verified.
export function createHarness({ now = () => new Date('2026-10-19T09:00:00Z'), requireVerified = false, fees } = {}) {
  const vendors = {
    10: { id: 10, email: 'v10@x.ng', fullName: 'Vee Ten', phone: '+2348011111110', companyName: 'Bright Solar', state: 'lagos', area: 'ikeja' },
    11: { id: 11, email: 'v11@x.ng', fullName: 'Vee Eleven', phone: '+2348011111111', companyName: 'Volt Hub', state: 'lagos', area: 'victoria-island' },
    12: { id: 12, email: 'v12@x.ng', fullName: 'Vee Twelve', phone: '+2348011111112', companyName: 'Abuja Power', state: 'abuja', area: 'garki' },
  };
  const customers = { 1: { id: 1, email: 'c1@x.ng', fullName: 'Chi One' }, 2: { id: 2, email: 'c2@x.ng', fullName: 'Ola Two' } };
  const directory = {
    customer: (id) => customers[id],
    vendor: (id) => ({ ...vendors[id], address: { line: '1 Shop Rd', state: vendors[id].state, areaId: vendors[id].area } }),
  };

  const mk = (id, vendorId, extra) => ({
    id, vendorId, vendorName: vendors[vendorId].companyName, vendorVerification: 'verified', vendorState: vendors[vendorId].state, vendorArea: vendors[vendorId].area,
    imageId: null, imageUrl: null, status: 'active', inStock: true, brand: 'Acme', ...extra,
  });
  const products = [
    mk(1, 10, { name: 'Panel 550W', price: 100000 }),
    mk(2, 11, { name: 'Inverter 5kVA', price: 450000 }),
    mk(3, 12, { name: 'Battery 200Ah', price: 300000 }),
    mk(4, 10, { name: 'Out of stock thing', price: 5000, inStock: false }),
  ];
  const deals = [mk(20, 10, { title: 'Home starter kit', buyPrice: 900000, items: [{ productStatus: 'active' }] })];
  const productsModel = { async findManyByIds(ids) { return products.filter((p) => ids.includes(p.id)).map((p) => ({ ...p })); } };
  const dealsModel = { async findActive(id) { const d = deals.find((x) => x.id === id && x.status === 'active'); return d ? { ...d } : null; } };

  const saved = new Map();
  const feeModel = {
    async vendorLocation(id) { return { vendorId: id, state: vendors[id].state, areaId: vendors[id].area }; },
    async vendorLocations() { return Object.values(vendors).map((v) => ({ vendorId: v.id, state: v.state, areaId: v.area })); },
    async replaceForVendor(id, rows) { saved.set(id, rows); },
    async forVendors(ids) { return ids.flatMap((id) => (saved.get(id) ?? []).map((r) => ({ vendorId: id, ...r }))); },
  };
  const feesService = createFeesService({ model: feeModel });

  const clock = { t: now() };
  const ordersModel = createMemoryOrdersModel(directory, () => clock.t);
  const secretKey = 'sk_test_secret';
  const paystack = createPaystack({ secretKey: '', clientOrigin: 'http://localhost:5173', isProd: false });
  const sent = [];
  const mailer = { async sendNotification(m) { sent.push(m); } };
  const tokens = createDispatchTokens('dispatch-secret-dispatch-secret-1234');
  const notifier = createNotifier({ mailer, config: { logisticsEmail: 'rider@logistics.ng', adminEmail: 'admin@sunledger.ng', appUrl: 'http://localhost:5173' }, tokens, now });
  const config = { requireVerified, maxQty: 20, maxTotal: 20_000_000, callbackUrl: 'http://localhost:5173/checkout/return', pendingExpiryHours: 24, pollMs: 2 };
  const service = createOrdersService({ productsModel, dealsModel, ordersModel, feesService, paystack, notifier, config, ...(fees ? { feeRules: fees } : {}), now: () => clock.t });

  const dest = { name: 'Chi One', phone: '+2348022222222', line: '5 Buyer St', state: 'lagos', areaId: 'yaba' };
  const key = () => crypto.randomBytes(12).toString('hex');
  return { service, ordersModel, paystack, sent, tokens, products, deals, clock, vendors, customers, dest, key, secretKey, feesService, setClock: (d) => { clock.t = d; } };
}
