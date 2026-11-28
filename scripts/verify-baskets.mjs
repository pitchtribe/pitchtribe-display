// Checks the quick-buy baskets on every built buy.html, in every language.
//
// These baskets fail quietly, which is the only reason this exists. A shop that
// cannot sell one of the parts does not say so: Amazon drops an ASIN it has no
// offer on, and it drops every item after a gap in the ASIN.n numbering. So a
// basket that is subtly wrong still opens, still looks right, and hands a
// volunteer an incomplete order. Nothing about that shows up in a build that
// only checks the page renders.
//
// The one that would bite first is the markup href. It is what a shopper with
// JavaScript off actually clicks, and it duplicates the ticked rows by hand, so
// adding a row and forgetting the href is an easy edit that silently ships a
// short basket. Every check here is about the link being a faithful
// reconstruction of what the page says is ticked.
//
// Run against dist/, after the build. Prices are checked for internal
// consistency only -- that the total shown is the sum of the ticked rows. Real
// prices drift and the page presents them as a dated snapshot.

import { readFileSync, existsSync } from "node:fs";

const LANGS = ["fr", "es", "de", "it", "pt", "pl", "ru", "zh", "ja"];
const pages = ["dist/buy.html", ...LANGS.map((l) => `dist/${l}/buy.html`)];

// Mirrors the builders in html/assets/main.js. Deliberately a second copy: this
// asserts the markup matches the documented rule, so if the two ever disagree
// that is the finding, not a maintenance chore to paper over.
const BUILD = {
  amazon: (items) =>
    `https://www.amazon.co.uk/gp/aws/cart/add.html?${items
      .flatMap((it, i) => [`ASIN.${i + 1}=${it.item}`, `Quantity.${i + 1}=1`])
      .join("&")}`,
  // storefront=true is load-bearing: without it Shopify drops the shopper
  // straight into checkout instead of the basket page.
  pihut: (items) =>
    `https://thepihut.com/cart/${items.map((it) => `${it.item}:1`).join(",")}?storefront=true`,
};

// Params that would turn a plain product link into an affiliate one. The page
// promises it earns nothing from these links, so the promise is tested.
const AFFILIATE = ["tag=", "linkCode=", "ascsubtag=", "ref=as_li", "utm_"];

const failures = [];
const fail = (page, msg) => failures.push(`${page}: ${msg}`);
// One pass, not a chain of replaces: unescaping &amp; before the others turns
// a literal "&amp;quot;" into a quote, which is a different string from the one
// the page actually contains.
const ENTITIES = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };
const decode = (s) => s.replace(/&(?:amp|quot|#39|lt|gt);/g, (e) => ENTITIES[e]);

// Every data-basket key in the markup needs a builder in main.js, or the JS
// bails out and the ticks silently stop rebuilding the link.
const mainJs = (() => {
  const hashed = readFileSync("dist/buy.html", "utf8").match(/\/assets\/(main\.[\w.]+\.js)/);
  const path = hashed ? `dist/assets/${hashed[1]}` : "html/assets/main.js";
  if (!existsSync(path)) throw new Error(`cannot find built main.js (looked for ${path})`);
  return readFileSync(path, "utf8");
})();

for (const page of pages) {
  if (!existsSync(page)) {
    fail(page, "missing");
    continue;
  }
  const html = readFileSync(page, "utf8");

  // Each panel runs from its data-basket marker to the next one, or to the end.
  const starts = [...html.matchAll(/<div\s+data-basket="([a-z]+)"/g)];
  if (starts.length < 1) {
    fail(page, `expected at least 1 quick-buy basket, found 0`);
    continue;
  }

  for (const [n, start] of starts.entries()) {
    const shop = start[1];
    const block = html.slice(start.index, starts[n + 1]?.index ?? html.length);
    const where = `basket "${shop}"`;

    const build = BUILD[shop];
    if (!build) {
      fail(page, `${where}: no expected-URL rule for this shop`);
      continue;
    }
    if (!new RegExp(`\\b${shop}\\s*:`).test(mainJs)) {
      fail(page, `${where}: main.js has no basketUrl builder, so the ticks will not rebuild it`);
    }

    // Rows: a row missing data-item drops out of the link without a word.
    const rows = [...block.matchAll(/<input\b[^>]*class="[^"]*\bbasket-tick\b[^"]*"[^>]*>/g)].map(
      (m) => m[0],
    );
    if (!rows.length) {
      fail(page, `${where}: no basket rows`);
      continue;
    }
    const items = rows.map((tag) => ({
      item: tag.match(/data-item="([^"]*)"/)?.[1] ?? "",
      price: tag.match(/data-price="([^"]*)"/)?.[1] ?? "",
      checked: /\bchecked\b/.test(tag),
      id: tag.match(/id="([^"]*)"/)?.[1] ?? "(no id)",
    }));

    for (const it of items) {
      if (!it.item) fail(page, `${where}: row ${it.id} has no data-item, so it cannot be ordered`);
      if (!/^\d+(\.\d+)?$/.test(it.price))
        fail(page, `${where}: row ${it.id} has a non-numeric data-price "${it.price}"`);
    }
    const dupes = items
      .map((it) => it.item)
      .filter((v, i, a) => v && a.indexOf(v) !== i);
    if (dupes.length) fail(page, `${where}: duplicate data-item ${[...new Set(dupes)].join(", ")}`);

    const ticked = items.filter((it) => it.checked);
    if (!ticked.length) {
      fail(page, `${where}: nothing ticked by default, so the button sends an empty basket`);
      continue;
    }

    // The href a JS-off shopper clicks must be exactly the ticked rows.
    const href = decode(block.match(/data-basket-link\s+href="([^"]+)"/s)?.[1] ?? "");
    if (!href) {
      fail(page, `${where}: no data-basket-link href`);
    } else {
      const expected = build(ticked);
      if (href !== expected)
        fail(
          page,
          `${where}: markup href does not match the ${ticked.length} ticked rows\n` +
            `      href:     ${href}\n      expected: ${expected}`,
        );
      for (const param of AFFILIATE)
        if (href.includes(param)) fail(page, `${where}: href carries affiliate param "${param}"`);
    }

    // The count and total on the button are what the reader trusts before they
    // click, so they have to describe the rows that are actually ticked.
    const count = block.match(/data-basket-count>(\d+)</)?.[1];
    if (count !== String(ticked.length))
      fail(page, `${where}: shows "${count}" parts ticked but ${ticked.length} rows are checked`);

    const shown = block.match(/data-basket-total>£([\d.]+)</)?.[1];
    const sum = ticked.reduce((t, it) => t + Number(it.price), 0).toFixed(2);
    if (shown !== sum)
      fail(page, `${where}: shows £${shown} but the ticked rows add up to £${sum}`);
  }
}

if (failures.length) {
  console.error(`Quick-buy basket checks failed (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`Quick-buy baskets OK across ${pages.length} pages.`);
