import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const chromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const userDataDir = path.join(root, ".tmp-chrome-sandbox-profile");

function runChromeDump(fileName, budget = "4000", search = "") {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  const fileUrl = `file://${path.join(__dirname, fileName)}${search}`;
  const args = [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-gpu",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${userDataDir}`,
    `--virtual-time-budget=${budget}`,
    "--dump-dom",
    fileUrl
  ];

  try {
    return execFileSync(chromeBin, args, {
      encoding: "utf8",
      timeout: 15000
    });
  } catch (error) {
    if (error.code === "ETIMEDOUT" && error.stdout) {
      return error.stdout;
    }

    throw error;
  }
}

function textContent(html, id) {
  const match = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>([\\s\\S]*?)<\\/[^>]+>`));
  return match?.[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim() || "";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const contentHtml = runChromeDump("content-sandbox.html");
const result = JSON.parse(textContent(contentHtml, "result"));
const account = result.storage.claudeAccounts?.["sandbox.account@example.com"];
assert(account, "content script did not store sandbox account");
assert(account.quotaResetAt > Date.now(), "content script did not store a future quota reset timestamp");
assert(result.storage.claudeActiveAccountId === "sandbox.account@example.com", "active account id was not stored");
assert(result.messages.some((message) => message.type === "quota-block-detected"), "quota-block-detected message was not emitted");

const fallbackContentHtml = runChromeDump("content-fallback-sandbox.html");
const fallbackResult = JSON.parse(textContent(fallbackContentHtml, "result"));
const fallbackAccount = fallbackResult.storage.claudeAccounts?.["hidden.active@example.com"];
assert(fallbackAccount, "fallback sandbox lost the stored active email account");
assert(fallbackAccount.quotaResetAt > Date.now(), "fallback sandbox did not attach the quota block to the stored active email account");
assert(fallbackResult.storage.claudeLastQuotaEvent?.accountId === "hidden.active@example.com", "fallback sandbox did not record the quota event against the stored active email");

const popupHtml = runChromeDump("popup-sandbox.html", "2500");
assert(popupHtml.includes("AVAILABLE"), "popup did not render AVAILABLE for the unrestricted account");
assert(popupHtml.includes("Unavailable till"), "popup did not render unavailable reset text");
assert(popupHtml.includes("1 available, 1 unavailable"), "popup summary did not count account states correctly");

const beforeResetHtml = runChromeDump("popup-time-sandbox.html", "2500", "?phase=before");
assert(beforeResetHtml.includes("Unavailable till"), "popup did not show unavailable before the reset time");
assert(beforeResetHtml.includes("1 available, 1 unavailable"), "popup did not count the account as unavailable before reset");

const afterResetHtml = runChromeDump("popup-time-sandbox.html", "2500", "?phase=after");
assert(afterResetHtml.includes("2 available, 0 unavailable"), "popup did not flip the account to available after reset");
assert(!afterResetHtml.includes("Unavailable till"), "popup still showed unavailable after reset time passed");

fs.rmSync(userDataDir, { recursive: true, force: true });
console.log("sandbox e2e ok");
