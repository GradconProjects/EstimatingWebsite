// Browser bundle for the AI Engine's Quality checks tab: window.GradconQA (see vite.qa.config.js).
export { runQualityChecks, benchmarksFrom, median, compareTakeoffToDocuments, instanceFacts, matchInstances, rateBenchmarkFindings } from "./lib/qualityChecks.js";
export { computeGrandTotal, computeElementCost } from "./lib/costing.js";
export { effectiveRates } from "./lib/rateFreeze.js";
export { ELEMENT_TYPES, FULL_CATALOG, RESOURCE_COLS } from "./data/catalog.js";
export { rateKey, defaultRates } from "./lib/costing.js";
