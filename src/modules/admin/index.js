import { auditRepo, settingsRepo } from '../../repos/settings.js';
import { usersRepo } from '../../repos/users.js';
import { vendorsRepo } from '../../repos/vendors.js';
import { createAdminService } from './admin.service.js';
import { settingsRegistry } from './settingsRegistry.js';

export const adminService = createAdminService({ registry: settingsRegistry, settingsRepo, auditRepo, usersRepo, vendorsRepo });
