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
        lines: [`Order ${d.ref}: ${d.shortItems}.`, `Items ${naira(ctx.vo.subtotal)}; after the TerraVoltix platform fee you receive ${naira(Number(ctx.vo.subtotal) - Number(ctx.vo.commission ?? 0))}. It goes to ${d.to}.`, 'Please accept it so a rider can be sent and the customer knows it is on the way.'],
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
        subject: 'Your TerraVoltix subscription is due soon', heading: 'Your subscription runs out soon',
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
        lines: [`Hi ${customer.fullName}, we received your payment of ${naira(request.price)} for installation ${request.ref}.`, 'We are choosing the best installer near you. You will get an email as soon as one accepts.', 'Please pay only inside TerraVoltix, never to the installer directly.'],
        button: { label: 'Track your request', url: link(`/app/installations/${request.ref}`) },
      });
      await send(adminEmail, { subject: `Paid installation ${request.ref} · ${naira(request.price)}`, heading: `New installation ${request.ref}`, lines: [`${customer.fullName} paid ${naira(request.price)} for ${request.systemKw} kW (${request.bandLabel}).`, `Place: ${place(request.state, request.areaId)}. Preferred date: ${request.preferredDate}.`], button: { label: 'Open installations', url: link('/app/admin-installations') } });
    },
    async install_recommend({ request, installer, match, minutes, why }) {
      await send(adminEmail, {
        subject: `Installation ${request.ref}: approve ${installer?.name ?? 'an installer'}?`, heading: 'An installer is recommended',
        lines: [...(why ? [why] : []), `${request.systemKw} kW in ${place(request.state, request.areaId)}, date ${request.preferredDate}. Paid ${naira(request.price)}.`, `Recommended: ${installer?.name ?? 'an installer'}${match ? `, about ${match.distanceKm} km away, score ${match.score}` : ''}.`, `If you do nothing, this is approved automatically in ${minutes} minutes.`],
        button: { label: 'Open installations', url: link('/app/admin-installations') },
      });
    },
    async install_new_job({ installer, offer, minutes }) {
      if (!installer?.email) return;
      await send(installer.email, {
        subject: `New installation job · ${offer.area} · ${naira(offer.pay)}`, heading: 'A job is waiting for you',
        lines: [`Hi ${installer.fullName}, TerraVoltix picked you for an installation.`, `What: ${offer.description}`, `Size: ${offer.systemKw} kW (${offer.bandLabel}). Area: ${offer.area}.`, `Customer's date: ${offer.preferredDate}. You earn ${naira(offer.pay)}.`, `Please answer within ${minutes} minutes, or it goes to the next installer. You will see the full address after you accept.`],
        button: { label: 'View the job', url: link('/app/installer-jobs') },
      });
    },
    async install_lapsed({ request, installer, minutes }) {
      if (!installer?.email) return;
      await send(installer.email, { subject: `Job offer expired · ${request.ref}`, heading: 'The offer has passed', lines: [`You did not answer within ${minutes} minutes, so the job went to another installer. Reply quickly next time to keep your ranking.`] });
    },
    async install_on_the_way({ request, customer, installer }) {
      await send(customer.email, { subject: `Your installer is on the way · ${request.ref}`, heading: 'Your installer has set off', lines: [`Hi ${customer.fullName}, ${installer.fullName} is on the way to your site.`, installer.phone ? `Their number: ${installer.phone}.` : 'They will call you.', 'Cancelling now refunds only half the fee.'], button: { label: 'Track your installation', url: link(`/app/installations/${request.ref}`) } });
    },
    async install_problem({ request, note, customer }) {
      await send(adminEmail, { subject: `PROBLEM REPORTED · ${request.ref}`, heading: `${customer?.name ?? 'The customer'} reported a problem`, lines: [note, 'The automatic close is stopped. Talk to both sides, then close the job or cancel and refund.'], button: { label: 'Open installations', url: link('/app/admin-installations') } });
    },
    async install_assigned({ request, customer, installer, job }) {
      await send(customer.email, {
        subject: `An installer accepted · ${request.ref}`, heading: 'Your installer is confirmed',
        lines: [`Hi ${customer.fullName}, ${installer.fullName} will install your system on or around ${request.preferredDate}.`, installer.phone ? `Their number: ${installer.phone}.` : 'They will contact you shortly.', 'They will share before and after pictures with the report when they finish, and you will be asked to confirm.'],
        button: { label: 'Track your request', url: link(`/app/installations/${request.ref}`) },
      });
      await send(installer.email, {
        subject: `You got the job · ${request.ref}`, heading: 'The job is yours',
        lines: [`Address: ${job.address}`, `Customer: ${job.customer.name}, ${job.customer.phone}`, `Date: ${request.preferredDate}. What: ${request.description}`, `You earn ${naira(request.installerPayout)} once the customer confirms (or automatically if they do not reply).`],
        button: { label: 'Open the job', url: link('/app/installer-jobs') },
      });
      await send(adminEmail, { subject: `Installation ${request.ref} accepted`, heading: 'Installer assigned', lines: [`${installer.fullName} accepted ${request.ref} (${place(request.state, request.areaId)}).`] });
    },
    async install_unfilled({ request, reason }) {
      await send(adminEmail, { subject: `NO INSTALLER YET · ${request.ref}`, heading: `Installation ${request.ref} needs you`, lines: [reason, `Paid ${naira(request.price)} for ${request.systemKw} kW in ${place(request.state, request.areaId)}, date ${request.preferredDate}.`, 'Choose an installer by hand, or cancel the job and refund the customer.'], button: { label: 'Open installations', url: link('/app/admin-installations') } });
    },
    async install_done({ request, customer, hours }) {
      await send(customer.email, {
        subject: `Installation finished? · ${request.ref}`, heading: 'Your installer says the job is done',
        lines: [`Hi ${customer.fullName}, please check the work and confirm it is complete.`, `If we do not hear from you within ${hours} hours, the job closes automatically and the installer is paid.`],
        button: { label: 'Confirm the job', url: link(`/app/installations/${request.ref}`) },
      });
    },
    async install_completed({ request, customer, installer, auto }) {
      await send(customer.email, { subject: `Installation closed · ${request.ref}`, heading: 'Installation complete', lines: [auto ? 'The job closed automatically because we did not hear back after the installer finished.' : 'Thank you for confirming.', 'Thanks for using TerraVoltix.'] });
      if (installer) await send(installer.email, { subject: `Job closed · ${request.ref}`, heading: 'Job complete', lines: [`${request.ref} is closed. Your payout of ${naira(request.installerPayout)} is on its way.`] });
      await send(adminEmail, { subject: `PAYOUT OWED · ${request.ref}`, heading: 'Pay the installer', lines: [`Pay ${installer?.fullName ?? 'the installer'} ${naira(request.installerPayout)} for ${request.ref}.`], button: { label: 'Open installations', url: link('/app/admin-installations') } });
    },
    async install_cancelled({ request, customer, reason, refund, installer }) {
      const amount = refund ?? request.price;
      await send(customer.email, { subject: `Installation cancelled · ${request.ref}`, heading: 'Your installation was cancelled', lines: [`${reason ? `Reason: ${reason}. ` : ''}You will be refunded ${naira(amount)}.`] });
      await send(adminEmail, { subject: `REFUND NEEDED · ${request.ref}`, heading: `Refund needed for ${request.ref}`, lines: [`Refund ${naira(amount)} to ${customer.fullName}.`], button: { label: 'Open installations', url: link('/app/admin-installations') } });
      if (installer?.email) await send(installer.email, { subject: `Job cancelled · ${request.ref}`, heading: 'The job was cancelled', lines: [`${request.ref} was cancelled. ${amount < request.price ? 'You will still be paid your share of the fee that was kept.' : 'You do not need to go.'}`] });
    },

    // ---- repairs ----
    async repair_paid({ request, customer }) {
      await send(customer.email, {
        subject: `Call-out fee paid · ${request.ref}`, heading: 'We are finding your technician',
        lines: [`Hi ${customer.fullName}, we received your call-out fee of ${naira(request.fee)} for ${request.ref} (${request.fault}).`, 'We are choosing the best technician near you. You will get an email as soon as one accepts.', 'Please pay only inside TerraVoltix, never to the technician directly.'],
        button: { label: 'Track your repair', url: link(`/app/repairs/${request.ref}`) },
      });
    },
    async repair_recommend({ request, technician, match, minutes, why }) {
      await send(adminEmail, {
        subject: `Repair ${request.ref}: approve ${technician?.name ?? 'a technician'}?`, heading: 'A technician is recommended',
        lines: [...(why ? [why] : []), `${request.fault} in ${request.area} (${request.urgent ? 'URGENT' : 'normal'}). Call-out fee ${naira(request.fee)}.`, `Recommended: ${technician?.name ?? 'a technician'}${match ? `, about ${match.distanceKm} km away, score ${match.score}` : ''}.`, `If you do nothing, this is approved automatically in ${minutes} minutes.`],
        button: { label: 'Open repairs', url: link('/app/admin-repairs') },
      });
    },
    async repair_offer({ request, technician, minutes, earn }) {
      if (!technician?.email) return;
      await send(technician.email, {
        subject: `Repair job near you · ${request.area} · ${naira(earn)}`, heading: 'A repair job is waiting for you',
        lines: [`Hi ${technician.name}, ${request.fault} in ${request.area} (${request.urgent ? 'urgent' : 'normal'}).`, `Equipment: ${request.equipment.join(', ')}. About ${request.distanceKm} km from you.`, `You earn ${naira(earn)} for the call-out visit, plus a share of any repair that follows.`, `Please answer within ${minutes} minutes or it moves to another technician. You see the address after you accept.`],
        button: { label: 'Open the job', url: link('/app/repair-jobs') },
      });
    },
    async repair_assigned({ request, customer, technician }) {
      await send(customer.email, {
        subject: `Technician assigned · ${request.ref}`, heading: 'Your technician is confirmed',
        lines: [`Hi ${customer.fullName}, ${technician.fullName} will visit to inspect the fault.`, technician.phone ? `Their number: ${technician.phone}.` : 'They will contact you shortly.', 'You will be told when they set off.'],
        button: { label: 'Track your repair', url: link(`/app/repairs/${request.ref}`) },
      });
    },
    async repair_lapsed({ request, technician, minutes }) {
      await send(adminEmail, { subject: `Repair ${request.ref}: technician did not answer`, heading: 'A technician did not respond', lines: [`${technician?.name ?? 'The technician'} did not answer within ${minutes} minutes. The next-ranked technician is now recommended for your approval.`], button: { label: 'Open repairs', url: link('/app/admin-repairs') } });
    },
    async repair_unfilled({ request, reason }) {
      await send(adminEmail, { subject: `NO TECHNICIAN YET · ${request.ref}`, heading: `Repair ${request.ref} needs you`, lines: [reason, `${request.fault} in ${request.area}. The customer paid ${naira(request.fee)}.`, 'Pick a technician by hand, or cancel and refund the customer.'], button: { label: 'Open repairs', url: link('/app/admin-repairs') } });
    },
    async repair_on_the_way({ request, customer, technician }) {
      await send(customer.email, { subject: `Technician on the way · ${request.ref}`, heading: 'Your technician is on the way', lines: [`Hi ${customer.fullName}, ${technician.fullName} has set off${technician.phone ? ` (${technician.phone})` : ''}.`, 'Please make sure someone is at the address.'], button: { label: 'Track your repair', url: link(`/app/repairs/${request.ref}`) } });
    },
    async repair_inspected({ request, customer, total, due }) {
      await send(customer.email, {
        subject: `Your repair estimate · ${request.ref}`, heading: 'The inspection is finished',
        lines: [`Hi ${customer.fullName}, the technician has finished inspecting. The full repair is estimated at ${naira(total)}.`, `Your call-out fee of ${naira(request.fee)} is credited, so you would pay ${naira(due)} more.`, 'Open your request to see the findings and the itemised cost. Pay only inside TerraVoltix.'],
        button: { label: 'See the estimate', url: link(`/app/repairs/${request.ref}`) },
      });
    },
    async repair_approved({ request, technician, earn }) {
      if (technician?.email) await send(technician.email, { subject: `Estimate approved and paid · ${request.ref}`, heading: 'You can start the repair', lines: [`The customer approved your estimate and paid it inside TerraVoltix. You earn ${naira(earn)} for the whole job once the customer confirms the repair.`, 'Open the job and tap "Start repair" when you begin.'], button: { label: 'Open the job', url: link('/app/repair-jobs') } });
    },
    async repair_quote_declined({ request, technician, earn }) {
      if (technician?.email) await send(technician.email, { subject: `Customer did not go ahead · ${request.ref}`, heading: 'The customer declined the estimate', lines: [`You are still paid for the visit: ${naira(earn)}.`], button: { label: 'Open your jobs', url: link('/app/repair-jobs') } });
    },
    async repair_variation({ request, customer, extra, reason }) {
      await send(customer.email, { subject: `Change to your repair estimate · ${request.ref}`, heading: 'The technician found more to do', lines: [`Hi ${customer.fullName}, the technician asks for ${naira(extra)} more: ${reason}`, 'Nothing changes unless you approve it. Pay only inside TerraVoltix.'], button: { label: 'Review the change', url: link(`/app/repairs/${request.ref}`) } });
    },
    async repair_variation_decided({ request, technician, approved, extra }) {
      if (technician?.email) await send(technician.email, { subject: `Revised estimate ${approved ? 'approved' : 'declined'} · ${request.ref}`, heading: approved ? 'The customer approved the change' : 'The customer declined the change', lines: [approved ? `The extra ${naira(extra)} is paid. Carry on with the revised work.` : 'Continue with the work as originally quoted.'], button: { label: 'Open the job', url: link('/app/repair-jobs') } });
    },
    async repair_awaiting_parts({ request, customer, note }) {
      await send(customer.email, { subject: `Waiting for parts · ${request.ref}`, heading: 'Your repair is waiting for parts', lines: [`Hi ${customer.fullName}, the technician is waiting for parts: ${note}`, 'You will hear from us when work continues.'], button: { label: 'Track your repair', url: link(`/app/repairs/${request.ref}`) } });
    },
    async repair_done({ request, customer, hours }) {
      await send(customer.email, { subject: `Your repair is finished · ${request.ref}`, heading: 'Please check the repair', lines: [`Hi ${customer.fullName}, the technician says the work is finished.`, `Please check it and confirm. If you do nothing, it closes by itself in ${hours} hours. If something is wrong, tell us before then.`], button: { label: 'Check and confirm', url: link(`/app/repairs/${request.ref}`) } });
    },
    async repair_completed({ request, technician, earn, auto }) {
      if (technician?.email) await send(technician.email, { subject: `Repair closed · ${request.ref}`, heading: 'The repair is complete', lines: [`${auto ? 'The customer did not reply in time, so it closed automatically.' : 'The customer confirmed the repair.'} Your payout of ${naira(earn)} will be sent soon.`], button: { label: 'Open your jobs', url: link('/app/repair-jobs') } });
    },
    async repair_problem({ request, note, customer }) {
      await send(adminEmail, { subject: `PROBLEM REPORTED · ${request.ref}`, heading: `${customer?.name ?? 'The customer'} reported a problem`, lines: [note, 'The automatic close is stopped. Talk to both sides, then close the repair or cancel and refund.'], button: { label: 'Open repairs', url: link('/app/admin-repairs') } });
    },
    async repair_cancelled({ request, refund, reason, customer, technician }) {
      await send(customer.email, { subject: `Repair cancelled · ${request.ref}`, heading: 'Your repair request was cancelled', lines: [`${reason ? `Reason: ${reason}. ` : ''}You will be refunded ${naira(refund)}.`] });
      await send(adminEmail, { subject: `REFUND NEEDED · ${request.ref}`, heading: `Refund needed for ${request.ref}`, lines: [`Refund ${naira(refund)} to ${customer.fullName}.`], button: { label: 'Open repairs', url: link('/app/admin-repairs') } });
      if (technician?.email) await send(technician.email, { subject: `Job cancelled · ${request.ref}`, heading: 'The customer cancelled', lines: [`${request.ref} was cancelled. You do not need to go.`] });
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
