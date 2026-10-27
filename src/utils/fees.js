// How Solalium earns money.
//  0. A monthly subscription for vendors (sellers and companies). A price of 0 means that type pays nothing.
//  1. A one-time registration fee paid by each vendor (only once registration is switched to paid: see config/launch.js).
//  2. A service charge on every purchase, split between the two sides: the customer pays 10% on top of the items,
//     and 10% is held back from what the vendor receives (20% of the item value in total).
// The customer sees only "Service charge". The vendor sees what they will earn after the platform fee.
export const FEE_RULES = {
  vendorRegistrationFee: 100000, // naira, once per vendor
  vendorSubscriptionSeller: 0, // naira per month for sellers; 0 = no subscription (the admin switches it on in Pricing & rules)
  vendorSubscriptionCompany: 0, // naira per month for companies
  subscriptionGraceDays: 7, // days after the paid-up date before listings are hidden
  customerServicePct: 0.1, // added to the customer's items
  vendorCommissionPct: 0.1, // taken from the vendor's items
};

// Whole naira, rounded to the nearest naira so totals always add up.
const naira = (n) => Math.round(n);

export const customerServiceCharge = (itemsTotal, rules = FEE_RULES) => naira(itemsTotal * rules.customerServicePct);
export const vendorCommission = (itemsTotal, rules = FEE_RULES) => naira(itemsTotal * rules.vendorCommissionPct);
export const vendorEarnings = (itemsTotal, rules = FEE_RULES) => itemsTotal - vendorCommission(itemsTotal, rules);
