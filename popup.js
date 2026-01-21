/**
 * Sora Prompt Queue - Popup Script
 * 
 * Handles the extension popup UI and communication with background/content scripts
 */

(function() {
  'use strict';

  const STORAGE_KEY = 'soraQueue';

  // DOM Elements
  const elements = {
    notOnSora: document.getElementById('not-on-sora'),
    mainContent: document.getElementById('main-content'),
    statusIndicator: document.getElementById('status-indicator'),
    statusValue: document.getElementById('status-value'),
    queuedCount: document.getElementById('queued-count'),
    activeCount: document.getElementById('active-count'),
    tokenStatus: document.getElementById('token-status'),
    toggleBtn: document.getElementById('toggle-btn'),
    openSoraBtn: document.getElementById('open-sora-btn'),
    clearQueueBtn: document.getElementById('clear-queue-btn')
  };

  /**
   * Check if current tab is Sora
   */
  async function checkCurrentTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (tab && tab.url && tab.url.includes('sora.chatgpt.com')) {
        elements.notOnSora.style.display = 'none';
        elements.mainContent.style.display = 'block';
        loadState();
        loadTokenStatus();
        return true;
      } else {
        elements.notOnSora.style.display = 'block';
        elements.mainContent.style.display = 'none';
        return false;
      }
    } catch (error) {
      console.error('Error checking tab:', error);
      return false;
    }
  }

  /**
   * Load queue state from storage
   */
  async function loadState() {
    try {
      const result = await chrome.storage.local.get([STORAGE_KEY]);
      const data = result[STORAGE_KEY] || {};

      const queue = data.queue || [];
      const isPaused = data.isPaused || false;
      const pauseReason = data.pauseReason || null;
      const isAutomationEnabled = data.isAutomationEnabled !== false;
      const dailyLimitResetTime = data.dailyLimitResetTime || null;

      // Update UI
      const queuedItems = queue.filter(i => i.status === 'queued' || i.status === 'sending');
      elements.queuedCount.textContent = queuedItems.length;

      // Status
      if (isPaused) {
        elements.statusIndicator.className = 'status-indicator paused';
        elements.statusValue.textContent = `Paused: ${pauseReason || 'manual'}`;
        elements.statusValue.className = 'stat-value warning';
        
        if (pauseReason === 'daily_limit' && dailyLimitResetTime) {
          const remaining = dailyLimitResetTime - Date.now();
          if (remaining > 0) {
            const hours = Math.floor(remaining / 3600000);
            const mins = Math.floor((remaining % 3600000) / 60000);
            elements.statusValue.textContent = `Daily limit (${hours}h ${mins}m)`;
            elements.statusValue.className = 'stat-value error';
          }
        }
      } else if (!isAutomationEnabled) {
        elements.statusIndicator.className = 'status-indicator inactive';
        elements.statusValue.textContent = 'Disabled';
        elements.statusValue.className = 'stat-value';
      } else {
        elements.statusIndicator.className = 'status-indicator active';
        elements.statusValue.textContent = 'Running';
        elements.statusValue.className = 'stat-value success';
      }

      // Active count - try to get from debug state
      elements.activeCount.textContent = '?/3';

      // Update toggle button text
      if (isPaused) {
        elements.toggleBtn.textContent = 'Resume Automation';
      } else if (!isAutomationEnabled) {
        elements.toggleBtn.textContent = 'Enable Automation';
      } else {
        elements.toggleBtn.textContent = 'Pause Automation';
      }

    } catch (error) {
      console.error('Error loading state:', error);
    }
  }

  /**
   * Load token status from background
   */
  async function loadTokenStatus() {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_TOKEN_STATUS' });
      
      if (result.hasToken) {
        elements.tokenStatus.textContent = '✅ Captured';
        elements.tokenStatus.className = 'stat-value success';
      } else {
        elements.tokenStatus.textContent = '❌ Not captured';
        elements.tokenStatus.className = 'stat-value error';
      }
    } catch (error) {
      console.error('Error loading token status:', error);
      elements.tokenStatus.textContent = '? Unknown';
      elements.tokenStatus.className = 'stat-value';
    }
  }

  /**
   * Toggle automation via storage update
   */
  async function toggleAutomation() {
    try {
      const result = await chrome.storage.local.get([STORAGE_KEY]);
      const data = result[STORAGE_KEY] || {};

      if (data.isPaused) {
        // Resume
        data.isPaused = false;
        data.pauseReason = null;
      } else if (data.isAutomationEnabled === false) {
        // Enable
        data.isAutomationEnabled = true;
      } else {
        // Disable
        data.isAutomationEnabled = false;
      }

      await chrome.storage.local.set({ [STORAGE_KEY]: data });
      loadState();

    } catch (error) {
      console.error('Error toggling automation:', error);
    }
  }

  /**
   * Clear the queue
   */
  async function clearQueue() {
    if (!confirm('Clear all queued prompts?')) return;

    try {
      const result = await chrome.storage.local.get([STORAGE_KEY]);
      const data = result[STORAGE_KEY] || {};
      
      data.queue = [];
      
      await chrome.storage.local.set({ [STORAGE_KEY]: data });
      loadState();
    } catch (error) {
      console.error('Error clearing queue:', error);
    }
  }

  /**
   * Open/focus Sora tab
   */
  async function openSoraTab() {
    try {
      // Check if Sora tab exists
      const tabs = await chrome.tabs.query({ url: 'https://sora.chatgpt.com/*' });
      
      if (tabs.length > 0) {
        // Focus existing tab
        await chrome.tabs.update(tabs[0].id, { active: true });
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        // Create new tab
        await chrome.tabs.create({ url: 'https://sora.chatgpt.com' });
      }
      
      window.close();
    } catch (error) {
      console.error('Error opening Sora tab:', error);
    }
  }

  /**
   * Initialize
   */
  async function init() {
    // Check current tab
    await checkCurrentTab();

    // Bind events
    elements.toggleBtn.addEventListener('click', toggleAutomation);
    elements.openSoraBtn.addEventListener('click', openSoraTab);
    elements.clearQueueBtn.addEventListener('click', clearQueue);

    // Listen for storage changes
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[STORAGE_KEY]) {
        loadState();
      }
    });

    // Refresh periodically
    setInterval(() => {
      loadState();
      loadTokenStatus();
    }, 2000);
  }

  init();
})();
