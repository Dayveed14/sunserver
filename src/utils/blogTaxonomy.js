// The blog is split into sections (where a post lives) and each post also has a category (what it is about).
export const SECTIONS = [
  { key: 'news', label: 'News' },
  { key: 'stories', label: 'Stories' }, // testimonials, customer stories, other articles
  { key: 'events', label: 'Events' },
];
export const CATEGORIES = [
  { key: 'news', label: 'News' },
  { key: 'user-guide', label: 'User guide' },
  { key: 'maintenance-tips', label: 'Maintenance tips' },
  { key: 'industry', label: 'Industry' },
  { key: 'product-updates', label: 'Product updates' },
  { key: 'testimonials', label: 'Testimonials' },
  { key: 'community', label: 'Community' },
  { key: 'entertainment', label: 'Entertainment' },
  { key: 'events', label: 'Events' },
];
export const SECTION_KEYS = SECTIONS.map((s) => s.key);
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

// Pictures sit inside the text as a line of their own: [[image:12|Optional caption]]
export const IMAGE_TOKEN = /\[\[image:(\d{1,12})\|([^\]\n]{0,200})\]\]/g;
export const imageIdsIn = (body) => [...new Set([...String(body).matchAll(IMAGE_TOKEN)].map((m) => Number(m[1])))];
