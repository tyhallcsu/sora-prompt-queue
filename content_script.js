/**
 * Sora Prompt Queue - Content Script
 * 
 * This script runs in the content script context to:
 * 1. Manage the queue UI panel
 * 2. Handle queue state and persistence
 * 3. Control automation (polling + auto-submit)
 * 4. Communicate with background service worker via chrome.runtime.sendMessage
 * 
 * NO MORE script injection - all API calls go through background worker
 * using chrome.scripting.executeScript with world: "MAIN"
 */

(function() {
  'use strict';

  // ============================================================================
  // CONFIGURATION
  // ============================================================================

  const CONFIG = {
    POLL_INTERVAL_MS: 5000,           // Poll pending tasks every 5 seconds
    POLL_INTERVAL_BACKOFF_MS: 15000,  // Backoff interval when at limit
    POLL_JITTER_MS: 2000,             // Random jitter added to backoff
    SUBMIT_COOLDOWN_MS: 2000,         // Minimum time between submissions
    MAX_CONCURRENT_TASKS: 3,
    BACKOFF_BASE_MS: 10000,           // Base backoff for retries
    BACKOFF_JITTER_MS: 5000,          // Random jitter added to backoff
    PROMPT_PREVIEW_LENGTH: 80,        // Characters to show in queue preview
    STORAGE_KEY: 'soraQueue',
    HEARTBEAT_INTERVAL_MS: 5000,      // Controller heartbeat
    DEBUG: true                       // Debug logging
  };

  // ============================================================================
  // STATE
  // ============================================================================

  const state = {
    queue: [],                        // Array of queued prompts
    isAutomationEnabled: true,        // Global automation toggle
    isPaused: false,                  // Paused due to error/limit
    pauseReason: null,                // Why automation is paused
    dailyLimitResetTime: null,        // When daily limit resets
    hasValidToken: false,             // Whether we have a captured token
    lastTokenCapture: null,           // Timestamp of last token capture
    activeTaskCount: 0,               // Current active tasks from polling
    lastPollTime: null,               // Last successful poll timestamp
    lastSubmitTime: null,             // Last submission attempt timestamp
    isSubmitting: false,              // Currently submitting a prompt
    isController: false,              // Is this tab the controller?
    mainWorldReady: false,            // MAIN world execution working
    extensionInvalidated: false,      // True if extension was reloaded
    pollIntervalId: null,             // Interval ID for polling
    heartbeatIntervalId: null,        // Interval ID for controller heartbeat
    dailyLimitIntervalId: null,       // Interval ID for daily-limit reset checks
    debugEnabled: false,              // Debug panel enabled
    uiElements: {}                    // Cached UI elements
  };

  // ============================================================================
  // DEBUG LOGGING
  // ============================================================================

  function debugLog(...args) {
    if (CONFIG.DEBUG || state.debugEnabled) {
      console.log('[SoraQueue:CS]', ...args);
    }
  }

  // ============================================================================
  // EXTENSION CONTEXT HANDLING
  // ============================================================================

  function isExtensionContextInvalidated() {
    try {
      // Try to access chrome.runtime.id - throws if context is invalidated
      return !chrome.runtime?.id;
    } catch {
      return true;
    }
  }

  function handleExtensionInvalidated() {
    if (state.extensionInvalidated) return;
    state.extensionInvalidated = true;
    debugLog('Extension context invalidated; stopping timers. Reload the page.');

    stopAllTimers();
    
    // Update UI to show extension needs reload
    if (state.uiElements.alert) {
      state.uiElements.alert.style.display = 'block';
      state.uiElements.alert.className = 'sqp-alert sqp-alert-error';
      state.uiElements.alert.textContent = 'Extension updated. Please reload the page.';
    }
  }

  function stopAllTimers() {
    if (state.pollIntervalId) {
      clearInterval(state.pollIntervalId);
      state.pollIntervalId = null;
    }
    if (state.heartbeatIntervalId) {
      clearInterval(state.heartbeatIntervalId);
      state.heartbeatIntervalId = null;
    }
    if (state.dailyLimitIntervalId) {
      clearInterval(state.dailyLimitIntervalId);
      state.dailyLimitIntervalId = null;
    }
  }

  // ============================================================================
  // BACKGROUND COMMUNICATION
  // ============================================================================

  /**
   * Send message to background service worker
   */
  async function sendToBackground(type, payload = {}) {
    if (isExtensionContextInvalidated()) {
      handleExtensionInvalidated();
      throw new Error('Extension context invalidated');
    }

    try {
      return await chrome.runtime.sendMessage({ type, payload });
    } catch (err) {
      if (err.message?.includes('Extension context invalidated') ||
          err.message?.includes('message port closed')) {
        handleExtensionInvalidated();
      }
      throw err;
    }
  }

  /**
   * Listen for messages from background
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (state.extensionInvalidated) return;

    switch (message.type) {
      case 'TOKEN_CAPTURED':
        state.hasValidToken = message.hasToken;
        state.lastTokenCapture = Date.now();
        updateUI();
        showNotification('Token captured! Queue submissions enabled.', 'success');
        // Try to submit if we have queued items
        checkAndSubmit();
        break;

      case 'TOKEN_CLEARED':
        state.hasValidToken = false;
        state.lastTokenCapture = null;
        updateUI();
        break;
    }
  });

  // ============================================================================
  // STORAGE CHANGE LISTENER
  // ============================================================================

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (state.extensionInvalidated) return;
    if (areaName !== 'local') return;

    if (changes[CONFIG.STORAGE_KEY]) {
      // Queue state changed (possibly from popup)
      const newData = changes[CONFIG.STORAGE_KEY].newValue || {};
      
      // Update local state from storage
      if (newData.isAutomationEnabled !== undefined && 
          newData.isAutomationEnabled !== state.isAutomationEnabled) {
        state.isAutomationEnabled = newData.isAutomationEnabled;
        debugLog('Automation toggled via storage:', state.isAutomationEnabled);
        
        if (state.isAutomationEnabled) {
          checkAndSubmit();
        }
      }
      
      if (newData.isPaused !== undefined) {
        state.isPaused = newData.isPaused;
        state.pauseReason = newData.pauseReason;
      }
      
      if (newData.queue !== undefined) {
        state.queue = newData.queue;
      }
      
      updateUI();
    }
  });

  // ============================================================================
  // QUEUE MANAGEMENT
  // ============================================================================

  /**
   * Add a prompt to the queue
   */
  function addToQueue(prompt, options = {}) {
    const item = {
      id: `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      prompt: prompt.trim(),
      options: {
        orientation: options.orientation || 'portrait',
        size: options.size || 'small',
        n_frames: options.n_frames || 300,
        model: options.model || 'sy_8',
        ...options
      },
      status: 'queued',           // queued | sending | error | submitted
      errorMessage: null,
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    state.queue.push(item);
    saveQueue();
    updateUI();
    
    debugLog('Added to queue:', item.id, `"${truncatePrompt(item.prompt)}"`);
    
    // Trigger submission check
    checkAndSubmit();
    
    return item;
  }

  /**
   * Remove an item from the queue
   */
  function removeFromQueue(itemId) {
    const index = state.queue.findIndex(item => item.id === itemId);
    if (index !== -1) {
      state.queue.splice(index, 1);
      saveQueue();
      updateUI();
    }
  }

  /**
   * Move item up in queue
   */
  function moveUp(itemId) {
    const index = state.queue.findIndex(item => item.id === itemId);
    if (index > 0) {
      [state.queue[index - 1], state.queue[index]] = [state.queue[index], state.queue[index - 1]];
      saveQueue();
      updateUI();
    }
  }

  /**
   * Move item down in queue
   */
  function moveDown(itemId) {
    const index = state.queue.findIndex(item => item.id === itemId);
    if (index !== -1 && index < state.queue.length - 1) {
      [state.queue[index], state.queue[index + 1]] = [state.queue[index + 1], state.queue[index]];
      saveQueue();
      updateUI();
    }
  }

  /**
   * Update item status
   */
  function updateItemStatus(itemId, status, errorMessage = null) {
    const item = state.queue.find(i => i.id === itemId);
    if (item) {
      item.status = status;
      item.errorMessage = errorMessage;
      item.updatedAt = Date.now();
      if (status === 'error') {
        item.retryCount++;
      }
      saveQueue();
      updateUI();
    }
  }

  /**
   * Persist queue to storage
   */
  function saveQueue() {
    if (state.extensionInvalidated) return;

    const data = {
      queue: state.queue,
      dailyLimitResetTime: state.dailyLimitResetTime,
      isPaused: state.isPaused,
      pauseReason: state.pauseReason,
      isAutomationEnabled: state.isAutomationEnabled
    };

    try {
      chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: data }, () => {
        if (chrome.runtime.lastError) {
          debugLog('storage.set warning:', chrome.runtime.lastError.message);
        }
      });
    } catch (err) {
      if (isExtensionContextInvalidated()) {
        handleExtensionInvalidated();
      }
    }
  }

  /**
   * Load queue from storage
   */
  async function loadQueue() {
    return new Promise((resolve) => {
      if (state.extensionInvalidated) return resolve();

      try {
        chrome.storage.local.get([CONFIG.STORAGE_KEY], (result) => {
          if (chrome.runtime.lastError) {
            debugLog('storage.get warning:', chrome.runtime.lastError.message);
          }
          
          const data = result?.[CONFIG.STORAGE_KEY] || {};
          
          state.queue = data.queue || [];
          state.dailyLimitResetTime = data.dailyLimitResetTime || null;
          state.isPaused = data.isPaused || false;
          state.pauseReason = data.pauseReason || null;
          state.isAutomationEnabled = data.isAutomationEnabled !== false;

          // Reset any items stuck in 'sending' status
          state.queue.forEach(item => {
            if (item.status === 'sending') {
              item.status = 'queued';
            }
          });

          // Check if daily limit has reset
          if (state.dailyLimitResetTime && Date.now() >= state.dailyLimitResetTime) {
            state.dailyLimitResetTime = null;
            if (state.pauseReason === 'daily_limit') {
              state.isPaused = false;
              state.pauseReason = null;
            }
          }

          saveQueue();
          resolve();
        });
      } catch (err) {
        if (isExtensionContextInvalidated()) {
          handleExtensionInvalidated();
        }
        resolve();
      }
    });
  }

  // ============================================================================
  // POLLING & AUTOMATION
  // ============================================================================

  /**
   * Start polling for active tasks
   */
  function startPolling() {
    if (state.pollIntervalId) return;
    
    // Initial poll
    pollPendingTasks();
    
    // Set up interval
    state.pollIntervalId = setInterval(() => {
      pollPendingTasks();
    }, CONFIG.POLL_INTERVAL_MS);
  }

  /**
   * Stop polling
   */
  function stopPolling() {
    if (state.pollIntervalId) {
      clearInterval(state.pollIntervalId);
      state.pollIntervalId = null;
    }
  }

  /**
   * Poll pending tasks endpoint via background worker
   */
  async function pollPendingTasks() {
    if (state.extensionInvalidated) return;
    if (!state.isController) return; // Only controller polls

    try {
      const result = await sendToBackground('EXECUTE_POLL_PENDING');
      
      if (result.success) {
        state.activeTaskCount = result.activeCount;
        state.lastPollTime = Date.now();
        state.mainWorldReady = true;
        
        debugLog(`Poll: ${result.activeCount}/${CONFIG.MAX_CONCURRENT_TASKS} active`);
        
        updateUI();
        checkAndSubmit();
      } else {
        debugLog('Poll failed:', result.error);
        
        // Check if it's a MAIN world execution issue
        if (result.error?.includes('executeScript') || 
            result.error?.includes('Cannot access')) {
          state.mainWorldReady = false;
          updateUI();
        }
      }
    } catch (error) {
      debugLog('Poll error:', error.message);
    }
  }

  /**
   * Check token status
   */
  async function checkTokenStatus() {
    if (state.extensionInvalidated) return;

    try {
      const result = await sendToBackground('GET_TOKEN_STATUS');
      state.hasValidToken = result.hasToken;
      state.lastTokenCapture = result.capturedAt;
      updateUI();
    } catch (error) {
      debugLog('Token check error:', error.message);
    }
  }

  /**
   * Set manual token
   */
  async function setManualToken(token) {
    if (!token) return;

    try {
      const result = await sendToBackground('SET_MANUAL_TOKEN', { token: token.trim() });
      if (result.success) {
        state.hasValidToken = true;
        state.lastTokenCapture = Date.now();
        showNotification('Manual token set. Queue submissions enabled.', 'success');
        updateUI();
        checkAndSubmit();
      } else {
        showNotification('Failed to set token: ' + (result.error || 'Unknown error'), 'error');
      }
    } catch (error) {
      showNotification('Failed to set token: ' + error.message, 'error');
    }
  }

  /**
   * Clear token
   */
  async function clearToken() {
    try {
      await sendToBackground('CLEAR_TOKEN');
      state.hasValidToken = false;
      state.lastTokenCapture = null;
      showNotification('Token cleared.', 'info');
      updateUI();
    } catch (error) {
      debugLog('Clear token error:', error.message);
    }
  }

  /**
   * Register as controller tab
   */
  async function registerAsController() {
    try {
      const result = await sendToBackground('REGISTER_CONTROLLER');
      state.isController = result.isController;
      debugLog('Controller status:', state.isController);
      return result.isController;
    } catch (error) {
      debugLog('Controller registration error:', error.message);
      // Assume controller if can't communicate
      state.isController = true;
      return true;
    }
  }

  /**
   * Send heartbeat
   */
  async function sendHeartbeat() {
    if (state.extensionInvalidated) return;

    try {
      const result = await sendToBackground('HEARTBEAT');
      if (!result.isController && state.isController) {
        // Lost controller status
        state.isController = false;
        stopPolling();
        debugLog('Lost controller status');
      } else if (result.isController && !state.isController) {
        // Gained controller status
        state.isController = true;
        startPolling();
        debugLog('Gained controller status');
      }
    } catch (error) {
      // Ignore heartbeat errors
    }
  }

  /**
   * Check conditions and submit next queued item if possible
   */
  async function checkAndSubmit() {
    // Guard conditions
    if (!state.isAutomationEnabled) return;
    if (state.isPaused) return;
    if (state.isSubmitting) return;
    if (!state.hasValidToken) return;
    if (!state.isController) return;
    if (state.activeTaskCount >= CONFIG.MAX_CONCURRENT_TASKS) return;
    
    // Check daily limit
    if (state.dailyLimitResetTime && Date.now() < state.dailyLimitResetTime) return;

    // Check cooldown
    if (state.lastSubmitTime && (Date.now() - state.lastSubmitTime) < CONFIG.SUBMIT_COOLDOWN_MS) {
      return;
    }

    // Get next queued item
    const nextItem = state.queue.find(item => item.status === 'queued');
    if (!nextItem) return;

    // Submit
    await submitQueueItem(nextItem);
  }

  /**
   * Submit a single queue item
   */
  async function submitQueueItem(item) {
    state.isSubmitting = true;
    state.lastSubmitTime = Date.now();
    updateItemStatus(item.id, 'sending');

    debugLog('Submitting:', item.id);

    try {
      const result = await sendToBackground('EXECUTE_SUBMIT_PROMPT', {
        prompt: item.prompt,
        options: item.options
      });

      if (result.success) {
        // Success - remove from queue
        removeFromQueue(item.id);
        showNotification(`Submitted: "${truncatePrompt(item.prompt)}"`, 'success');
        
        // Increment active count optimistically
        state.activeTaskCount++;
        updateUI();

        debugLog('Submission successful');

      } else {
        // Handle different error types
        handleSubmitError(item, result);
      }

    } catch (error) {
      debugLog('Submit error:', error.message);
      updateItemStatus(item.id, 'error', error.message);
      
    } finally {
      state.isSubmitting = false;
    }
  }

  /**
   * Handle submission errors
   */
  function handleSubmitError(item, result) {
    debugLog('Submit error:', result.error, result.message);

    switch (result.error) {
      case 'CONCURRENT_LIMIT':
        // Requeue and wait for next poll
        updateItemStatus(item.id, 'queued');
        state.activeTaskCount = CONFIG.MAX_CONCURRENT_TASKS;
        showNotification('At concurrent limit (3). Waiting...', 'warning');
        scheduleBackoffRetry();
        break;

      case 'DAILY_LIMIT':
        // Pause automation - DO NOT retry in a loop
        state.isPaused = true;
        state.pauseReason = 'daily_limit';
        state.dailyLimitResetTime = result.resetTime;
        updateItemStatus(item.id, 'queued'); // Keep in queue for later
        saveQueue();
        
        const resetDuration = result.resetSeconds 
          ? formatDuration(result.resetSeconds * 1000) 
          : 'unknown time';
        showNotification(`Daily limit reached. Resets in ${resetDuration}`, 'error');
        debugLog(`Daily limit - resets in ${result.resetSeconds}s`);
        break;

      case 'NO_TOKEN':
      case 'TOKEN_STALE':
      case 'AUTH_ERROR':
        // Need manual generation to capture token
        state.hasValidToken = false;
        updateItemStatus(item.id, 'error', 'Token needed');
        showNotification('Please generate once manually to capture token.', 'warning');
        break;

      case 'RATE_LIMIT_UNKNOWN':
        // Unknown rate limit - backoff and retry (but not infinitely)
        if (item.retryCount < 3) {
          updateItemStatus(item.id, 'queued');
          scheduleBackoffRetry();
        } else {
          updateItemStatus(item.id, 'error', 'Rate limit (max retries)');
        }
        break;

      default:
        // Other error
        updateItemStatus(item.id, 'error', result.message || 'Unknown error');
        showNotification(`Error: ${result.message || 'Unknown error'}`, 'error');
    }

    updateUI();
  }

  /**
   * Schedule a retry after backoff period
   */
  function scheduleBackoffRetry() {
    const backoff = CONFIG.BACKOFF_BASE_MS + Math.random() * CONFIG.BACKOFF_JITTER_MS;
    debugLog(`Backing off for ${Math.round(backoff / 1000)}s`);
    
    setTimeout(() => {
      if (!state.extensionInvalidated) {
        checkAndSubmit();
      }
    }, backoff);
  }

  // ============================================================================
  // UI CREATION & MANAGEMENT
  // ============================================================================

  /**
   * Create and inject the queue panel UI
   */
  function createUI() {
    // Main container
    const panel = document.createElement('div');
    panel.id = 'sora-queue-panel';
    panel.innerHTML = `
      <div class="sqp-header">
        <div class="sqp-header-left">
          <span class="sqp-title">🎬 Queue</span>
          <span class="sqp-badge" id="sqp-badge">0</span>
        </div>
        <div class="sqp-header-right">
          <button class="sqp-btn sqp-btn-icon" id="sqp-toggle-automation" title="Toggle automation">
            ▶️
          </button>
          <button class="sqp-btn sqp-btn-icon" id="sqp-toggle-debug" title="Toggle debug">
            🐛
          </button>
          <button class="sqp-btn sqp-btn-icon" id="sqp-minimize" title="Minimize">
            ➖
          </button>
        </div>
      </div>
      
      <div class="sqp-status" id="sqp-status">
        <div class="sqp-status-row">
          <span>Active: <strong id="sqp-active-count">?</strong>/3</span>
          <span>Token: <strong id="sqp-token-status">❌</strong></span>
        </div>
        <div class="sqp-status-row">
          <span>MAIN: <strong id="sqp-main-status">?</strong></span>
          <span>Ctrl: <strong id="sqp-controller-status">?</strong></span>
        </div>
      </div>

      <div class="sqp-debug" id="sqp-debug" style="display: none;">
        <div class="sqp-debug-content" id="sqp-debug-content"></div>
      </div>

      <div class="sqp-alert" id="sqp-alert" style="display: none;"></div>

      <div class="sqp-body" id="sqp-body">
        <div class="sqp-queue-list" id="sqp-queue-list">
          <div class="sqp-empty">Queue is empty</div>
        </div>
      </div>

      <div class="sqp-add-form" id="sqp-add-form">
        <textarea id="sqp-prompt-input" placeholder="Enter prompt to queue..." rows="2"></textarea>
        <div class="sqp-form-actions">
          <select id="sqp-orientation" title="Orientation">
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
            <option value="square">Square</option>
          </select>
          <button class="sqp-btn sqp-btn-primary" id="sqp-add-btn">Add to Queue</button>
        </div>
      </div>

      <div class="sqp-footer">
        <button class="sqp-btn sqp-btn-sm" id="sqp-set-token" title="Manually set token">🔑 Set Token</button>
        <button class="sqp-btn sqp-btn-sm" id="sqp-clear-errors">Clear Errors</button>
        <button class="sqp-btn sqp-btn-sm" id="sqp-refresh">🔄</button>
      </div>
    `;

    document.body.appendChild(panel);

    // Cache UI elements
    state.uiElements = {
      panel,
      badge: document.getElementById('sqp-badge'),
      activeCount: document.getElementById('sqp-active-count'),
      tokenStatus: document.getElementById('sqp-token-status'),
      mainStatus: document.getElementById('sqp-main-status'),
      controllerStatus: document.getElementById('sqp-controller-status'),
      alert: document.getElementById('sqp-alert'),
      debug: document.getElementById('sqp-debug'),
      debugContent: document.getElementById('sqp-debug-content'),
      queueList: document.getElementById('sqp-queue-list'),
      promptInput: document.getElementById('sqp-prompt-input'),
      orientationSelect: document.getElementById('sqp-orientation'),
      addBtn: document.getElementById('sqp-add-btn'),
      toggleAutomation: document.getElementById('sqp-toggle-automation'),
      toggleDebug: document.getElementById('sqp-toggle-debug'),
      minimizeBtn: document.getElementById('sqp-minimize'),
      body: document.getElementById('sqp-body'),
      addForm: document.getElementById('sqp-add-form'),
      setTokenBtn: document.getElementById('sqp-set-token'),
      clearErrorsBtn: document.getElementById('sqp-clear-errors'),
      refreshBtn: document.getElementById('sqp-refresh')
    };

    // Bind events
    bindUIEvents();

    // Create floating "Queue" button
    createQueueButton();
  }

  /**
   * Create floating button to queue current prompt
   */
  function createQueueButton() {
    const btn = document.createElement('button');
    btn.id = 'sora-queue-floating-btn';
    btn.innerHTML = '📥 Queue';
    btn.title = 'Add current prompt to queue (Ctrl+Shift+Q)';
    
    btn.addEventListener('click', () => {
      queueCurrentPrompt();
    });

    document.body.appendChild(btn);

    // Keyboard shortcut
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        queueCurrentPrompt();
      }
    });
  }

  /**
   * Queue the prompt currently in Sora's input
   */
  function queueCurrentPrompt() {
    // Try to find Sora's prompt input using multiple selectors
    const selectors = [
      'textarea[placeholder*="Describe"]',
      'textarea[data-testid="prompt-textarea"]',
      'textarea[data-testid="prompt-input"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea.prompt-input',
      'textarea[name="prompt"]'
    ];
    
    let soraInput = null;
    for (const selector of selectors) {
      soraInput = document.querySelector(selector);
      if (soraInput) break;
    }
    
    if (soraInput) {
      const prompt = soraInput.value || soraInput.textContent || soraInput.innerText || '';
      if (prompt.trim()) {
        addToQueue(prompt.trim());
        showNotification('Prompt added to queue!', 'success');
      } else {
        showNotification('Please enter a prompt first', 'warning');
      }
    } else {
      // Fallback - use our input
      showNotification('Could not find Sora prompt. Use the queue panel.', 'info');
      state.uiElements.panel.classList.remove('sqp-minimized');
      state.uiElements.promptInput.focus();
    }
  }

  /**
   * Bind UI event handlers
   */
  function bindUIEvents() {
    const { 
      addBtn, promptInput, toggleAutomation, toggleDebug, minimizeBtn, 
      orientationSelect, setTokenBtn, clearErrorsBtn, refreshBtn 
    } = state.uiElements;

    // Add to queue
    addBtn.addEventListener('click', () => {
      const prompt = promptInput.value.trim();
      if (prompt) {
        addToQueue(prompt, {
          orientation: orientationSelect.value
        });
        promptInput.value = '';
      }
    });

    // Enter to add
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        addBtn.click();
      }
    });

    // Toggle automation
    toggleAutomation.addEventListener('click', () => {
      if (state.isPaused && state.pauseReason === 'daily_limit') {
        // Allow manual resume attempt
        state.isPaused = false;
        state.pauseReason = null;
        saveQueue();
        showNotification('Resuming automation...', 'info');
        checkAndSubmit();
      } else {
        state.isAutomationEnabled = !state.isAutomationEnabled;
        saveQueue();
        if (state.isAutomationEnabled) {
          checkAndSubmit();
        }
      }
      updateUI();
    });

    // Toggle debug
    toggleDebug.addEventListener('click', () => {
      state.debugEnabled = !state.debugEnabled;
      state.uiElements.debug.style.display = state.debugEnabled ? 'block' : 'none';
      updateDebugPanel();
    });

    // Minimize/expand
    minimizeBtn.addEventListener('click', () => {
      state.uiElements.panel.classList.toggle('sqp-minimized');
    });

    // Refresh
    refreshBtn.addEventListener('click', () => {
      pollPendingTasks();
      checkTokenStatus();
    });

    // Set token manually
    setTokenBtn.addEventListener('click', async () => {
      const token = prompt('Paste openai-sentinel-token (from DevTools → Network → backend/nf/create → Request Headers):');
      if (token) {
        await setManualToken(token);
      }
    });

    // Clear errors
    clearErrorsBtn.addEventListener('click', () => {
      state.queue = state.queue.filter(item => item.status !== 'error');
      saveQueue();
      updateUI();
    });
  }

  /**
   * Update UI to reflect current state
   */
  function updateUI() {
    const { 
      badge, activeCount, tokenStatus, mainStatus, controllerStatus,
      alert, queueList, toggleAutomation 
    } = state.uiElements;

    // Badge
    const queuedCount = state.queue.filter(i => i.status === 'queued' || i.status === 'sending').length;
    badge.textContent = queuedCount;
    badge.classList.toggle('sqp-badge-active', queuedCount > 0);

    // Active count
    activeCount.textContent = state.activeTaskCount;
    activeCount.classList.toggle('sqp-limit', state.activeTaskCount >= CONFIG.MAX_CONCURRENT_TASKS);

    // Token status
    tokenStatus.textContent = state.hasValidToken ? '✅' : '❌';
    tokenStatus.title = state.hasValidToken 
      ? `Token captured ${state.lastTokenCapture ? formatTimeAgo(state.lastTokenCapture) : ''}` 
      : 'No token - generate once manually';

    // MAIN world status
    mainStatus.textContent = state.mainWorldReady ? '✅' : '❓';
    mainStatus.title = state.mainWorldReady 
      ? 'MAIN world execution working' 
      : 'MAIN world not yet verified';

    // Controller status
    controllerStatus.textContent = state.isController ? '✅' : '➖';
    controllerStatus.title = state.isController 
      ? 'This tab is the controller' 
      : 'Another tab is controlling';

    // Automation button
    if (state.isPaused) {
      toggleAutomation.textContent = '⏸️';
      toggleAutomation.title = `Paused: ${state.pauseReason || 'manual'}`;
      toggleAutomation.classList.add('sqp-paused');
    } else if (!state.isAutomationEnabled) {
      toggleAutomation.textContent = '⏹️';
      toggleAutomation.title = 'Automation disabled';
      toggleAutomation.classList.remove('sqp-paused');
    } else {
      toggleAutomation.textContent = '▶️';
      toggleAutomation.title = 'Automation running';
      toggleAutomation.classList.remove('sqp-paused');
    }

    // Alert for daily limit
    if (state.isPaused && state.pauseReason === 'daily_limit' && state.dailyLimitResetTime) {
      const remaining = state.dailyLimitResetTime - Date.now();
      if (remaining > 0) {
        alert.style.display = 'block';
        alert.className = 'sqp-alert sqp-alert-error';
        alert.innerHTML = `
          Daily limit reached. Resets in <strong>${formatDuration(remaining)}</strong>
          <button class="sqp-btn sqp-btn-sm" id="sqp-retry-now">Retry Now</button>
        `;
        document.getElementById('sqp-retry-now')?.addEventListener('click', () => {
          state.isPaused = false;
          state.pauseReason = null;
          saveQueue();
          checkAndSubmit();
          updateUI();
        });
      } else {
        // Reset time passed
        state.isPaused = false;
        state.pauseReason = null;
        state.dailyLimitResetTime = null;
        alert.style.display = 'none';
        saveQueue();
        checkAndSubmit();
      }
    } else if (!state.hasValidToken) {
      alert.style.display = 'block';
      alert.className = 'sqp-alert sqp-alert-warning';
      alert.innerHTML = 'No token captured. Generate once manually, or click <strong>🔑 Set Token</strong>.';
    } else if (!state.mainWorldReady) {
      alert.style.display = 'block';
      alert.className = 'sqp-alert sqp-alert-info';
      alert.innerHTML = 'Waiting for MAIN world verification...';
    } else {
      alert.style.display = 'none';
    }

    // Queue list
    renderQueueList();

    // Debug panel
    if (state.debugEnabled) {
      updateDebugPanel();
    }
  }

  /**
   * Update debug panel
   */
  function updateDebugPanel() {
    if (!state.uiElements.debugContent) return;

    const debugInfo = {
      'Automation': state.isAutomationEnabled ? 'ON' : 'OFF',
      'Paused': state.isPaused ? `YES (${state.pauseReason})` : 'NO',
      'Controller': state.isController ? 'YES' : 'NO',
      'Token': state.hasValidToken ? 'YES' : 'NO',
      'MAIN Ready': state.mainWorldReady ? 'YES' : 'NO',
      'Active Tasks': `${state.activeTaskCount}/${CONFIG.MAX_CONCURRENT_TASKS}`,
      'Queue Length': state.queue.length,
      'Last Poll': state.lastPollTime ? formatTimeAgo(state.lastPollTime) : 'never',
      'Last Submit': state.lastSubmitTime ? formatTimeAgo(state.lastSubmitTime) : 'never',
      'Daily Reset': state.dailyLimitResetTime 
        ? new Date(state.dailyLimitResetTime).toLocaleTimeString() 
        : 'N/A'
    };

    state.uiElements.debugContent.innerHTML = Object.entries(debugInfo)
      .map(([k, v]) => `<div><span>${k}:</span> <strong>${v}</strong></div>`)
      .join('');
  }

  /**
   * Render the queue list
   */
  function renderQueueList() {
    const { queueList } = state.uiElements;

    if (state.queue.length === 0) {
      queueList.innerHTML = '<div class="sqp-empty">Queue is empty</div>';
      return;
    }

    queueList.innerHTML = state.queue.map((item, index) => `
      <div class="sqp-queue-item sqp-status-${item.status}" data-id="${item.id}">
        <div class="sqp-item-main">
          <div class="sqp-item-prompt" title="${escapeHtml(item.prompt)}">
            ${escapeHtml(truncatePrompt(item.prompt))}
          </div>
          <div class="sqp-item-meta">
            <span class="sqp-item-status">${getStatusLabel(item.status)}</span>
            ${item.errorMessage ? `<span class="sqp-item-error" title="${escapeHtml(item.errorMessage)}">⚠️</span>` : ''}
            <span class="sqp-item-time">${formatTimeAgo(item.createdAt)}</span>
          </div>
        </div>
        <div class="sqp-item-actions">
          ${index > 0 ? `<button class="sqp-btn sqp-btn-icon sqp-move-up" title="Move up">⬆️</button>` : ''}
          ${index < state.queue.length - 1 ? `<button class="sqp-btn sqp-btn-icon sqp-move-down" title="Move down">⬇️</button>` : ''}
          <button class="sqp-btn sqp-btn-icon sqp-remove" title="Remove">❌</button>
        </div>
      </div>
    `).join('');

    // Bind item actions
    queueList.querySelectorAll('.sqp-queue-item').forEach(itemEl => {
      const id = itemEl.dataset.id;
      
      itemEl.querySelector('.sqp-move-up')?.addEventListener('click', () => moveUp(id));
      itemEl.querySelector('.sqp-move-down')?.addEventListener('click', () => moveDown(id));
      itemEl.querySelector('.sqp-remove')?.addEventListener('click', () => removeFromQueue(id));
    });
  }

  // ============================================================================
  // NOTIFICATION SYSTEM
  // ============================================================================

  function showNotification(message, type = 'info') {
    const existing = document.querySelector('.sqp-notification');
    if (existing) existing.remove();

    const notification = document.createElement('div');
    notification.className = `sqp-notification sqp-notification-${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.classList.add('sqp-notification-show');
    }, 10);

    setTimeout(() => {
      notification.classList.remove('sqp-notification-show');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  function truncatePrompt(prompt) {
    if (prompt.length <= CONFIG.PROMPT_PREVIEW_LENGTH) return prompt;
    return prompt.substring(0, CONFIG.PROMPT_PREVIEW_LENGTH) + '...';
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function getStatusLabel(status) {
    const labels = {
      queued: '⏳ Queued',
      sending: '🚀 Sending...',
      error: '❌ Error',
      submitted: '✅ Submitted'
    };
    return labels[status] || status;
  }

  function formatTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  function formatDuration(ms) {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  async function init() {
    debugLog('Initializing...');

    // Load persisted queue
    await loadQueue();

    // Check token status
    await checkTokenStatus();

    // Register as controller
    await registerAsController();

    // Create UI
    createUI();

    // Update UI with initial state
    updateUI();

    // Start polling if we're controller
    if (state.isController) {
      startPolling();
    }

    // Start heartbeat
    state.heartbeatIntervalId = setInterval(() => {
      sendHeartbeat();
    }, CONFIG.HEARTBEAT_INTERVAL_MS);

    // Periodic daily limit check
    state.dailyLimitIntervalId = setInterval(() => {
      if (state.dailyLimitResetTime && Date.now() >= state.dailyLimitResetTime) {
        state.dailyLimitResetTime = null;
        if (state.pauseReason === 'daily_limit') {
          state.isPaused = false;
          state.pauseReason = null;
          saveQueue();
          showNotification('Daily limit reset! Resuming...', 'success');
          checkAndSubmit();
        }
        updateUI();
      }
    }, 30000);

    debugLog('Initialized with', state.queue.length, 'queued items');
    debugLog('Controller:', state.isController);
    debugLog('Token:', state.hasValidToken);
  }

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
