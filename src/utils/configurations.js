import { estimate } from './calculator.js';
import { BACKUP_BY_KEY } from './catalog/hours.js';
import { DEFAULT_CRITICAL_PRIORITIES, PRIORITY_BY_ID, priorityCovers } from './priorities.js';

// Ways to build the same site, so the customer can see what each level costs and what it leaves out.
//   essential    only what must stay on in a power cut
//   comfortable  everything they use except big, occasional appliances (kettle, iron, heater...) that need a larger inverter
//   whole        everything they ticked, and the battery also covers the night
//   budget       only when a budget is given and the whole site does not fit: as much of what they asked for as the budget can run,
//                taken in their order of priority, trimming quantities where that lets one more thing in
// All three use the normal calculator, so a configuration is priced exactly like an ordinary assessment.

const BIG_ITEM_WATTS = 800; // a single unit drawing this much counts as a "big, occasional" appliance
const naira = (n) => `₦${Math.round(n).toLocaleString('en-NG')}`;
const names = (lines) => [...new Set(lines.map((l) => l.name))];
const list = (arr, max = 6) => (arr.length <= max ? arr.join(', ') : `${arr.slice(0, max).join(', ')} and ${arr.length - max} more`);

export const CONFIG_KEYS = ['essential', 'comfortable', 'whole', 'budget'];

export function buildConfigurations(input, deps) {
  const catalog = deps.catalogs[input.segment];
  const byId = new Map(catalog.appliances.map((a) => [a.id, a]));
  const items = input.items;
  const picked = (input.priorities ?? []).map((id) => PRIORITY_BY_ID.get(id)).filter(Boolean);
  const coveredBy = (prios, it) => prios.some((p) => priorityCovers(p, byId.get(it.applianceId)));

  // What must stay on in a power cut: what the customer marked, else what their priorities point at, else the usual basics.
  const explicit = new Set(input.criticalIds ?? []);
  let critical;
  if (explicit.size > 0) critical = items.filter((i) => explicit.has(i.applianceId));
  else {
    const fromPicks = items.filter((i) => coveredBy(picked.filter((p) => !p.notEssential && !p.wholeSite), i));
    critical = fromPicks.length > 0 ? fromPicks : items.filter((i) => coveredBy(DEFAULT_CRITICAL_PRIORITIES.map((id) => PRIORITY_BY_ID.get(id)), i));
  }
  if (critical.length === 0) critical = items;
  const criticalIds = new Set(critical.map((i) => i.applianceId));

  const wanted = items.filter((i) => criticalIds.has(i.applianceId) || coveredBy(picked, i));
  const wantedIds = new Set(wanted.map((i) => i.applianceId));
  const unitWatts = (i) => byId.get(i.applianceId).variants.find((v) => v.id === i.variantId)?.watts ?? 0;
  const bigOccasional = items.filter((i) => !wantedIds.has(i.applianceId) && unitWatts(i) >= BIG_ITEM_WATTS);

  const wholeSite = picked.some((p) => p.wholeSite);
  const uninterrupted = picked.some((p) => p.uninterrupted);
  const hours = input.backupHours ?? 6;
  const cutLabel = input.backupKey === 'cont' ? 'a full-day power cut' : `a ${hours}-hour power cut`;
  const budget = input.budget > 0 ? input.budget : null;

  const run = (its, h) => estimate({ segment: input.segment, disco: input.disco, supplyBand: input.supplyBand ?? null, items: its, backupHours: h, ...(input.eaasAllowed === false ? { eaasAllowed: false } : {}) }, deps);
  const nameOf = (id) => byId.get(id).name;

  const describe = (key, label, tagline, its, h, left) => {
    const r = run(its, h);
    const s = r.solar;
    const why = [];
    if (s.batteryKwh > 0) {
      why.push(s.batteryFor === 'backup'
        ? `Battery ${s.batteryKwh} kWh. These items would use about ${s.backupKwh} kWh in ${key === 'essential' && uninterrupted && h > hours ? `a ${h}-hour power cut` : cutLabel}, and a battery should never be drained completely.`
        : `Battery ${s.batteryKwh} kWh. It covers your evening and night use (${r.usage.nightKwhPerDay} kWh), which is more than ${cutLabel} needs.`);
    } else why.push('No battery is needed: this is all used in daylight.');
    const biggest = r.usage.topConsumers[0];
    why.push(`Inverter ${s.inverterKva} kVA. It carries up to ${r.usage.peakKw} kW at once, including start-up surges${biggest ? `. Biggest user: ${biggest.name.toLowerCase()} (${biggest.sharePct}% of the energy)` : ''}.`);
    why.push(`Panels ${s.kwp} kWp (${s.panels} of ${s.panelWatts}W). Enough to run daytime loads and refill the battery with ${s.peakSunHours} sun hours a day where you are.`);
    if (r.generator.monthlyCost > 0) why.push(`A generator doing the same job would cost about ${naira(r.generator.monthlyCost)} a month.`);
    return {
      key, label, tagline, items: its, result: r,
      runs: names(r.usage.lines), leftOut: left.map((i) => nameOf(i.applianceId)).filter((n, ix, a) => a.indexOf(n) === ix),
      backupHours: h, why,
      fitsBudget: budget ? s.systemCost <= budget : null,
      overBy: budget && s.systemCost > budget ? s.systemCost - budget : 0,
    };
  };

  const essentialHours = uninterrupted ? Math.max(hours, 12) : hours;
  const built = [];
  built.push(describe('whole', 'Whole property', 'Everything you ticked, and the night too.', items, hours, []));
  if (bigOccasional.length > 0) {
    const kept = items.filter((i) => !bigOccasional.includes(i));
    built.push(describe('comfortable', 'Comfortable', 'Everything you use day to day. Big occasional appliances wait.', kept, hours, bigOccasional));
  }
  if (critical.length < items.length) {
    const rest = items.filter((i) => !critical.includes(i));
    built.push(describe('essential', 'Essential backup', 'Keeps what matters running through a power cut.', critical, essentialHours, rest));
  }

  // ---- fitted to the budget: work backwards from what can be spent ----
  if (budget && built[0].fitsBudget === false) {
    const rank = (it) => { const ix = picked.findIndex((p) => !p.wholeSite && priorityCovers(p, byId.get(it.applianceId))); return ix < 0 ? 99 : ix; };
    const tier = (it) => (criticalIds.has(it.applianceId) ? (rank(it) < 99 ? 0 : 1) : rank(it) < 99 ? 2 : 3);
    const order = items.map((it, i) => ({ it, i }))
      .sort((a, b) => tier(a.it) - tier(b.it) || rank(a.it) - rank(b.it) || unitWatts(a.it) - unitWatts(b.it) || a.i - b.i)
      .map((x) => x.it);
    const h = essentialHours;
    const cost = (its) => run(its, h).solar.systemCost;
    const chosen = [];
    const trimmed = [];
    const waiting = [];
    for (const it of order) {
      const fits = (q) => cost([...chosen, { ...it, qty: q }]) <= budget;
      if (!fits(1)) { waiting.push(it); continue; }
      let lo = 1;
      let hi = it.qty;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
      chosen.push({ ...it, qty: lo });
      if (lo < it.qty) trimmed.push({ it, qty: lo });
    }
    if (chosen.length > 0) {
      const c = describe('budget', 'Fitted to your budget', `The most of what you asked for that ${naira(budget)} can run, in your order of priority.`, chosen, h, waiting);
      c.partial = trimmed.map((t) => ({ name: nameOf(t.it.applianceId), qty: t.qty, wanted: t.it.qty }));
      // What a little more money would add: the first thing in their order that did not fully fit.
      const firstUnmet = order.find((it) => waiting.includes(it) || trimmed.some((t) => t.it === it));
      if (firstUnmet) {
        const t = trimmed.find((x) => x.it === firstUnmet);
        const more = t ? chosen.map((x) => (x.applianceId === firstUnmet.applianceId && x.variantId === firstUnmet.variantId ? { ...x, qty: x.qty + 1 } : x)) : [...chosen, { ...firstUnmet, qty: 1 }];
        c.next = { name: nameOf(firstUnmet.applianceId), extra: Math.max(0, cost(more) - c.result.solar.systemCost) };
      }
      built.push(c);
    }
  }

  // Drop any configuration that turned out identical to a bigger one.
  const seen = new Set();
  const unique = built.filter((c) => {
    const sig = `${c.result.solar.kwp}|${c.result.solar.batteryKwh}|${c.result.solar.inverterKva}|${c.items.length}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  const ordered = CONFIG_KEYS.map((k) => unique.find((c) => c.key === k)).filter(Boolean);

  // Which one to suggest, then step down if the budget will not stretch.
  const has = (k) => ordered.some((c) => c.key === k);
  let recommended;
  if ((input.backupKey === 'cont' || uninterrupted) && has('essential')) recommended = 'essential';
  else if (wholeSite || !has('comfortable')) recommended = has('whole') ? 'whole' : ordered.at(-1).key;
  else recommended = 'comfortable';
  let nothingFits = false;
  if (budget) {
    const fits = (k) => ordered.find((c) => c.key === k)?.fitsBudget;
    if (!fits(recommended)) {
      // The biggest ordinary option that fits, unless the fitted one runs more of what they asked for.
      const best = ordered.filter((c) => c.key !== 'budget' && c.fitsBudget).sort((a, b) => b.result.solar.systemCost - a.result.solar.systemCost)[0];
      const fitted = ordered.find((c) => c.key === 'budget');
      if (fitted && (!best || fitted.result.solar.systemCost > best.result.solar.systemCost)) recommended = 'budget';
      else if (best) recommended = best.key;
      else { recommended = ordered[0].key; nothingFits = true; }
    }
  }

  // When even the smallest system is out of reach, say what renting or leasing it would take.
  let fallback = null;
  if (nothingFits) {
    const o = ordered[0].result.options;
    fallback = { smallestCost: ordered[0].result.solar.systemCost, leaseUpfront: o.lease.upfront, leaseMonthly: o.lease.monthly, rentUpfront: o.rent.upfront, rentMonthly: o.rent.monthly };
  }

  return { ordered, recommended, nothingFits, fallback, hours, backupKey: input.backupKey ?? null, picked: picked.map((p) => p.label) };
}

const R = (c) => ({
  key: c.key, label: c.label, tagline: c.tagline, runs: c.runs, leftOut: c.leftOut, backupHours: c.backupHours,
  kwhPerDay: c.result.usage.kwhPerDay, kwp: c.result.solar.kwp, panels: c.result.solar.panels, batteryKwh: c.result.solar.batteryKwh,
  inverterKva: c.result.solar.inverterKva, systemCost: c.result.solar.systemCost, generatorMonthly: c.result.generator.monthlyCost,
  why: c.why, fitsBudget: c.fitsBudget, overBy: c.overBy,
  ...(c.partial ? { partial: c.partial } : {}), ...(c.next ? { next: c.next } : {}),
});

// The part of the result the browser shows: three cards and which one we suggest.
export function publicConfigurations(built, selected) {
  return {
    selected, recommended: built.recommended, nothingFits: built.nothingFits, fallback: built.fallback,
    backupLabel: built.backupKey ? BACKUP_BY_KEY.get(built.backupKey)?.label ?? null : null,
    priorities: built.picked,
    items: built.ordered.map(R),
  };
}
