# Sora Prompt Queue - Chrome Extension v1.1.0

A Chrome Extension (Manifest V3) for [sora.chatgpt.com](https://sora.chatgpt.com) that queues up multiple Sora prompts locally and automatically submits them when the "3 generations in progress" limit allows.

## What's New in v1.1.0

- **Reliable Token Capture**: Uses `chrome.webRequest.onBeforeSendHeaders` to capture tokens from manual submissions (no more fragile fetch monkeypatching)
- **CSP-Safe Execution**: Uses `chrome.scripting.executeScript` with `world: "MAIN"` instead of script tag injection that CSP could block
- **Multi-Tab Coordination**: Only one tab acts as the "controller" to prevent double-submissions
- **Robust Rate Limit Detection**: Properly distinguishes between concurrent limit (3 active) and daily limit (credits exhausted)
- **Debug Panel**: Toggle debug mode to see detailed status information
- **No Infinite Retry Loops**: Daily limit properly pauses automation instead of retrying forever

## Features

- **Queue Management**: Add multiple prompts to a local queue instead of waiting
- **Auto-Submit**: Automatically submits queued prompts when active tasks drop below 3
- **Token Capture**: Captures authentication tokens automatically from manual submissions
- **Daily Limit Handling**: Detects daily credit exhaustion and pauses gracefully with countdown
- **Persistent Queue**: Queue survives page reloads and browser restarts
- **Clean UI**: Minimalist on-page panel with queue status and controls

## Installation

### From Source (Developer Mode)

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `sora-queue-extension` folder

### Files Required

```
sora-queue-extension/
├── manifest.json
├── background.js
├── content_script.js
├── styles.css
├── popup.html
├── popup.js
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## How to Verify Token Capture

1. **Open DevTools** (F12) in any Sora tab
2. **Go to Console** and filter by `SoraQueue`
3. **Generate one video manually** using Sora's native interface
4. **Look for the log**: `[SoraQueue:BG] Captured token (length=XXX)`
5. **Check the panel**: Token status should show ✅

### Alternative: Check Extension Service Worker

1. Go to `chrome://extensions/`
2. Find "Sora Prompt Queue"
3. Click "Service Worker" link
4. Check the console for capture logs

## How to Test Submissions

1. **Verify token capture** (see above)
2. **Add a prompt to queue** via the panel or Ctrl+Shift+Q
3. **Ensure active tasks < 3** (check "Active" count in panel)
4. **Watch the queue item** change from "⏳ Queued" to "🚀 Sending..."
5. **Check console** for `[SoraQueue:CS] Submitting:` and `Submission successful`

## Usage

### First-Time Setup

1. Navigate to [sora.chatgpt.com](https://sora.chatgpt.com)
2. The queue panel will appear in the bottom-right corner
3. **Important**: Generate at least one video manually first - this allows the extension to capture the authentication token
4. Once "Token: ✅" appears in the status bar, you're ready to queue

### Adding Prompts to Queue

**Method 1: Use the queue panel**
- Type your prompt in the panel's text area
- Select orientation (portrait/landscape/square)
- Click "Add to Queue"

**Method 2: Use the floating button**
- Enter your prompt in Sora's native input field
- Click the "📥 Queue" floating button

**Method 3: Keyboard shortcut**
- Enter your prompt in Sora's native input
- Press `Ctrl+Shift+Q` to queue it

### Queue Controls

| Control | Action |
|---------|--------|
| ▶️ / ⏸️ / ⏹️ | Toggle automation (play/pause/stop) |
| 🐛 | Toggle debug panel |
| ➖ | Minimize/expand panel |
| ⬆️ / ⬇️ | Reorder queued items |
| ❌ | Remove item from queue |
| 🔄 | Manually refresh status |
| 🔑 Set Token | Manually paste a token for testing |

### Status Indicators

| Status | Meaning |
|--------|---------|
| Token: ✅ | Token captured, ready to auto-submit |
| Token: ❌ | No token - generate once manually |
| MAIN: ✅ | MAIN world execution working |
| MAIN: ❓ | MAIN world not yet verified |
| Ctrl: ✅ | This tab is the controller |
| Ctrl: ➖ | Another tab is controlling |
| Active: X/3 | Current active generations vs. limit |

### Debug Panel

Click 🐛 to toggle the debug panel showing:
- Automation status (ON/OFF)
- Paused state and reason
- Controller status
- Token presence
- MAIN world readiness
- Active task count
- Queue length
- Last poll/submit times
- Daily limit reset time

## How It Works

### Architecture (v1.1.0)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Background Service Worker                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    background.js                         │   │
│  │  • Captures tokens via webRequest.onBeforeSendHeaders   │   │
│  │  • Stores tokens in chrome.storage.session              │   │
│  │  • Executes MAIN-world API calls via executeScript      │   │
│  │  • Coordinates multi-tab controller selection           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              ▲                                  │
│                              │ chrome.runtime.sendMessage       │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  content_script.js                       │   │
│  │  • Manages queue state & UI panel                       │   │
│  │  • Controls automation (polling + submit)               │   │
│  │  • Persists queue to chrome.storage.local               │   │
│  │  • Listens for storage changes from popup               │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Token Capture Strategy

The extension uses `chrome.webRequest.onBeforeSendHeaders` in the service worker to:

1. Listen for POST requests to `/backend/nf/create`
2. Capture the `openai-sentinel-token` header from manual submissions
3. Also capture `oai-device-id` and `oai-language` if present
4. Store in `chrome.storage.session` (clears on browser close)

**Why this approach?**
- Works even if Sora uses bound fetch, XHR, or web workers
- Not affected by CSP restrictions
- More reliable than monkeypatching `window.fetch`

### API Execution

API calls (pending/create) are executed using:
```javascript
chrome.scripting.executeScript({
  target: { tabId },
  world: 'MAIN',
  func: async function() { /* fetch call */ },
  args: [/* parameters */]
})
```

This runs the fetch in the page's origin context with proper cookies/session, while avoiding CSP issues that could block injected `<script>` tags.

### Rate Limit Handling

**Concurrent Limit (3 in progress)**
- Detected by: `error.code === "too_many_concurrent_tasks"` OR `error.details.num_tasks === 3` OR message patterns
- Action: Requeue the prompt, back off with jitter, continue automation

**Daily/Credit Limit**
- Detected by: `type === "rate_limit_exhausted"` OR `rate_limit_and_credit_balance.rate_limit_reached === true && credit_remaining === 0`
- Action: **STOP automation immediately**, show countdown, provide "Retry Now" button
- No infinite retry loops!

## API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/backend/nf/pending/v2` | GET | Poll active task count |
| `/backend/nf/create` | POST | Submit new generation |

## Configuration

Default configuration in `content_script.js`:

```javascript
const CONFIG = {
  POLL_INTERVAL_MS: 5000,           // Poll every 5 seconds
  POLL_INTERVAL_BACKOFF_MS: 15000,  // Backoff when at limit
  SUBMIT_COOLDOWN_MS: 2000,         // Min time between submissions
  MAX_CONCURRENT_TASKS: 3,          // Sora's limit
  BACKOFF_BASE_MS: 10000,           // Retry backoff base
  BACKOFF_JITTER_MS: 5000,          // Random jitter
  PROMPT_PREVIEW_LENGTH: 80,        // Characters in preview
  HEARTBEAT_INTERVAL_MS: 5000,      // Controller heartbeat
  DEBUG: true                       // Debug logging
};
```

## Troubleshooting

### "Token: ❌" won't change to ✅

1. Make sure you're on sora.chatgpt.com (not a different OpenAI page)
2. Generate at least one video manually using Sora's native interface
3. Check DevTools Console → filter by "SoraQueue" → look for "Captured token"
4. Check Service Worker console (chrome://extensions/ → Service Worker link)

### Queue submissions keep failing

1. Token may be invalid - clear and regenerate manually
2. Check if you've hit daily limit (shown in panel alert)
3. Verify you're logged in to OpenAI/Sora
4. Check the debug panel (🐛) for detailed status

### Panel doesn't appear

1. Refresh the page
2. Check that the extension is enabled in `chrome://extensions/`
3. Look for JavaScript errors in console

### "Daily limit reached" but I have credits

1. The extension reads the API response literally
2. Try clicking "Retry Now" to re-check
3. Manually generate to verify your credit status

### Multiple tabs showing different states

1. Only one tab is the "controller" - check "Ctrl:" status
2. The controller tab does all polling and submitting
3. If the controller tab closes, another will take over

### "Extension context invalidated" errors

This happens when the extension is updated while tabs are open. Simply **reload the page**.

## Security & Privacy

- **Tokens stored in session**: Clears when browser closes
- **No external requests**: Only communicates with sora.chatgpt.com
- **No data collection**: Prompts and queue stay local to your browser
- **Token values never logged**: Only token length is logged for debugging

## License

MIT License - Use at your own risk. This extension is not affiliated with OpenAI.

## Disclaimer

This extension interacts with OpenAI's Sora service in ways that may not be officially supported. Use responsibly and be aware that:

- OpenAI may change their API at any time, breaking this extension
- Excessive automated requests could potentially affect your account
- This tool is meant to enhance legitimate use, not circumvent usage limits
