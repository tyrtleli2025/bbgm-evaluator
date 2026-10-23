// Minimal replacement for the browser/database utility barrel. Simulation logic
// lives in the unmodified upstream source. Missing settings fail loudly.
let settings;
export function configureEngine(values) { settings = values; }
export const g = {
  get(key) {
    if (!settings || !Object.hasOwn(settings, key)) {
      throw new Error(`Missing engine setting: ${key}`);
    }
    return settings[key];
  },
};
export const helpers = {
  entries: Object.entries,
  bound: (value, min, max) => Math.max(min, Math.min(max, value)),
  sigmoid: (x, a, b) => 1 / (1 + Math.exp(-a * (x - b))),
  // These helpers only format disabled notification text, not game outcomes.
  leagueUrl: parts => `/${parts.join('/')}`,
  overtimeCounter: n => n === 1 ? 'OT' : `${n}OT`,
  upperCaseFirstLetter: text => text[0].toUpperCase() + text.slice(1),
};
