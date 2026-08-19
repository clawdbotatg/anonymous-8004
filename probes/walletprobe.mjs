// Headless probe of /wallet: locked card, import consent, bad-fragment handling.
// Usage: node probes/walletprobe.mjs https://anonymous-8004.vercel.app
// Env: PLAYWRIGHT_CORE (path to playwright-core/index.mjs), CHROME_BIN (chromium binary) — see probes/README.md
import { readFileSync } from "fs";

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const base = process.argv[2] ?? "http://127.0.0.1:3457";
const vc = readFileSync(new URL("./vc.b64", import.meta.url), "utf8").trim();
const browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {});
const page = await browser.newPage();
const out = {};

// 1) plain /wallet → locked card
await page.goto(`${base}/wallet`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
out.lockedCard = (await page.getByText("Locked").count()) > 0;
out.unlockCta = (await page.getByText("Unlock with wallet signature").count()) > 0 || (await page.getByText(/Connect/i).count()) > 0; // no wallet in headless → Connect is the correct CTA

// 2) #import=<valid vc> → consent card with verified signature + claims
await page.goto(`${base}/wallet#import=${vc}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
out.consentCard = (await page.getByText("An issuer is handing you a credential").count()) > 0;
out.sigVerifies = (await page.getByText("✓ verifies (EdDSA-BabyJubJub)").count()) > 0;
out.claimScore = (await page.getByText("85", { exact: true }).count()) > 0;
out.claimJurisdiction = (await page.getByText("CH", { exact: true }).count()) > 0;
out.neverServer = (await page.getByText("never touched a server").count()) > 0;
out.storeNeedsUnlock = (await page.getByText("unlock below to store it").count()) > 0;

// 3) tampered vc (flip a char in the payload) → must NOT show "verifies"
//    (either unreadable, or renders with "DOES NOT VERIFY")
const tampered = vc.slice(0, 200) + (vc[200] === "A" ? "B" : "A") + vc.slice(201);
await page.goto(`${base}/wallet#import=${tampered}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const okBadge = await page.getByText("✓ verifies (EdDSA-BabyJubJub)").count();
const badBadge = await page.getByText("DOES NOT VERIFY").count();
const unreadable = await page.getByText("unreadable").count();
out.tamperRejected = okBadge === 0 && (badBadge > 0 || unreadable > 0);

// 4) garbage fragment → unreadable card, no crash
await page.goto(`${base}/wallet#import=not-base64!!!`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
out.garbageHandled = (await page.getByText("Locked").count()) > 0; // regex won't match, page still alive

console.log(JSON.stringify(out, null, 2));
await browser.close();
const pass = Object.values(out).every(Boolean);
process.exit(pass ? 0 : 1);
