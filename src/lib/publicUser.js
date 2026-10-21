import { findArea, stateName } from '../modules/geo/areas.js';

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
