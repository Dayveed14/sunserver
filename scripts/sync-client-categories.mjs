// Writes client/src/lib/productCategories.js from the server's list, so the browser and the server always agree.
// Run after changing server/src/utils/productCategories.js:   node scripts/sync-client-categories.mjs
// (The test in test/productCategories.test.js fails if the two drift apart.)
import fs from 'node:fs';
import { CATEGORY_GROUPS, CATEGORY_SPECS, CORE_CATEGORIES, PRODUCT_CATEGORIES } from '../src/utils/productCategories.js';

export function clientSource() {
  return `// GENERATED from server/src/utils/productCategories.js by server/scripts/sync-client-categories.mjs. Do not edit by hand.
export const CORE_CATEGORIES = ${JSON.stringify(CORE_CATEGORIES)};
export const CATEGORY_GROUPS = ${JSON.stringify(CATEGORY_GROUPS)};
export const PRODUCT_CATEGORIES = ${JSON.stringify(PRODUCT_CATEGORIES)};
export const CATEGORY_SPECS = ${JSON.stringify(CATEGORY_SPECS, null, 2)};
`;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const target = new URL('../../client/src/lib/productCategories.js', import.meta.url);
  fs.writeFileSync(target, clientSource());
  console.log('Wrote client/src/lib/productCategories.js');
}
