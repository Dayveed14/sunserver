// Launch switches. Each one is a pair of lines: keep ONE active and comment the other.
// Everything the switch controls is already built and tested; flipping a switch needs no other code change.
// (The client has a matching file: client/src/config/launch.js. Keep the two in step.)

// ---------------------------------------------------------------------------------------------------------------
// 1. VENDOR REGISTRATION FEE
//    FREE  = vendors join without paying (current: we are still recruiting the first vendors).
//    PAID  = every NEW vendor pays the one-time registration fee (Admin > Pricing & rules > Vendor registration fee,
//            ₦100,000 to start with) before they can use the vendor dashboard.
//    Vendors who already joined free stay free for good.
// ---------------------------------------------------------------------------------------------------------------
// FREE (active):
export const VENDOR_REGISTRATION_FEE_REQUIRED = false;
// PAID (to switch on: comment the FREE line above, uncomment this one):
// export const VENDOR_REGISTRATION_FEE_REQUIRED = true;

// ---------------------------------------------------------------------------------------------------------------
// 2. WHO CAN BUY "ENERGY AS A SERVICE" (EaaS)
//    Right now only business accounts (a plaza of shops, an estate or a company can open one business account
//    and take EaaS together). Individuals can buy outright, lease to own, and later rent.
//    The EaaS code itself is untouched; this only decides who is offered it.
// ---------------------------------------------------------------------------------------------------------------
// Businesses only (active):
export const EAAS_ROLES = ['business'];
// Individuals and businesses (to switch back: comment the line above, uncomment this one):
// export const EAAS_ROLES = ['individual', 'business'];

// Is EaaS offered to this kind of customer? Accepts an account type ('individual', 'business') or an
// assessment segment ('home' counts as 'individual').
export const eaasOffered = (kind) => EAAS_ROLES.includes(kind === 'home' ? 'individual' : kind);
