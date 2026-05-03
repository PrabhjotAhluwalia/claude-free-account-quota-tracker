# Claude Free Account Quota Tracker

A small Manifest V3 browser extension for Chrome and Brave that records Claude.ai account emails and locally tracks quota reset times when Claude shows a free-message limit banner.

The extension stores everything in `chrome.storage.local`; no backend, analytics service, or third-party sync is used.

## What It Does

- Detects the active Claude.ai account email from page storage or visible account UI.
- Remembers each detected email across browser sessions.
- Watches Claude.ai with a `MutationObserver` for quota or message-limit banners.
- Parses reset messages such as `You are out of free messages until 11:40 PM`.
- Stores the reset timestamp against the active account.
- Shows a simple popup dashboard with each account marked as `AVAILABLE` or unavailable until the reset time.
- Falls back to the last known active email when Claude hides the email on a quota-limit page.

## Files

- `manifest.json` - Manifest V3 extension declaration.
- `content.js` - Claude.ai DOM/storage account detection and quota-banner tracking.
- `popup.html` - Popup markup.
- `popup.css` - Popup styling.
- `popup.js` - Popup rendering and availability logic.
- `background.js` - Lightweight service worker for install/update logging.
- `test/` - Browser-like sandbox checks and real-extension E2E helper.

## Install In Brave Or Chrome

1. Open `brave://extensions` or `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:

   ```text
   claude-quota-tracker-extension
   ```

5. Open `https://claude.ai/` while logged in.
6. Open the extension popup to see detected accounts and availability.

## Testing

Run the sandbox suite:

```bash
npm test
```

Or directly:

```bash
node test/run-sandbox-tests.mjs
```

The sandbox suite checks:

- account detection from Claude-like storage and DOM,
- quota reset parsing,
- popup available/unavailable rendering,
- reset-time rollover from unavailable to available,
- hidden-email fallback when Claude shows only a display name on a limit page.

## Notes On Claude UI Changes

Claude.ai changes its frontend frequently. The selectors most likely to need adjustment live at the top of `content.js`:

- `ACCOUNT_SELECTORS`
- `QUOTA_MESSAGE_SELECTORS`
- `RATE_LIMIT_TEXT_PATTERNS`

If detection breaks, inspect the current Claude page with DevTools and add stable attributes such as `aria-label`, `role`, or `data-testid` selectors to those arrays.

## Privacy

This extension keeps account emails and quota reset metadata in local browser extension storage only. It does not send account data to any server.

Stored fields include:

- email,
- last seen time,
- last Claude URL,
- quota reset timestamp,
- quota message text.

## Limitations

- The extension can only track what Claude exposes in the browser UI or page storage.
- If Claude hides the active email, the extension uses the last known active email as a fallback.
- Reset parsing depends on the browser's local timezone.
- Existing Claude tabs may need a refresh after reloading the unpacked extension.
