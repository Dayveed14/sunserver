import { findArea, STATES } from '../utils/areas.js';

const stateName = (id) => STATES.find((s) => s.id === id)?.name ?? null;
// "Chinedu Okafor" -> "Chinedu O.": installers are individuals, so the public list shows a first name and an initial only.
const shortName = (full) => {
  const parts = String(full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? 'Installer';
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
};

export function createPartnersService({ partnersModel }) {
  const place = (r) => ({ state: r.state ?? null, stateName: stateName(r.state), area: r.area_id ?? null, areaName: r.state && r.area_id ? findArea(r.state, r.area_id)?.name ?? null : null });

  return {
    async list() {
      const [vendors, installers] = await Promise.all([partnersModel.vendors(), partnersModel.installers()]);
      const partners = [
        ...vendors.map((r) => ({
          kind: r.vendor_type === 'company' ? 'company' : 'seller', name: r.company_name,
          services: r.vendor_type === 'company' ? ['Sells products', 'Installs systems', 'Energy as a service'] : ['Sells products'],
          products: Number(r.products), ...place(r),
        })),
        ...installers.map((r) => ({
          kind: 'installer', name: shortName(r.full_name), services: ['Installation'],
          jobsCompleted: Number(r.jobs_completed), yearsExperience: r.years_experience == null ? null : Number(r.years_experience), ...place(r),
        })),
      ];
      return { partners, counts: { company: vendors.filter((v) => v.vendor_type === 'company').length, seller: vendors.filter((v) => v.vendor_type !== 'company').length, installer: installers.length } };
    },
  };
}
