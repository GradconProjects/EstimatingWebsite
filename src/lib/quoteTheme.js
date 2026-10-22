/**
 * The Quotes colour scheme as NAMED TOKENS (Grady, 22 Oct 2026: "the settings
 * to change the colours and themes should get up to macro level so basically
 * everything could be individually changed"). A preset gives every token a
 * value; the portal preference `quotesThemeColors` ({token key: "#rrggbb"})
 * overrides any of them one by one. `resolveTheme(prefs)` is the ONE reading;
 * App.jsx writes the result onto <html> (data-theme + the CSS custom
 * properties index.css maps the Tailwind chrome / accent / band classes to).
 * The portal Settings page carries a JSON mirror of TOKENS and PRESETS
 * (`QUOTE_THEME_TOKENS` / `QUOTE_THEME_PRESETS` in portal-shell.html) for its
 * colour pickers — verify.mjs fails when the two drift.
 */
export const THEME_TOKENS = [
  { key: "chrome950", css: "--t-chrome-950", group: "Chrome", label: "Header & element bands" },
  { key: "chrome900", css: "--t-chrome-900", group: "Chrome", label: "Tabs & secondary buttons" },
  { key: "chrome800", css: "--t-chrome-800", group: "Chrome", label: "Button hover" },
  { key: "chrome700", css: "--t-chrome-700", group: "Chrome", label: "Chrome text (dark)" },
  { key: "chrome300", css: "--t-chrome-300", group: "Chrome", label: "Band text (muted)" },
  { key: "chrome200", css: "--t-chrome-200", group: "Chrome", label: "Band text (light)" },
  { key: "chrome100", css: "--t-chrome-100", group: "Chrome", label: "Pale chrome fill" },
  { key: "chrome50", css: "--t-chrome-50", group: "Chrome", label: "Pale chrome background" },
  { key: "accent600", css: "--t-accent-600", group: "Accent", label: "Accent — primary buttons, active tab" },
  { key: "accent700", css: "--t-accent-700", group: "Accent", label: "Accent hover / dark text" },
  { key: "accent500", css: "--t-accent-500", group: "Accent", label: "Accent (light)" },
  { key: "accent400", css: "--t-accent-400", group: "Accent", label: "Money figures on dark bands" },
  { key: "accent300", css: "--t-accent-300", group: "Accent", label: "Accent tint on bands" },
  { key: "accent200", css: "--t-accent-200", group: "Accent", label: "Accent border" },
  { key: "accent100", css: "--t-accent-100", group: "Accent", label: "Accent tag fill" },
  { key: "accent50", css: "--t-accent-50", group: "Accent", label: "Filled-row tint" },
  { key: "accent900", css: "--t-accent-900", group: "Accent", label: "Accent text (darkest)" },
  { key: "accent800", css: "--t-accent-800", group: "Accent", label: "Accent text (dark)" },
  { key: "bandLabour", css: "--t-band-labour", group: "Bands", label: "Labour / crew sheet band" },
  { key: "bandLabourHead", css: "--t-band-labour-head", group: "Bands", label: "Labour sheet header" },
  { key: "bandGeometry", css: "--t-band-geometry", group: "Bands", label: "Project Geometry band" },
  { key: "bandSummary", css: "--t-band-summary", group: "Bands", label: "Summary rail headings & grand total" },
  { key: "bandCategory", css: "--t-band-category", group: "Bands", label: "Category headers on a card" },
  { key: "page", css: "--t-page", group: "Page", label: "Page background" },
  { key: "entryMe", css: "--t-entry-me", group: "Entries", label: "Figures you typed (signed-in account)" },
  { key: "entryOther", css: "--t-entry-other", group: "Entries", label: "Figures typed by someone else" },
];

export const PRESETS = {
  library: {
    chrome950: "#0f2e4c", chrome900: "#1F4E78", chrome800: "#2a5f8f", chrome700: "#35709f", chrome300: "#a9cdf0", chrome200: "#D9EAF7", chrome100: "#e8f2fb", chrome50: "#eef4f9",
    accent600: "#2f7fd6", accent700: "#2566ad", accent500: "#3b8be0", accent400: "#5fa3ea", accent300: "#a9cdf0", accent200: "#c9dff5", accent100: "#D9EAF7", accent50: "#eef4f9", accent900: "#1a4a7c", accent800: "#1f5a95",
    bandLabour: "#1F4E78", bandLabourHead: "#2a5f8f", bandGeometry: "#0f2e4c", bandSummary: "#0f2e4c", bandCategory: "#1F4E78", page: "#eef2f6",
    entryMe: "#047857", entryOther: "#7c3aed",
  },
  classic: {
    chrome950: "#172554", chrome900: "#1e3a8a", chrome800: "#1e40af", chrome700: "#1d4ed8", chrome300: "#93c5fd", chrome200: "#bfdbfe", chrome100: "#dbeafe", chrome50: "#eff6ff",
    accent600: "#ea580c", accent700: "#c2410c", accent500: "#f97316", accent400: "#fb923c", accent300: "#fdba74", accent200: "#fed7aa", accent100: "#ffedd5", accent50: "#fff7ed", accent900: "#7c2d12", accent800: "#9a3412",
    bandLabour: "#78350f", bandLabourHead: "#92400e", bandGeometry: "#78350f", bandSummary: "#171717", bandCategory: "#262626", page: "#f5f5f5",
    entryMe: "#047857", entryOther: "#7c3aed",
  },
  graphite: {
    chrome950: "#1c2126", chrome900: "#2b333b", chrome800: "#3a444e", chrome700: "#4a5661", chrome300: "#b6c0c9", chrome200: "#d8dee3", chrome100: "#e8ecef", chrome50: "#f1f3f5",
    accent600: "#059669", accent700: "#047857", accent500: "#10b981", accent400: "#34d399", accent300: "#6ee7b7", accent200: "#a7f3d0", accent100: "#d1fae5", accent50: "#ecfdf5", accent900: "#064e3b", accent800: "#065f46",
    bandLabour: "#2b333b", bandLabourHead: "#3a444e", bandGeometry: "#1c2126", bandSummary: "#1c2126", bandCategory: "#2b333b", page: "#f3f4f6",
    entryMe: "#b45309", entryOther: "#7c3aed",
  },
};
export const PRESET_FONTS = { library: '"Segoe UI", Calibri, ui-sans-serif, system-ui, Arial, sans-serif', classic: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', graphite: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' };
export const DEFAULT_PRESET = "library";
export const PRESET_KEYS = Object.keys(PRESETS);

const HEX = /^#[0-9a-f]{6}$/i;

/** The preset and every token's value for these preferences. */
export function resolveTheme(prefs) {
  const p = prefs && typeof prefs === "object" ? prefs : {};
  const preset = PRESET_KEYS.includes(p.quotesTheme) ? p.quotesTheme : DEFAULT_PRESET;
  const base = PRESETS[preset];
  const over = p.quotesThemeColors && typeof p.quotesThemeColors === "object" ? p.quotesThemeColors : {};
  const tokens = {};
  const overridden = [];
  THEME_TOKENS.forEach((t) => {
    const v = typeof over[t.key] === "string" && HEX.test(over[t.key]) ? over[t.key].toLowerCase() : null;
    tokens[t.key] = v || base[t.key];
    if (v && v !== String(base[t.key]).toLowerCase()) overridden.push(t.key);
  });
  return { preset, tokens, overridden, font: PRESET_FONTS[preset] };
}

/** Write a resolved theme onto a document root: data-theme + the custom properties. */
export function applyTheme(root, theme) {
  if (!root || !theme) return;
  root.dataset.theme = theme.preset;
  THEME_TOKENS.forEach((t) => root.style.setProperty(t.css, theme.tokens[t.key]));
  root.style.setProperty("--t-font", theme.font);
}
