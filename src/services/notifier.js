import { STATUS_LABEL } from '../utils/lifecycle.js';
import { formatLagos } from '../utils/sla.js';
import { findArea, stateName } from '../utils/areas.js';

const naira = (n) => `₦${Number(n).toLocaleString('en-NG')}`;
const place = (state, areaId, line) => `${line ? `${line}, ` : ''}${findArea(state, areaId)?.name ?? areaId}, ${stateName(state) ?? state}`;

// Turns order events into emails: to the customer, the vendor, the logistics partner, and a copy to the admin.
// A failed email never blocks an order, so every send is caught and logged.
export function createNotifier({ mailer, config, tokens, now = () => new Date() }) {
  const { logisticsEmail, adminEmail, appUrl } = config;
  const link = (path) => `${appUrl.replace(/\/$/, '')}${path}`;

  async function send(to, message) {
    if (!to || (Array.isArray(to) && to.length === 0)) return;
    try {
      await mailer.sendNotification({ to, ...message });
    } catch (err) {
      console.error(`[notify] could not email ${Array.isArray(to) ? to.join(',') : to}: ${err.message}`);
    }
  }

  const itemsText = (items) => items.map((i) => `${i.qty} × ${i.name}`).join(', ');
  const when = (iso) => (iso ? formatLagos(new Date(iso).toISOString(), now()) : 'soon');

  // ctx: { order, vo, items, customer, vendor }
  const describe = (ctx) => {
    const { order, vo, items, customer, vendor } = ctx;
    const from = vendor.address ? place(vendor.address.state, vendor.address.areaId, vendor.address.line) : 'the vendor';
    const to = place(order.shipState, order.shipArea, order.shipAddress);
    return {
      ref: order.publicRef,
      shortItems: itemsText(items),
      from,
      to,
      vendorName: vendor.companyName,
      customerName: customer.fullName,
      promised: when(vo?.promisedBy),
    };
  };

  async function dispatchRequest(ctx, heading, extra) {
    const d = describe(ctx);
    const { vo } = ctx;
    await send(logisticsEmail, {
      subject: `${heading} · ${d.ref}`,
      heading,
      lines: [
        `Order ${d.ref} (${d.vendorName}).`,
        `Pick up from: ${d.from}`,
        `Deliver to: ${d.to}. Contact ${ctx.order.shipName}, ${ctx.order.shipPhone}.`,
        `Items: ${d.shortItems}.`,
        `Delivery promised by: ${d.promised}.`,
        ...extra,
      ],
      // The rider can confirm the pickup with one tap, no account needed.
      button: { label: 'Mark picked up', url: link(`/dispatch?t=${encodeURIComponent(tokens.sign(vo.id, 'pickup'))}`) },
    });
  }

  const handlers = {
    // Payment is confirmed: the customer is told, and the admin gets a copy. Each vendor is told of their own part.
    async payment_confirmed({ order, parts, customer }) {
      await send(customer.email, {
        subject: `Payment confirmed · ${order.publicRef}`,
        heading: 'Payment confirmed',
        lines: [
          `Hi ${customer.fullName}, we have your payment of ${naira(order.total)} for order ${order.publicRef}.`,
          'Your vendor has been asked to confirm the order. We will email you at every step.',
        ],
        button: { label: 'Track your order', url: link(`/app/orders/${order.publicRef}`) },
      });
      await send(adminEmail, {
        subject: `Paid order ${order.publicRef} · ${naira(order.total)}`,
        heading: `New paid order ${order.publicRef}`,
        lines: [`${customer.fullName} paid ${naira(order.total)} (items ${naira(order.subtotal)}, service charge ${naira(order.serviceCharge ?? 0)}, delivery ${naira(order.deliveryFee)}).`, `${parts.length} vendor(s) involved.`],
      });
      for (const p of parts) await handlers.new_order(p);
    },

    async new_order(ctx) {
      const d = describe(ctx);
      await send(ctx.vendor.email, {
        subject: `New order ${d.ref} to accept`,
        heading: 'You have a new paid order',
        lines: [`Order ${d.ref}: ${d.shortItems}.`, `Items ${naira(ctx.vo.subtotal)}; after the Solariun platform fee you receive ${naira(Number(ctx.vo.subtotal) - Number(ctx.vo.commission ?? 0))}. It goes to ${d.to}.`, 'Please accept it so a rider can be sent and the customer knows it is on the way.'],
        button: { label: 'Open orders', url: link('/app/orders') },
      });
    },

    async accepted(ctx) {
      const d = describe(ctx);
      await send(ctx.customer.email, {
        subject: `Order accepted · ${d.ref}`,
        heading: 'Your order has been accepted',
        lines: [`${d.vendorName} accepted order ${d.ref} (${d.shortItems}).`, `A rider is being sent. We expect to deliver by ${d.promised}.`],
        button: { label: 'Track your order', url: link(`/app/orders/${d.ref}`) },
      });
      await dispatchRequest(ctx, 'Please send a rider', ['The order is being prepared now.']);
      await send(adminEmail, { subject: `Accepted · ${d.ref}`, heading: `${d.vendorName} accepted ${d.ref}`, lines: [`Rider requested from the logistics partner. Promised by ${d.promised}.`] });
    },

    async preparing(ctx) {
      const d = describe(ctx);
      await send(ctx.customer.email, { subject: `Being prepared · ${d.ref}`, heading: 'Your order is being prepared', lines: [`${d.vendorName} is preparing order ${d.ref}.`] });
    },

    async ready(ctx) {
      const d = describe(ctx);
      await send(ctx.customer.email, { subject: `Ready for pickup · ${d.ref}`, heading: 'Your order is ready', lines: [`Order ${d.ref} is packed and waiting for the rider.`] });
      await dispatchRequest(ctx, 'Order ready for pickup', ['The vendor has marked it ready.']);
      await send(adminEmail, { subject: `Ready · ${d.ref}`, heading: `${d.ref} ready for pickup`, lines: [`${d.vendorName} has it packed.`] });
    },

    async picked_up(ctx) {
      const d = describe(ctx);
      await send(ctx.customer.email, {
        subject: `Out for delivery · ${d.ref}`,
        heading: 'Your order is on its way',
        lines: [`The rider has collected order ${d.ref} from ${d.vendorName}. Expected by ${d.promised}.`],
        button: { label: 'Track your order', url: link(`/app/orders/${d.ref}`) },
      });
      await send(logisticsEmail, {
        subject: `Out for delivery · ${d.ref}`,
        heading: `Order ${d.ref} is out for delivery`,
        lines: [`Deliver to: ${d.to}. Contact ${ctx.order.shipName}, ${ctx.order.shipPhone}.`, 'When it reaches the customer, mark it delivered:'],
        button: { label: 'Mark delivered', url: link(`/dispatch?t=${encodeURIComponent(tokens.sign(ctx.vo.id, 'deliver'))}`) },
      });
      await send(adminEmail, { subject: `Out for delivery · ${d.ref}`, heading: `${d.ref} picked up`, lines: [`${d.vendorName} to ${d.to}.`] });
    },

    async delivered(ctx) {
      const d = describe(ctx);
      await send(ctx.customer.email, {
        subject: `Delivered · ${d.ref}`,
        heading: 'Your order has been delivered',
        lines: [`Order ${d.ref} was delivered. Please confirm you received it within ${ctx.autoReceiveHours} hours. If we do not hear from you, we will mark it received automatically.`],
        button: { label: 'Confirm received', url: link(`/app/orders/${d.ref}`) },
      });
      await send(logisticsEmail, { subject: `Delivered · ${d.ref}`, heading: `Order ${d.ref} delivered`, lines: ['Thank you. This delivery is closed on our side.'] });
      await send(adminEmail, { subject: `Delivered · ${d.ref}`, heading: `${d.ref} delivered`, lines: [`${d.vendorName} to ${d.to}.`] });
    },

    async completed(ctx) {
      const d = describe(ctx);
      const how = ctx.auto ? 'automatically, because it was not confirmed in time' : 'by the customer';
      await send(ctx.vendor.email, { subject: `Order completed · ${d.ref}`, heading: 'Order completed', lines: [`Order ${d.ref} was marked received ${how}.`] });
      await send(adminEmail, { subject: `Completed · ${d.ref}`, heading: `${d.ref} completed`, lines: [`Marked received ${how}.`] });
    },

    async rejected(ctx) {
      const d = describe(ctx);
      await send(ctx.customer.email, {
        subject: `Order declined · ${d.ref}`,
        heading: 'Your vendor could not fulfil an order',
        lines: [`${d.vendorName} could not fulfil order ${d.ref} (${d.shortItems}).${ctx.note ? ` Reason: ${ctx.note}` : ''}`, `You will be refunded ${naira(Number(ctx.vo.subtotal) + Number(ctx.vo.serviceCharge ?? 0) + Number(ctx.vo.deliveryFee))} for this part of the order.`],
      });
      await send(adminEmail, { subject: `REFUND NEEDED · ${d.ref}`, heading: `Refund needed for ${d.ref}`, lines: [`${d.vendorName} declined. Refund ${naira(Number(ctx.vo.subtotal) + Number(ctx.vo.serviceCharge ?? 0) + Number(ctx.vo.deliveryFee))} to ${d.customerName}.`] });
    },

    // ---- verification (vendors and installers) ----
    async verification_submitted({ who, kind }) {
      await send(adminEmail, { subject: `${kind} awaiting review · ${who}`, heading: `${kind} awaiting review`, lines: [`${who} has sent details for review.`], button: { label: 'Open the review queue', url: link('/admin/vendors') } });
    },
    async verification_decided({ user, approved, note, subject }) {
      await send(user.email, {
        subject: approved ? `You are verified · ${subject}` : `Your verification needs attention · ${subject}`,
        heading: approved ? 'You are verified' : 'We could not approve you yet',
        lines: approved
          ? [`Hi ${user.fullName}, your account has been approved. You can now use your dashboard.`]
          : [`Hi ${user.fullName}, we could not approve your account yet.`, note ? `Reason: ${note}` : 'Please check your documents and send them again.'],
        button: { label: 'Open your dashboard', url: link('/app') },
      });
    },
    async installer_quiz_submitted({ who }) {
      await send(adminEmail, { subject: `Installer quiz received · ${who}`, heading: 'An installer finished the quiz', lines: [`${who} has answered the technical questions and is waiting for your decision.`], button: { label: 'Review installers', url: link('/admin/installers') } });
    },

    // ---- vendor subscription ----
    async subscription_paid({ vendor, amount, months, paidUntil }) {
      await send(vendor.email, {
        subject: 'Subscription received', heading: 'Thank you, your subscription is paid',
        lines: [`Hi ${vendor.fullName}, we received ${naira(amount)} for ${months} month${months === 1 ? '' : 's'}.`, `Your listings stay live until ${new Date(paidUntil).toDateString()}.`],
        button: { label: 'Open your subscription', url: link('/app/subscription') },
      });
    },
    async subscription_due({ vendor, paidUntil, amount }) {
      await send(vendor.email, {
        subject: 'Your Solariun subscription is due soon', heading: 'Your subscription runs out soon',
        lines: [`Hi ${vendor.fullName}, your monthly subscription runs out on ${new Date(paidUntil).toDateString()}.`, `Renew (${naira(amount)} a month) to keep your products and deals visible to customers.`],
        button: { label: 'Renew now', url: link('/app/subscription') },
      });
    },
    async subscription_lapsed({ vendor, amount }) {
      await send(vendor.email, {
        subject: 'Your listings are hidden: subscription ended', heading: 'Your products and deals are hidden',
        lines: [`Hi ${vendor.fullName}, your subscription has ended, so customers no longer see your products and deals, and you cannot add new ones.`, `Pay ${naira(amount)} to bring everything back straight away. Nothing you posted was deleted.`],
        button: { label: 'Renew now', url: link('/app/subscription') },
      });
    },

    // ---- installation requests ----
    async install_paid({ request, customer }) {
      await send(customer.email, {
        subject: `Installation request paid · ${request.ref}`, heading: 'We are finding an installer',
        lines: [`Hi ${customer.fullName}, we received your payment of ${naira(request.price)} for installation ${request.ref}.`, 'We have sent your job to approved installers in your state. You will get an email the moment one accepts.'],
        button: { label: 'Track your request', url: link(`/app/installations/${request.ref}`) },
      });
      await send(adminEmail, { subject: `Paid installation ${request.ref} · ${naira(request.price)}`, heading: `New installation ${request.ref}`, lines: [`${customer.fullName} paid ${naira(request.price)} for ${request.systemKw} kW (${request.bandLabel}).`, `Place: ${place(request.state, request.areaId)}. Preferred date: ${request.preferredDate}.`], button: { label: 'Open installations', url: link('/app/admin-installations') } });
    },
    async install_new_job({ request, installer, offer }) {
      await send(installer.email, {
        subject: `New installation job · ${offer.area} · ${naira(offer.pay)}`, heading: 'A new installation job',
        lines: [`Hi ${installer.fullName}, a customer needs an installation.`, `What: ${offer.description}`, `Size: ${offer.systemKw} kW (${offer.bandLabel}). Area: ${offer.area}.`, `Customer's date: ${offer.preferredDate}. You earn ${naira(offer.pay)}.`, 'The first approved installer to accept gets the job. You will see the full address after you accept.'],
        button: { label: 'View the job', url: link('/app') },
      });
    },
    async install_assigned({ request, customer, installer, job }) {
      await send(customer.email, {
        subject: `An installer accepted · ${request.ref}`, heading: 'Your installer is confirmed',
        lines: [`Hi ${customer.fullName}, ${installer.fullName} will install your system on or around ${request.preferredDate}.`, installer.phone ? `Their number: ${installer.phone}.` : 'They will contact you shortly.', 'When they finish, they will mark the job done and you will be asked to confirm.'],
        button: { label: 'Track your request', url: link(`/app/installations/${request.ref}`) },
      });
      await send(installer.email, {
        subject: `You got the job · ${request.ref}`, heading: 'The job is yours',
        lines: [`Address: ${job.address}`, `Customer: ${job.customer.name}, ${job.customer.phone}`, `Date: ${request.preferredDate}. What: ${request.description}`, `You earn ${naira(request.installerPayout)} once the customer confirms (or 12 hours after you mark it done).`],
        button: { label: 'Open the job', url: link('/app') },
      });
      await send(adminEmail, { subject: `Installation ${request.ref} accepted`, heading: 'Installer assigned', lines: [`${installer.fullName} accepted ${request.ref} (${place(request.state, request.areaId)}).`] });
    },
    async install_unfilled({ request, reason }) {
      await send(adminEmail, { subject: `NO INSTALLER YET · ${request.ref}`, heading: `Installation ${request.ref} needs you`, lines: [reason, `Paid ${naira(request.price)} for ${request.systemKw} kW in ${place(request.state, request.areaId)}, date ${request.preferredDate}.`, 'Find an installer by hand, or cancel the job and refund the customer.'], button: { label: 'Open installations', url: link('/app/admin-installations') } });
    },
    async install_done({ request, customer, hours }) {
      await send(customer.email, {
        subject: `Installation finished? · ${request.ref}`, heading: 'Your installer says the job is done',
        lines: [`Hi ${customer.fullName}, please check the work and confirm it is complete.`, `If we do not hear from you within ${hours} hours, the job closes automatically and the installer is paid.`],
        button: { label: 'Confirm the job', url: link(`/app/installations/${request.ref}`) },
      });
    },
    async install_completed({ request, customer, installer, auto }) {
      await send(customer.email, { subject: `Installation closed · ${request.ref}`, heading: 'Installation complete', lines: [auto ? 'The job closed automatically because we did not hear back after the installer finished.' : 'Thank you for confirming.', 'Thanks for using Solariun.'] });
      if (installer) await send(installer.email, { subject: `Job closed · ${request.ref}`, heading: 'Job complete', lines: [`${request.ref} is closed. Your payout of ${naira(request.installerPayout)} is on its way.`] });
      await send(adminEmail, { subject: `PAYOUT OWED · ${request.ref}`, heading: 'Pay the installer', lines: [`Pay ${installer?.fullName ?? 'the installer'} ${naira(request.installerPayout)} for ${request.ref}.`], button: { label: 'Open installations', url: link('/app/admin-installations') } });
    },
    async install_cancelled({ request, customer, reason }) {
      await send(customer.email, { subject: `Installation cancelled · ${request.ref}`, heading: 'Your installation was cancelled', lines: [`${reason ? `Reason: ${reason}. ` : ''}You will be refunded ${naira(request.price)}.`] });
      await send(adminEmail, { subject: `REFUND NEEDED · ${request.ref}`, heading: `Refund needed for ${request.ref}`, lines: [`Refund ${naira(request.price)} to ${customer.fullName}.`] });
    },

    async payment_problem({ order, reason, reference }) {
      await send(adminEmail, { subject: `Payment problem · ${order.publicRef}`, heading: `Payment problem on ${order.publicRef}`, lines: [reason, `Paystack reference: ${reference}. Check the payment and refund if needed.`] });
    },
  };

  return {
    async notify(type, ctx) {
      try {
        await handlers[type](ctx);
      } catch (err) {
        console.error(`[notify] ${type} failed: ${err.message}`);
      }
    },
    // The email to the logistics partner, with one-click links that need no account.
    dispatchLinks: (voId) => ({
      pickup: link(`/dispatch?t=${encodeURIComponent(tokens.sign(voId, 'pickup'))}`),
      deliver: link(`/dispatch?t=${encodeURIComponent(tokens.sign(voId, 'deliver'))}`),
    }),
    STATUS_LABEL,
  };
}
