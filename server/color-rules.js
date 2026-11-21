'use strict';
/**
 * Keyword color rules: "if an event's title contains one of these words, use
 * this color". Set on the settings page (config.colorRules).
 *
 *   colorRules: {
 *     weekends: false,              // false = leave Saturday/Sunday events alone
 *     rules: [                      // first matching rule wins
 *       { name: 'Food', color: '#F6BF26', keywords: ['lunch', 'dinner', 'ice cream'] },
 *     ],
 *   }
 *
 * Matching is by whole word (or phrase), ignoring capitalization, and allows a
 * plural "s" or a possessive "'s": "Lily's recital" and "dinners" match, but
 * "lily" does not match "family" and "off" does not match "office".
 *
 * Color priority for an event: its own Google color (optional service account)
 * → first matching rule → its calendar's color.
 */

const MAX_RULES = 20;
const MAX_KEYWORDS = 60;
const MAX_WORD = 40;

/** Escape a keyword for use inside a regular expression. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turn the configured rules into matchers once (not for every event).
 * @returns {{weekends: boolean, rules: Array<{color: string, re: RegExp}>}}
 */
function compileRules(colorRules) {
  const rules = (colorRules?.rules || [])
    .map((r) => {
      const words = (r.keywords || []).map((k) => String(k).trim()).filter(Boolean);
      if (!words.length || !r.color) return null;
      // Longer phrases first, so "ice cream" is tried before "ice".
      const alt = words.sort((a, b) => b.length - a.length).map((w) => escapeRe(w).replace(/\s+/g, '\\s+')).join('|');
      // Not preceded/followed by a letter or digit; optional plural / possessive.
      const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?:'s|’s|s)?(?![\\p{L}\\p{N}])`, 'iu');
      return { color: r.color, re };
    })
    .filter(Boolean);
  return { weekends: colorRules?.weekends === true, rules };
}

/**
 * Color for an event title on a given day, or null if no rule applies.
 * @param {ReturnType<typeof compileRules>} compiled
 * @param {string} title
 * @param {Date} day  local midnight of the day the event is shown on
 */
function ruleColor(compiled, title, day) {
  if (!compiled || !compiled.rules.length) return null;
  const dow = day.getDay(); // 0 = Sunday, 6 = Saturday
  if (!compiled.weekends && (dow === 0 || dow === 6)) return null;
  for (const r of compiled.rules) {
    if (r.re.test(title)) return r.color;
  }
  return null;
}

module.exports = { compileRules, ruleColor, MAX_RULES, MAX_KEYWORDS, MAX_WORD };
