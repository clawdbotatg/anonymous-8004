// E2E of the real hand-off path: /demo issues → link → /wallet consent card.
// Usage: node probes/handoffprobe.mjs https://anonymous-8004.vercel.app
// Env: PLAYWRIGHT_CORE (path to playwright-core/index.mjs), CHROME_BIN (chromium binary) — see probes/README.md
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const base = process.argv[2] ?? "http://127.0.0.1:3457";
const browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {});
const page = await browser.newPage();
const out = {};
await page.goto(base + "/demo", { waitUntil: "domcontentloaded" });
await page.getByText("Issue credential (sign off-chain)").click();
await page.waitForTimeout(3000);
const link = page.getByText("hand this credential to your wallet", { exact: false });
out.linkAppears = (await link.count()) > 0;
const href = await link.getAttribute("href");
out.hrefIsFragment = !!href && href.startsWith("/wallet#import=");
await page.goto(base + href, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
out.consentCard = (await page.getByText("An issuer is handing you a credential").count()) > 0;
out.sigVerifies = (await page.getByText("✓ verifies (EdDSA-BabyJubJub)").count()) > 0;
out.claimsShown = (await page.getByText("auditScore").count()) > 0 && (await page.getByText("jurisdiction").count()) > 0;
console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(Object.values(out).every(Boolean) ? 0 : 1);
