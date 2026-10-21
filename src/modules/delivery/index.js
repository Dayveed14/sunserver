import { deliveryFeesRepo } from '../../repos/deliveryFees.js';
import { DELIVERY_RULES } from './delivery.js';
import { createFeesService } from './fees.service.js';

export const feesService = createFeesService({ repo: deliveryFeesRepo, rules: DELIVERY_RULES });
