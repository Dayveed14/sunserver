// The steps an order goes through for each vendor, who may take each step, and what each step stamps.
// A vendor's part of an order is a "vendor order"; one checkout can contain several.

export const STATUS_LABEL = {
  awaiting_payment: 'Awaiting payment',
  placed: 'Order placed',
  accepted: 'Accepted by vendor',
  preparing: 'Being prepared',
  ready_for_pickup: 'Ready for pickup',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  completed: 'Completed',
  rejected: 'Declined by vendor',
  cancelled: 'Cancelled',
};

export const ACTIONS = {
  accept: { from: ['placed'], to: 'accepted', stamp: 'accepted_at', actors: ['vendor', 'admin'] },
  prepare: { from: ['accepted'], to: 'preparing', stamp: 'preparing_at', actors: ['vendor', 'admin'] },
  ready: { from: ['accepted', 'preparing'], to: 'ready_for_pickup', stamp: 'ready_at', actors: ['vendor', 'admin'] },
  reject: { from: ['placed'], to: 'rejected', actors: ['vendor', 'admin'], refund: true },
  // A rider may collect as soon as the order is accepted: the vendor may have forgotten to press "ready".
  pickup: { from: ['accepted', 'preparing', 'ready_for_pickup'], to: 'out_for_delivery', stamp: 'picked_up_at', stampIfNull: ['ready_at'], actors: ['logistics', 'admin'] },
  deliver: { from: ['out_for_delivery'], to: 'delivered', stamp: 'delivered_at', actors: ['logistics', 'admin'] },
  receive: { from: ['delivered'], to: 'completed', stamp: 'completed_at', actors: ['customer', 'admin'] },
  // Done by the system, not a person: the customer did not confirm within the time allowed.
  autoReceive: { from: ['delivered'], to: 'completed', stamp: 'completed_at', set: { auto_completed: 1 }, actors: ['system'] },
};

// The timeline the customer sees, in order. `at` comes from the timestamps on the vendor order.
export const TIMELINE = [
  { key: 'placed', label: 'Payment confirmed', stamp: 'created_paid' },
  { key: 'accepted', label: 'Vendor accepted', stamp: 'accepted_at' },
  { key: 'preparing', label: 'Preparing your order', stamp: 'preparing_at' },
  { key: 'ready_for_pickup', label: 'Ready for pickup', stamp: 'ready_at' },
  { key: 'out_for_delivery', label: 'Out for delivery', stamp: 'picked_up_at' },
  { key: 'delivered', label: 'Delivered', stamp: 'delivered_at' },
  { key: 'completed', label: 'Received', stamp: 'completed_at' },
];

export function buildTimeline(vo, paidAt) {
  const at = { ...vo, created_paid: paidAt };
  if (vo.status === 'rejected' || vo.status === 'cancelled') {
    return [{ key: vo.status, label: STATUS_LABEL[vo.status], at: null, done: true, current: true }];
  }
  let currentIdx = TIMELINE.findIndex((t) => t.key === vo.status);
  if (currentIdx < 0) currentIdx = -1; // awaiting_payment
  return TIMELINE.map((t, i) => ({
    key: t.key,
    label: t.label,
    at: at[t.stamp] ?? null,
    done: i <= currentIdx || Boolean(at[t.stamp]),
    current: i === currentIdx,
  }));
}
