import { findArea, stateName } from '../utils/areas.js';

// The only shape of a user that ever leaves the API. Never include password_hash or lock state.
export function toPublicUser(user) {
  return {
    id: Number(user.id),
    email: user.email,
    role: user.role,
    fullName: user.full_name,
    phone: user.phone ?? null,
    companyName: user.company_name ?? null,
    emailVerified: Boolean(user.email_verified_at),
    // Vendors and installers must be approved by the admin before they can work. Customers need nothing beyond their email.
    ...(user.role === 'vendor' ? { vendorType: user.vendor_type ?? 'seller', verification: user.vendor_verification ?? 'pending', verificationNote: user.vendor_note ?? null } : {}),
    ...(user.role === 'installer' ? { verification: user.installer_verification ?? 'pending', verificationNote: user.installer_note ?? null, quizSubmitted: Boolean(user.installer_quiz_at) } : {}),
    address: user.address_line
      ? {
          line: user.address_line,
          state: user.address_state,
          stateName: stateName(user.address_state),
          areaId: user.address_area,
          areaName: findArea(user.address_state, user.address_area)?.name ?? null,
        }
      : null,
  };
}
