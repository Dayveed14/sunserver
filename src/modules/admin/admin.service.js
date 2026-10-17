import { HttpError } from '../../lib/httpError.js';

const VERIFICATION = ['pending', 'verified', 'rejected'];

// Admin-only rules. Repos and the settings registry are injected so everything here can be tested without a database.
export function createAdminService({ registry, settingsRepo, auditRepo, usersRepo, vendorsRepo }) {
  const notFound = (what) => new HttpError(404, 'NOT_FOUND', `${what} not found.`);

  async function listSettings() {
    const saved = await settingsRepo.all();
    const now = registry.current();
    return {
      settings: registry.defs.map((d) => ({
        key: d.key, label: d.label, group: d.group, unit: d.unit, note: d.note, min: d.min, max: d.max,
        value: now[d.key], default: registry.defaults[d.key], custom: d.key in saved,
      })),
    };
  }

  return {
    // Reads saved overrides from the database into the live pricing objects. Run once at startup.
    async loadSettings() {
      const saved = await settingsRepo.all();
      const known = Object.fromEntries(Object.entries(saved).filter(([k]) => registry.has(k)));
      const merged = { ...registry.defaults, ...known };
      if (Object.keys(registry.validate(merged)).length) {
        console.warn('[admin] saved pricing settings are invalid; using the built-in defaults instead.');
        return { applied: 0 };
      }
      registry.apply(merged);
      return { applied: Object.keys(known).length };
    },

    listSettings,

    // `changes` maps a key to a new number, or to null to go back to the default. All or nothing.
    async saveSettings(adminId, changes) {
      const unknown = Object.keys(changes).filter((k) => !registry.has(k));
      if (unknown.length) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'One of those settings does not exist.', {
          fields: Object.fromEntries(unknown.map((k) => [k, 'Unknown setting.'])),
        });
      }
      const before = registry.current();
      const after = { ...before };
      for (const [k, v] of Object.entries(changes)) after[k] = v === null ? registry.defaults[k] : v;

      const errors = registry.validate(after);
      if (Object.keys(errors).length) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Some values need fixing.', { fields: errors });
      }

      const saved = await settingsRepo.all();
      const diff = {};
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) {
          if (!(k in saved)) continue; // already on the default
          await settingsRepo.remove(k);
        } else {
          if (k in saved && v === before[k]) continue; // unchanged
          await settingsRepo.set(k, v, adminId);
        }
        diff[k] = { from: before[k], to: after[k] };
      }
      registry.apply(after);
      if (Object.keys(diff).length) await auditRepo.add({ adminId, action: 'settings.update', target: 'pricing', detail: diff });
      return listSettings();
    },

    listVendors: async ({ status }) => ({ vendors: await vendorsRepo.listForAdmin({ status }) }),

    async setVendorVerification(adminId, vendorId, status) {
      if (!VERIFICATION.includes(status)) throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown status.');
      const before = (await vendorsRepo.getProfile(vendorId))?.verification;
      if (!before) throw notFound('Vendor');
      await vendorsRepo.setVerification(vendorId, status);
      await auditRepo.add({ adminId, action: 'vendor.verification', target: `vendor:${vendorId}`, detail: { from: before, to: status } });
      return { userId: vendorId, verification: status };
    },

    listUsers: async (filter) => ({ users: await usersRepo.listForAdmin(filter) }),

    async setUserStatus(adminId, userId, status) {
      const user = await usersRepo.findById(userId);
      if (!user) throw notFound('User');
      if (user.role === 'admin') throw new HttpError(400, 'FORBIDDEN_TARGET', 'Admin accounts cannot be suspended here.');
      await usersRepo.setStatus(userId, status);
      await auditRepo.add({ adminId, action: 'user.status', target: `user:${userId}`, detail: { from: user.status, to: status } });
      return { userId, status };
    },

    audit: async () => ({ entries: await auditRepo.recent(50) }),
  };
}
