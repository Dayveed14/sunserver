// v = a variant (a size/type the customer can recognise). Watts are typical RUNNING power in
// watts, never shown to the customer. Optional per-variant overrides: dutyCycle, surge.
export const v = (id, label, watts, extra = {}) => ({ id, label, watts, ...extra });

// appliance = something a customer ticks. Fields the calculator uses:
//   hoursMode      'chips' (customer picks a usage range) or 'fixed' (always-on, e.g. a fridge)
//   defaultHours   pre-selected usage range key
//   dutyCycle      share of "on" time the device actually draws full power (compressors cycle)
//   surge          start-up multiple, used only to size the inverter
//   daytimeShare   share of usage that happens in daylight (decides battery size for solar)
export const appliance = (id, name, category, hint, config, variants) => ({
  id,
  name,
  category,
  hint,
  hoursMode: 'chips',
  defaultHours: 'h4',
  fixedHours: 24,
  dutyCycle: 1,
  surge: 1,
  daytimeShare: 0.4,
  maxQty: 30,
  ...config,
  variants,
});
