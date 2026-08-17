/**
 * Checks the curated OpenRouter catalog against the live OpenRouter model API.
 *
 * Reports, per vendor we curate:
 *  - DEAD slugs — cataloged ids no longer served by OpenRouter (picking one in
 *    the UI fails at request time). These exit non-zero so CI can gate on them.
 *  - Newer arrivals — live models from the same vendor created after the newest
 *    model we list for that vendor, i.e. the "we're out of date" signal.
 *
 * Run: npm run catalog:check (worker package). Network-dependent by design —
 * keep it out of the unit-test suite.
 */

import { MODEL_CATALOG } from "../src/model-catalog.js";

interface LiveModel {
  id: string;
  name: string;
  created: number;
}

// Modality/variant noise we never curate: ":free"/":batch" variants and
// media-generation models.
const IGNORE = /:|image|video|audio|imagen|veo|lyria|tts/i;

// A live id that is a cataloged id plus a serving-mode suffix (opus-5-fast,
// luna-pro) is the same model on different serving terms, not a new release.
function isServingVariantOfCatalog(id: string, catalogIds: string[]): boolean {
  return catalogIds.some(
    (c) => id.startsWith(`${c}-`) && /^(fast|pro|mini|turbo)$/.test(id.slice(c.length + 1)),
  );
}

const res = await fetch("https://openrouter.ai/api/v1/models");
if (!res.ok) {
  console.error(`OpenRouter API request failed: ${res.status}`);
  process.exit(2);
}
const live: LiveModel[] = (await res.json()).data;
const liveById = new Map(live.map((m) => [m.id, m]));

const curated = MODEL_CATALOG.OpenRouter;
const dead = curated.filter((m) => !liveById.has(m.id));

const vendors = [...new Set(curated.map((m) => m.id.split("/")[0]))];
const catalogIds = curated.map((m) => m.id);
let staleVendors = 0;
for (const vendor of vendors) {
  const ourNewest = Math.max(
    ...curated
      .filter((m) => m.id.startsWith(`${vendor}/`))
      .map((m) => liveById.get(m.id)?.created ?? 0),
  );
  const newer = live
    .filter(
      (m) =>
        m.id.startsWith(`${vendor}/`) &&
        !IGNORE.test(m.id) &&
        !isServingVariantOfCatalog(m.id, catalogIds) &&
        m.created > ourNewest,
    )
    .sort((a, b) => b.created - a.created);
  if (newer.length) {
    staleVendors++;
    console.log(`\n${vendor} — newer than anything we list:`);
    for (const m of newer) {
      const when = new Date(m.created * 1000).toISOString().slice(0, 10);
      console.log(`  ${when}  ${m.id}  (${m.name})`);
    }
  }
}

if (dead.length) {
  console.error("\nDEAD slugs (in catalog, gone from OpenRouter):");
  for (const m of dead) console.error(`  ${m.id}  (${m.label})`);
  console.error(
    "\nUpdate worker/src/model-catalog.ts and web/src/lib/aiUserApi.ts.",
  );
  process.exit(1);
}

console.log(
  staleVendors
    ? "\nAll cataloged slugs are live; review newer arrivals above."
    : "Catalog is current: all slugs live, nothing newer per vendor.",
);
