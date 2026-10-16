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
  };
}
