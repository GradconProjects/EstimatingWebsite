#!/usr/bin/env node
/**
 * Runs as a postbuild step (see package.json's "build" script) — folds the
 * just-built Quotes app (dist/index.html + its JS/CSS bundle) and the two
 * self-contained vanilla-JS tools (portal/estimates-app.html, portal/
 * cost-planner.html) into portal/portal-shell.html (the login + tab-
 * switching shell), then overwrites dist/index.html with the result. Vercel
 * serves whatever ends up in dist/, so this makes the single deployed URL
 * the full combined portal (login → Cost Planner / Quotes / Estimates tabs)
 * instead of just the bare Quotes SPA vite build produces on its own.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, "dist");
const shellPath = path.join(root, "portal", "portal-shell.html");
const estimatesPath = path.join(root, "portal", "estimates-app.html");
const costPlannerPath = path.join(root, "portal", "cost-planner.html");
const ratesLibraryPath = path.join(root, "portal", "rates-library.html");
const outPath = path.join(distDir, "index.html");

// --- Inline the built React app (Quotes) into one self-contained document ---
let quotesHtml = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
const assetsDir = path.join(distDir, "assets");
const cssFile = fs.readdirSync(assetsDir).find((f) => f.endsWith(".css"));
// The ENTRY bundle is whichever file vite's index.html actually loads — never
// "the first .js in assets/": a lazily-loaded chunk (see below) sits in the
// same folder and picking that would inline the wrong file without a word.
const entryMatch = quotesHtml.match(/<script type="module"[^>]*src="\/assets\/([^"]+\.js)"/);
if (!entryMatch) throw new Error("could not find the entry <script src=\"/assets/…\"> in dist/index.html");
const jsFile = entryMatch[1];
const css = fs.readFileSync(path.join(assetsDir, cssFile), "utf8");
let js = fs.readFileSync(path.join(assetsDir, jsFile), "utf8");

/* --- Lazily-loaded chunks ---------------------------------------------------
 * Any other .js in assets/ is a chunk the entry pulls in on demand with a
 * dynamic import() (today: the PDF renderer, lib/pdfToImages.js). Vite emits
 * that as `import("./chunk-hash.js")`, resolved against the importing module's
 * URL — which, once this bundle is inlined and run from a blob: URL inside the
 * portal, is a blob: URL that a relative path cannot resolve against
 * (measured: "Failed to resolve module specifier"). `location.origin` inside
 * that iframe IS the real site origin (blob: URLs inherit their creator's), so
 * an absolute `origin + "/assets/chunk-hash.js"` loads fine, and Vercel serves
 * dist/assets/ as-is. The chunk file stays where vite put it.
 *
 * Every step is asserted so a build can only ever succeed with a working lazy
 * path — never with a silently broken one:
 *   - a chunk that itself imports another module could not run from a URL its
 *     imports don't resolve against, so it must be self-contained;
 *   - the entry must reference each chunk exactly once, as the literal
 *     `import("./<file>")` this rewrite targets (vite.config.js turns the
 *     preload helper off precisely so it takes that plain form). */
const chunkFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js") && f !== jsFile);
for (const chunk of chunkFiles) {
  const chunkSrc = fs.readFileSync(path.join(assetsDir, chunk), "utf8");
  if (/(^|[;\s}])import\s*["'][^"']+["']|\bfrom\s*["']\.\/[^"']+["']/.test(chunkSrc)) {
    throw new Error(`chunk ${chunk} imports another module — it can't be loaded from an absolute URL on its own`);
  }
  const literal = `import("./${chunk}")`;
  const occurrences = js.split(literal).length - 1;
  if (occurrences !== 1) {
    throw new Error(`expected exactly one ${literal} in ${jsFile}, found ${occurrences} — the lazy-load rewrite would be wrong`);
  }
  js = js.replace(literal, () => `import(/* @vite-ignore */ location.origin + "/assets/${chunk}")`);
  console.log(`Lazy chunk kept at /assets/${chunk} (${(chunkSrc.length / 1024).toFixed(0)} KB), import rewritten to an absolute URL`);
}

// The bundle can contain a literal "</script" substring inside a string/regex
// literal — embedded raw inside a real <script> tag, the HTML parser (not
// the JS parser) treats that as the tag's actual close, truncating the
// script and spilling the rest as visible text. `\/` is a no-op escape
// inside a JS string/regex literal, so this is semantically identical JS
// but can't prematurely close the tag.
js = js.replace(/<\/script/gi, "<\\/script");

// Replacer FUNCTIONS, not template-literal strings: String.replace() treats
// $&, $`, $', $$, $<n> as special patterns *inside a string replacement* —
// with hundreds of KB of minified JS interpolated in, a coincidental "$"
// followed by a backtick/quote/digit/& is near-guaranteed, silently
// splicing fragments of the surrounding document into the bundle. A
// function replacer returns its value literally, with no substitution.
quotesHtml = quotesHtml
  .replace(/<link rel="stylesheet"[^>]*>/, () => `<style>${css}</style>`)
  .replace(/<script type="module"[^>]*src="[^"]*"[^>]*><\/script>/, () => `<script type="module">${js}</script>`);

// Positive check: confirm both tags were actually replaced with inlined
// content (not just that "/assets" is absent — the bundle can coincidentally
// contain that substring as inert string data inside unrelated dead code).
const headStart = quotesHtml.slice(0, 300);
if (!/<script type="module">\s*\S/.test(headStart)) {
  throw new Error("script tag doesn't look inlined — check manually:\n" + headStart);
}
if (!quotesHtml.includes(`<style>${css.slice(0, 40)}`)) {
  throw new Error("style tag doesn't look inlined — css not found where expected");
}

// --- Estimates and Cost Planner are already self-contained, embed verbatim ---
const estimatesHtml = fs.readFileSync(estimatesPath, "utf8");
const costPlannerHtml = fs.readFileSync(costPlannerPath, "utf8");
const ratesLibraryHtml = fs.readFileSync(ratesLibraryPath, "utf8");

const quotesB64 = Buffer.from(quotesHtml, "utf8").toString("base64");
const estimatesB64 = Buffer.from(estimatesHtml, "utf8").toString("base64");
const costPlannerB64 = Buffer.from(costPlannerHtml, "utf8").toString("base64");
const ratesLibraryB64 = Buffer.from(ratesLibraryHtml, "utf8").toString("base64");

/* A visible build stamp. Without one, "am I on the latest version?" is
 * unanswerable from the browser — the portal is one 5 MB HTML file whose apps
 * are base64 payloads, so nothing on screen reveals which build is running and
 * a stale tab looks exactly like a fresh one. Vercel exposes the commit it
 * built from; locally, fall back to asking git. */
function buildStamp() {
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7)
    || (() => { try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "local"; } })();
  return `${sha} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
const stamp = buildStamp();

let shell = fs.readFileSync(shellPath, "utf8");
shell = shell
  .replace("__QUOTES_B64__", quotesB64)
  .replace("__ESTIMATES_B64__", estimatesB64)
  .replace("__COSTPLANNER_B64__", costPlannerB64)
  .replace("__RATESLIBRARY_B64__", ratesLibraryB64)
  .replaceAll("__BUILD_STAMP__", stamp);

fs.writeFileSync(outPath, shell);
console.log("Build stamp:", stamp);
console.log("Assembled combined portal at", outPath, "-", (fs.statSync(outPath).size / 1024 / 1024).toFixed(2), "MB");
