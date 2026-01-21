# 🎬 Sora Prompt Queue

<p align="center">
  <img src="https://img.shields.io/badge/Chrome-Extension-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome Extension">
  <img src="https://img.shields.io/badge/Manifest-V3-00C853?style=for-the-badge" alt="Manifest V3">
  <img src="https://img.shields.io/badge/Version-1.1.0-blue?style=for-the-badge" alt="Version 1.1.0">
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="MIT License">
</p>

<p align="center">
  <b>Queue multiple Sora prompts and auto-submit them when generation slots become available.</b>
</p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-installation">Installation</a> •
  <a href="#-usage">Usage</a> •
  <a href="#-how-it-works">How It Works</a> •
  <a href="#-troubleshooting">Troubleshooting</a>
</p>

---

## 🎯 The Problem

Sora limits you to **3 concurrent video generations**. When you have multiple ideas, you're stuck waiting and manually submitting each prompt one by one.

## ✨ The Solution

This extension lets you **queue up unlimited prompts** locally and automatically submits them as soon as a generation slot opens up. Set it and forget it.

---

## 🚀 Features

| Feature | Description |
|---------|-------------|
| **📥 Prompt Queue** | Add unlimited prompts to a local queue |
| **⚡ Auto-Submit** | Automatically submits when active tasks < 3 |
| **🔐 Token Capture** | Automatically captures auth tokens from manual generations |
| **⏰ Daily Limit Detection** | Pauses gracefully when credits exhausted, shows reset countdown |
| **💾 Persistent Storage** | Queue survives page reloads and browser restarts |
| **🖥️ Multi-Tab Aware** | Coordinates across tabs to prevent double-submissions |
| **🐛 Debug Mode** | Built-in debug panel for troubleshooting |

---

## 📦 Installation

### From Source (Developer Mode)

1. **Download** this repository (Code → Download ZIP) or clone it:
   ```bash
   git clone https://github.com/YOUR_USERNAME/sora-prompt-queue.git
   ```

2. **Open Chrome** and navigate to `chrome://extensions/`

3. **Enable Developer Mode** (toggle in top right corner)

4. **Click "Load unpacked"** and select the extension folder

5. **Navigate to [sora.chatgpt.com](https://sora.chatgpt.com)** — the queue panel will appear!

---

## 🎮 Usage

### First-Time Setup

1. Go to [sora.chatgpt.com](https://sora.chatgpt.com)
2. The queue panel appears in the bottom-right corner
3. **Generate one video manually** — this captures the auth token
4. Once **Token: ✅** appears, you're ready to queue!

### Adding Prompts

| Method | How |
|--------|-----|
| **Queue Panel** | Type prompt → Select orientation → Click "Add to Queue" |
| **Floating Button** | Enter prompt in Sora's input → Click **📥 Queue** button |
| **Keyboard Shortcut** | Enter prompt in Sora's input → Press `Ctrl+Shift+Q` |

### Controls

| Button | Action |
|--------|--------|
| ▶️ / ⏸️ / ⏹️ | Play / Pause / Stop automation |
| 🐛 | Toggle debug panel |
| ➖ | Minimize panel |
| ⬆️ ⬇️ | Reorder queue items |
| ❌ | Remove from queue |
| 🔑 | Manually set token (for testing) |
| 🔄 | Refresh status |

### Status Indicators

| Indicator | Meaning |
|-----------|---------|
| **Token: ✅** | Ready to auto-submit |
| **Token: ❌** | Generate once manually to capture token |
| **MAIN: ✅** | API execution working |
| **Ctrl: ✅** | This tab is controlling submissions |
| **Active: 2/3** | 2 of 3 generation slots in use |

---

## ⚙️ How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                  Background Service Worker                   │
│  • Captures tokens via chrome.webRequest                    │
│  • Executes API calls in page context (MAIN world)          │
│  • Coordinates multi-tab controller selection               │
└─────────────────────────────────────────────────────────────┘
                              ↕️
┌─────────────────────────────────────────────────────────────┐
│                     Content Script                           │
│  • Manages queue UI panel                                   │
│  • Controls automation (poll every 5s, submit when ready)   │
│  • Persists queue to chrome.storage.local                   │
└─────────────────────────────────────────────────────────────┘
```

### Token Capture

When you generate a video manually, the extension intercepts the request headers and captures the `openai-sentinel-token`. This token is stored in session storage (auto-clears when browser closes) and reused for queued submissions.

### Rate Limit Handling

| Limit Type | Detection | Action |
|------------|-----------|--------|
| **Concurrent (3 active)** | `too_many_concurrent_tasks` | Requeue, backoff, retry |
| **Daily Credits** | `rate_limit_exhausted` | **Stop automation**, show countdown |

---

## 🔧 Configuration

Edit `content_script.js` to customize:

```javascript
const CONFIG = {
  POLL_INTERVAL_MS: 5000,        // Poll every 5 seconds
  SUBMIT_COOLDOWN_MS: 2000,      // Min time between submissions
  MAX_CONCURRENT_TASKS: 3,       // Sora's limit
  BACKOFF_BASE_MS: 10000,        // Retry backoff
  DEBUG: true                    // Console logging
};
```

---

## 🐛 Troubleshooting

<details>
<summary><b>Token won't capture (stays ❌)</b></summary>

1. Make sure you're on `sora.chatgpt.com`
2. Generate at least one video **manually** using Sora's native button
3. Check DevTools Console → filter by `SoraQueue`
4. Look for: `[SoraQueue:BG] Captured token (length=XXX)`

</details>

<details>
<summary><b>Submissions keep failing</b></summary>

1. Clear token (🔑 Clear) and regenerate manually
2. Check if daily limit reached (panel will show countdown)
3. Verify you're logged in to OpenAI
4. Enable debug panel (🐛) to see detailed status

</details>

<details>
<summary><b>Panel doesn't appear</b></summary>

1. Refresh the page
2. Check extension is enabled at `chrome://extensions/`
3. Check for errors in DevTools Console

</details>

<details>
<summary><b>"Extension context invalidated" errors</b></summary>

This happens when the extension updates while tabs are open. Just **reload the page**.

</details>

---

## 🔒 Privacy & Security

- ✅ **Tokens stored in session** — auto-clears when browser closes
- ✅ **No external requests** — only communicates with sora.chatgpt.com
- ✅ **No data collection** — prompts stay local in your browser
- ✅ **Token values never logged** — only length for debugging
- ✅ **Open source** — audit the code yourself

---

## 📁 Project Structure

```
sora-prompt-queue/
├── manifest.json        # Extension manifest (MV3)
├── background.js        # Service worker (token capture, API execution)
├── content_script.js    # UI panel, queue management, automation
├── styles.css           # Panel styling
├── popup.html           # Extension popup
├── popup.js             # Popup logic
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## 🤝 Contributing

Contributions are welcome! Feel free to:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## ⚠️ Disclaimer

This extension is **not affiliated with OpenAI**. It interacts with Sora in ways that may not be officially supported. Use responsibly:

- OpenAI may change their API at any time
- Excessive automated requests could affect your account
- This tool enhances legitimate use, not circumvent limits

---

<p align="center">
  Made with ❤️ for Sora creators who have too many ideas
</p>

<p align="center">
  <a href="https://sora.chatgpt.com">Try Sora</a> •
  <a href="https://github.com/YOUR_USERNAME/sora-prompt-queue/issues">Report Bug</a> •
  <a href="https://github.com/YOUR_USERNAME/sora-prompt-queue/issues">Request Feature</a>
</p>
