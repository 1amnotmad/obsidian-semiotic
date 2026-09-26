#!/usr/bin/env node
// Builds theme.css from src/. Zero dependencies.
//
// Placeholders in src/theme.src.css:
//   @tokens;            → contents of src/tokens.css
//   @icons-vars;        → `--sem-icon-<name>: url("data:image/svg+xml,…");` per symbol
//   @font(<file>)       → url("data:font/woff2;base64,…") for a file in src/fonts/
//   @callout-selector   → `.callout:is([data-callout="note"], …)` covering every mapped type
//   @callout-rules;     → per-type `--sem-callout-icon` / `--callout-color` assignments
//
// Usage: node scripts/build.mjs [--watch]

import { readFileSync, writeFileSync, readdirSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const OUT = join(ROOT, "theme.css");

// Symbol name → Semiotic Standard code (the number in the SVG filename).
const ICONS = {
  "pressurised": "001",
  "gravity": "002",
  "gravity-absent": "003",
  "cryo": "004",
  "airlock": "005",
  "bulkhead": "006",
  "vacuum": "007",
  "suit-locker": "008",
  "photonic": "009",
  "laser": "010",
  "astronic": "011",
  "hazard": "012",
  "suit-required": "013",
  "no-pressure": "014",
  "exhaust": "015",
  "shielded": "016",
  "radiation": "017",
  "radioactive": "018",
  "refrigeration": "019",
  "direction": "020",
  "direction-down": "020A",
  "direction-right": "020B",
  "direction-left": "020C",
  "life-support": "021",
  "galley": "022",
  "coffee": "023",
  "bridge": "024",
  "autodoc": "025",
  "maintenance": "026",
  "ladderway": "027",
  "intercom": "028",
  "storage": "029",
  "storage-organic": "029A",
  "terminal": "030",
};

// Built-in Obsidian callouts → symbol. Their colours come from --callout-* in theme.src.css.
const BUILTIN_CALLOUTS = {
  "terminal": ["note"],
  "storage": ["abstract", "summary", "tldr"],
  "astronic": ["info"],
  "direction": ["todo"],
  "photonic": ["tip", "hint", "important"],
  "life-support": ["success", "check", "done"],
  "autodoc": ["question", "help", "faq"],
  "hazard": ["warning", "caution", "attention"],
  "vacuum": ["failure", "fail", "missing"],
  "radiation": ["danger", "error"],
  "maintenance": ["bug"],
  "bridge": ["example"],
  "intercom": ["quote", "cite"],
};

// Semiotic callouts ([!airlock], [!cryo], …): one per symbol, coloured after the
// sign's interior. Symbols not listed default to grey.
const SYMBOL_COLOURS = {
  red: ["pressurised", "gravity", "gravity-absent", "hazard", "shielded",
    "direction", "direction-down", "direction-right", "direction-left"],
  black: ["airlock", "bulkhead", "vacuum", "suit-required", "no-pressure"],
  amber: ["exhaust", "radiation", "radioactive"],
  navy: ["cryo", "refrigeration"],
  green: ["galley", "coffee", "autodoc", "storage-organic"],
};
const COLOUR_TOKENS = {
  red: "var(--sem-red)",
  grey: "var(--sem-grey)",
  black: "var(--sem-black)",
  amber: "var(--sem-amber-text)",
  navy: "var(--sem-navy)",
  green: "var(--sem-green)",
};

// ---------------------------------------------------------------------------

/** Map of code ("020A") → SVG path, read once. Throws on duplicate codes. */
function readIconFiles() {
  const files = new Map();
  for (const name of readdirSync(join(SRC, "icons"))) {
    const code = name.match(/^(\d{3}[A-Z]?)\..*\.svg$/)?.[1];
    if (!code) continue;
    if (files.has(code)) throw new Error(`Duplicate icon code ${code}: ${name}`);
    files.set(code, join(SRC, "icons", name));
  }
  return files;
}

function svgDataUri(svg) {
  const min = svg
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/\s+xml:space="[^"]*"/g, "")
    // the symbols have no strokes or clip paths, so only fill-rule matters on the root
    .replace(/clip-rule:evenodd;|stroke-linejoin:round;|stroke-miterlimit:[\d.]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim()
    .replace(/"/g, "'");
  return `url("data:image/svg+xml,${min.replace(/[%#<>{}]/g, encodeURIComponent)}")`;
}

function fontDataUri(file) {
  // only plain filenames inside src/fonts — no paths
  if (file !== basename(file) || !file.endsWith(".woff2")) {
    throw new Error(`@font() takes a .woff2 filename from src/fonts, got "${file}"`);
  }
  const b64 = readFileSync(join(SRC, "fonts", file)).toString("base64");
  return `url("data:font/woff2;base64,${b64}") format("woff2")`;
}

function iconVars() {
  const files = readIconFiles();
  return Object.entries(ICONS)
    .map(([name, code]) => {
      const file = files.get(code);
      if (!file) throw new Error(`No SVG for icon ${name} (${code})`);
      return `  --sem-icon-${name}: ${svgDataUri(readFileSync(file, "utf8"))};`;
    })
    .join("\n");
}

/** [{ types: [...], icon, colour? }] for every callout type the theme styles. */
function calloutGroups() {
  const colourOf = new Map(
    Object.entries(SYMBOL_COLOURS).flatMap(([colour, names]) => names.map((n) => [n, colour])),
  );
  const groups = [
    ...Object.entries(BUILTIN_CALLOUTS).map(([icon, types]) => ({ types, icon })),
    ...Object.keys(ICONS).map((icon) => ({
      types: [icon],
      icon,
      colour: COLOUR_TOKENS[colourOf.get(icon) ?? "grey"],
    })),
  ];
  for (const { icon } of groups) {
    if (!ICONS[icon]) throw new Error(`Callout references unknown icon ${icon}`);
  }
  const seen = new Set();
  for (const type of groups.flatMap((g) => g.types)) {
    if (seen.has(type)) throw new Error(`Callout type ${type} mapped twice`);
    seen.add(type);
  }
  return groups;
}

const attrList = (types) => types.map((t) => `[data-callout="${t}"]`).join(", ");

function calloutRules(groups) {
  return groups
    .map(({ types, icon, colour }) => {
      const sel = types.length === 1 ? `.callout${attrList(types)}` : `.callout:is(${attrList(types)})`;
      const decl = [`--sem-callout-icon: var(--sem-icon-${icon});`];
      if (colour) decl.push(`--callout-color: ${colour};`);
      return `${sel} { ${decl.join(" ")} }`;
    })
    .join("\n");
}

/** Community-theme rules, enforced on the output: offline-only, overridable. */
function assertSafe(css) {
  const problems = [];
  if (/!important/i.test(css)) problems.push("contains !important");
  if (/@import/i.test(css)) problems.push("contains @import");
  for (const [, target] of css.matchAll(/url\(\s*["']?([^"')\s]+)/g)) {
    if (!target.startsWith("data:")) problems.push(`non-data url(): ${target.slice(0, 60)}`);
  }
  if (/javascript:|expression\(|-moz-binding/i.test(css)) problems.push("contains script-like construct");
  const leftover = css.match(/@(tokens;|icons-vars;|callout-rules;|callout-selector|font\()/);
  if (leftover) problems.push(`unresolved placeholder ${leftover[0]}`);
  if (problems.length) throw new Error(`theme.css failed safety checks:\n  ${problems.join("\n  ")}`);
}

function build() {
  const groups = calloutGroups();
  const allTypes = groups.flatMap((g) => g.types);

  const css = readFileSync(join(SRC, "theme.src.css"), "utf8")
    .replace(/^\s*@tokens;\s*$/m, () => readFileSync(join(SRC, "tokens.css"), "utf8").trim())
    .replace(/^\s*@icons-vars;\s*$/m, iconVars)
    .replace(/^\s*@callout-rules;\s*$/m, () => calloutRules(groups))
    .replace(/@callout-selector/g, () => `.callout:is(${attrList(allTypes)})`)
    .replace(/@font\(\s*([^)]+?)\s*\)/g, (_, file) => fontDataUri(file));

  assertSafe(css);
  writeFileSync(OUT, css);

  const kb = (n) => (n / 1024).toFixed(1);
  const sum = (re) => (css.match(re) ?? []).reduce((a, s) => a + s.length, 0);
  const fonts = sum(/url\("data:font[^"]*"\)/g);
  const icons = sum(/url\("data:image[^"]*"\)/g);
  console.log(`theme.css ${kb(css.length)} KB (fonts ${kb(fonts)}, icons ${kb(icons)}, rules ${kb(css.length - fonts - icons)})`);
}

function run() {
  try {
    build();
    return true;
  } catch (e) {
    console.error(e.message);
    return false;
  }
}

if (process.argv.includes("--watch")) {
  run();
  let timer;
  watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(run, 100);
  });
  console.log("watching src/ …");
} else if (!run()) {
  process.exit(1);
}
