import { auditRepo, settingsRepo } from '../../repos/settings.js';
import { usersRepo } from '../../repos/users.js';
import { vendorsRepo } from '../../repos/vendors.js';
import { feesService } from '../delivery/index.js';
import { createAdminService } from './admin.service.js';
import { settingsRegistry } from './settingsRegistry.js';

export const adminService = createAdminService({ registry: settingsRegistry, settingsRepo, auditRepo, usersRepo, vendorsRepo,
  afterSettingsSaved: async (keys) => {
    if (keys.some((k) => k.startsWith('delivery'))) await feesService.recomputeAll();
  },
});
