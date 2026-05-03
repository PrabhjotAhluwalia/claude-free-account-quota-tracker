import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const browserBin = process.env.BROWSER_BIN || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const profileDir = path.join(root, ".tmp-real-extension-profile");
const debugPort = 9333;
const pageHost = "sandbox.claude.ai";
const pagePort = 18765;
const testEmail = "real.e2e@example.com";
let chromeStderr = "";

function formatClock(date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(date);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer() {
  const resetClock = formatClock(new Date(Date.now() + 90 * 60 * 1000));
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Claude-like E2E Page</title>
    <script>
      localStorage.setItem("claude-auth-user", JSON.stringify({
        account: {
          email: "${testEmail}",
          displayName: "Real E2E Account"
        }
      }));
    </script>
  </head>
  <body>
    <main data-testid="chat">
      <button data-testid="profile-menu" aria-label="Account ${testEmail}">RE</button>
      <textarea aria-label="Write a message"></textarea>
      <div class="composer-banner">You are out of free messages until ${resetClock} <a href="#">Get more</a></div>
    </main>
  </body>
</html>`;

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pagePort, "127.0.0.1", () => resolve(server));
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  return response.json();
}

async function waitForTargets() {
  const started = Date.now();
  let lastTargets = [];
  while (Date.now() - started < 20000) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      lastTargets = targets;
      const page = targets.find((target) => target.type === "page" && target.url.includes(pageHost));
      const workers = targets.filter((target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://"));

      if (page && workers.length > 0) {
        return { page, workers };
      }
    } catch (_error) {
      // Chrome is still starting.
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for page and extension service worker targets. Last targets: ${JSON.stringify(lastTargets.map((target) => ({
    type: target.type,
    url: target.url,
    title: target.title
  })), null, 2)}`);
}

async function findExtensionWorker(workers) {
  const inspected = [];

  for (const worker of workers) {
    const client = await createCdpClient(worker.webSocketDebuggerUrl);
    const manifestResult = await client.send("Runtime.evaluate", {
      expression: "chrome.runtime.getManifest().name",
      returnByValue: true
    });
    const name = manifestResult.result.value;
    inspected.push({ url: worker.url, name });

    if (name === "Claude Free Account Quota Tracker") {
      return { worker, client };
    }

    client.close();
  }

  throw new Error(`Could not find Claude extension worker. Inspected: ${JSON.stringify(inspected, null, 2)}`);
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let id = 0;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }

    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);

    if (message.error) {
      reject(new Error(message.error.message));
    } else {
      resolve(message.result);
    }
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          id += 1;
          const requestId = id;
          socket.send(JSON.stringify({ id: requestId, method, params }));
          return new Promise((requestResolve, requestReject) => {
            pending.set(requestId, { resolve: requestResolve, reject: requestReject });
          });
        },
        close() {
          socket.close();
        }
      });
    });
    socket.addEventListener("error", reject);
  });
}

async function main() {
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const server = await startServer();
  const chrome = spawn(browserBin, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--window-size=1100,850",
    `--host-resolver-rules=MAP ${pageHost} 127.0.0.1`,
    `http://${pageHost}:${pagePort}/`
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  chrome.stderr.on("data", (chunk) => {
    chromeStderr += chunk.toString();
  });

  const cleanup = async () => {
    let exited = false;
    const exitPromise = new Promise((resolve) => {
      chrome.once("exit", () => {
        exited = true;
        resolve();
      });
    });

    chrome.kill("SIGTERM");

    await Promise.race([
      exitPromise,
      delay(3000).then(() => {
        if (!exited) {
          chrome.kill("SIGKILL");
        }
      })
    ]);

    if (!exited) {
      await Promise.race([exitPromise, delay(1500)]);
    }

    server.close();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 4) {
          throw error;
        }

        await delay(500);
      }
    }
  };

  try {
    const { page, workers } = await waitForTargets();
    const { worker, client: workerClient } = await findExtensionWorker(workers);
    const pageClient = await createCdpClient(page.webSocketDebuggerUrl);
    await pageClient.send("Page.enable");
    await pageClient.send("Page.navigate", {
      url: `http://${pageHost}:${pagePort}/`
    });
    await delay(1500);
    await pageClient.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true
    });

    await delay(2500);

    const storageResult = await workerClient.send("Runtime.evaluate", {
      expression: `(async () => chrome.storage.local.get(["claudeAccounts", "claudeActiveAccountId", "claudeLastQuotaEvent"]))()`,
      awaitPromise: true,
      returnByValue: true
    });

    const storage = storageResult.result.value;
    const account = storage.claudeAccounts?.[testEmail];

    assert(account, `real extension did not store the account. Storage was: ${JSON.stringify(storage, null, 2)}`);
    assert(storage.claudeActiveAccountId === testEmail, "real extension did not mark the account active");
    assert(account.quotaResetAt > Date.now(), "real extension did not store a future quota reset");
    assert(/out of free messages/i.test(account.quotaMessage), "real extension did not store the quota message");
    assert(storage.claudeLastQuotaEvent?.accountId === testEmail, "real extension did not store the quota event account id");

    console.log(JSON.stringify({
      status: "real extension e2e ok",
      extensionWorker: worker.url,
      pageUrl: page.url,
      account: {
        id: account.id,
        label: account.label,
        quotaResetAt: account.quotaResetAt,
        quotaMessage: account.quotaMessage
      }
    }, null, 2));

    if (process.env.KEEP_OPEN === "1") {
      const extensionId = worker.url.match(/^chrome-extension:\/\/([^/]+)/)?.[1];
      if (extensionId) {
        await pageClient.send("Page.navigate", {
          url: `chrome-extension://${extensionId}/popup.html`
        });
        await delay(1000);
        console.log(`manual inspection ready: chrome-extension://${extensionId}/popup.html`);
      }

      await new Promise(() => {});
    }

    pageClient.close();
    workerClient.close();
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  if (typeof chromeStderr !== "undefined" && chromeStderr) {
    console.error(chromeStderr);
  }
  process.exitCode = 1;
});
