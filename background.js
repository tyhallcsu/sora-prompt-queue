/**
 * Sora Prompt Queue - Background Service Worker
 * 
 * Responsibilities:
 * 1. Capture openai-sentinel-token from manual submissions via webRequest
 * 2. Store captured headers in chrome.storage.session
 * 3. Inject MAIN-world code for API calls (pending/create)
 * 4. Coordinate between popup and content scripts
 * 5. Handle multi-tab coordination (controller tab selection)
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const STORAGE_KEYS = {
  TOKEN: 'capturedToken',
  DEVICE_ID: 'capturedDeviceId',
  LANGUAGE: 'capturedLanguage',
  TOKEN_CAPTURED_AT: 'tokenCapturedAt',
  QUEUE: 'soraQueue',
  CONTROLLER_TAB: 'controllerTabId',
  CONTROLLER_HEARTBEAT: 'controllerHeartbeat'
};

const DEBUG = true; // Set to false in production

function debugLog(...args) {
  if (DEBUG) {
    console.log('[SoraQueue:BG]', ...args);
  }
}

// ============================================================================
// TOKEN CAPTURE VIA WEBREQUEST
// ============================================================================

/**
 * Listen for POST requests to /backend/nf/create and capture auth headers
 */
chrome.webRequest.onBeforeSendHeaders.addListener(
  async (details) => {
    if (details.method !== 'POST') return;
    
    const headers = details.requestHeaders || [];
    let sentinel = null;
    let deviceId = null;
    let language = null;
    
    for (const header of headers) {
      const name = header.name.toLowerCase();
      if (name === 'openai-sentinel-token') {
        sentinel = header.value;
      } else if (name === 'oai-device-id') {
        deviceId = header.value;
      } else if (name === 'oai-language') {
        language = header.value;
      }
    }
    
    if (sentinel) {
      // SECURITY: Never log the actual token value
      debugLog(`Captured token (length=${sentinel.length})`);
      
      const captureData = {
        [STORAGE_KEYS.TOKEN]: sentinel,
        [STORAGE_KEYS.TOKEN_CAPTURED_AT]: Date.now()
      };
      
      if (deviceId) {
        captureData[STORAGE_KEYS.DEVICE_ID] = deviceId;
        debugLog(`Captured device ID (length=${deviceId.length})`);
      }
      
      if (language) {
        captureData[STORAGE_KEYS.LANGUAGE] = language;
      }
      
      // Store in session storage (clears on browser close)
      try {
        await chrome.storage.session.set(captureData);
        debugLog('Token stored in session storage');
        
        // Notify all Sora tabs about the token capture
        notifyAllSoraTabs({ type: 'TOKEN_CAPTURED', hasToken: true });
      } catch (err) {
        // Fallback to local storage if session not available
        debugLog('Session storage failed, using local:', err.message);
        await chrome.storage.local.set(captureData);
      }
    }
  },
  { urls: ['https://sora.chatgpt.com/backend/nf/create'] },
  ['requestHeaders']
);

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    debugLog('Message handler error:', err.message);
    sendResponse({ success: false, error: err.message });
  });
  return true; // Keep channel open for async response
});

async function handleMessage(message, sender) {
  const { type, payload } = message;
  
  switch (type) {
    case 'GET_TOKEN_STATUS':
      return await getTokenStatus();
      
    case 'GET_CAPTURED_HEADERS':
      return await getCapturedHeaders();
      
    case 'SET_MANUAL_TOKEN':
      return await setManualToken(payload);
      
    case 'CLEAR_TOKEN':
      return await clearToken();
      
    case 'INVALIDATE_TOKEN':
      return await invalidateToken();
      
    case 'EXECUTE_POLL_PENDING':
      return await executePollPending(sender.tab?.id);
      
    case 'EXECUTE_SUBMIT_PROMPT':
      return await executeSubmitPrompt(sender.tab?.id, payload);
      
    case 'REGISTER_CONTROLLER':
      return await registerController(sender.tab?.id);
      
    case 'HEARTBEAT':
      return await handleHeartbeat(sender.tab?.id);
      
    case 'GET_DEBUG_STATE':
      return await getDebugState();
      
    default:
      return { success: false, error: 'Unknown message type' };
  }
}

// ============================================================================
// TOKEN MANAGEMENT
// ============================================================================

async function getTokenStatus() {
  try {
    // Try session storage first
    let result = await chrome.storage.session.get([
      STORAGE_KEYS.TOKEN,
      STORAGE_KEYS.TOKEN_CAPTURED_AT
    ]);
    
    // Fallback to local storage
    if (!result[STORAGE_KEYS.TOKEN]) {
      result = await chrome.storage.local.get([
        STORAGE_KEYS.TOKEN,
        STORAGE_KEYS.TOKEN_CAPTURED_AT
      ]);
    }
    
    const hasToken = !!result[STORAGE_KEYS.TOKEN];
    const capturedAt = result[STORAGE_KEYS.TOKEN_CAPTURED_AT] || null;
    
    return {
      success: true,
      hasToken,
      capturedAt,
      tokenLength: hasToken ? result[STORAGE_KEYS.TOKEN].length : 0
    };
  } catch (err) {
    debugLog('getTokenStatus error:', err.message);
    return { success: false, hasToken: false, error: err.message };
  }
}

async function getCapturedHeaders() {
  try {
    let result = await chrome.storage.session.get([
      STORAGE_KEYS.TOKEN,
      STORAGE_KEYS.DEVICE_ID,
      STORAGE_KEYS.LANGUAGE
    ]);
    
    // Fallback to local
    if (!result[STORAGE_KEYS.TOKEN]) {
      result = await chrome.storage.local.get([
        STORAGE_KEYS.TOKEN,
        STORAGE_KEYS.DEVICE_ID,
        STORAGE_KEYS.LANGUAGE
      ]);
    }
    
    return {
      success: true,
      token: result[STORAGE_KEYS.TOKEN] || null,
      deviceId: result[STORAGE_KEYS.DEVICE_ID] || null,
      language: result[STORAGE_KEYS.LANGUAGE] || 'en-US'
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function setManualToken(payload) {
  const { token, deviceId, language } = payload || {};
  
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return { success: false, error: 'Invalid token' };
  }
  
  const data = {
    [STORAGE_KEYS.TOKEN]: token.trim(),
    [STORAGE_KEYS.TOKEN_CAPTURED_AT]: Date.now()
  };
  
  if (deviceId) data[STORAGE_KEYS.DEVICE_ID] = deviceId;
  if (language) data[STORAGE_KEYS.LANGUAGE] = language;
  
  try {
    await chrome.storage.session.set(data);
  } catch {
    await chrome.storage.local.set(data);
  }
  
  debugLog(`Manual token set (length=${token.trim().length})`);
  notifyAllSoraTabs({ type: 'TOKEN_CAPTURED', hasToken: true, manual: true });
  
  return { success: true, hasToken: true };
}

async function clearToken() {
  try {
    await chrome.storage.session.remove([
      STORAGE_KEYS.TOKEN,
      STORAGE_KEYS.DEVICE_ID,
      STORAGE_KEYS.LANGUAGE,
      STORAGE_KEYS.TOKEN_CAPTURED_AT
    ]);
  } catch {}
  
  try {
    await chrome.storage.local.remove([
      STORAGE_KEYS.TOKEN,
      STORAGE_KEYS.DEVICE_ID,
      STORAGE_KEYS.LANGUAGE,
      STORAGE_KEYS.TOKEN_CAPTURED_AT
    ]);
  } catch {}
  
  debugLog('Token cleared');
  notifyAllSoraTabs({ type: 'TOKEN_CLEARED' });
  
  return { success: true, hasToken: false };
}

async function invalidateToken() {
  // Called when server returns 401/403 - mark token as invalid
  debugLog('Token invalidated due to auth error');
  return await clearToken();
}

// ============================================================================
// MAIN-WORLD SCRIPT EXECUTION
// ============================================================================

/**
 * Execute a function in the MAIN world of the page to make fetch calls
 * with proper cookies/session
 */
async function executeInMainWorld(tabId, func, args = []) {
  if (!tabId) {
    return { success: false, error: 'No tab ID provided' };
  }
  
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func,
      args
    });
    
    if (results && results[0]) {
      return results[0].result;
    }
    return { success: false, error: 'No result from executeScript' };
  } catch (err) {
    debugLog('executeInMainWorld error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Poll pending tasks - executed in MAIN world
 */
async function executePollPending(tabId) {
  const result = await executeInMainWorld(tabId, async function() {
    try {
      const response = await fetch('https://sora.chatgpt.com/backend/nf/pending/v2', {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }
      
      const data = await response.json();
      
      // Validate response is an array
      if (!Array.isArray(data)) {
        return { 
          success: false, 
          error: 'Invalid response format (expected array)',
          rawData: typeof data
        };
      }
      
      // Count active tasks
      const activeStatuses = ['queued', 'processing', 'running'];
      const activeTasks = data.filter(t => 
        t && t.status && activeStatuses.includes(t.status.toLowerCase())
      );
      
      return {
        success: true,
        tasks: data,
        activeCount: activeTasks.length,
        totalCount: data.length
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  
  if (result.success) {
    debugLog(`Poll: ${result.activeCount}/${result.totalCount} active tasks`);
  }
  
  return result;
}

/**
 * Submit a prompt - executed in MAIN world with captured headers
 */
async function executeSubmitPrompt(tabId, payload) {
  const { prompt, options } = payload || {};
  
  if (!prompt) {
    return { success: false, error: 'NO_PROMPT', message: 'No prompt provided' };
  }
  
  // Get captured headers
  const headersResult = await getCapturedHeaders();
  
  if (!headersResult.success || !headersResult.token) {
    return { 
      success: false, 
      error: 'NO_TOKEN', 
      message: 'No token available. Please generate once manually to capture token.' 
    };
  }
  
  const { token, deviceId, language } = headersResult;
  
  debugLog(`Submitting prompt (length=${prompt.length})`);
  
  const result = await executeInMainWorld(tabId, async function(params) {
    const { prompt, options, token, deviceId, language } = params;
    
    // Build request body
    const body = {
      kind: options?.kind || 'video',
      prompt: prompt,
      title: options?.title || null,
      orientation: options?.orientation || 'portrait',
      size: options?.size || 'small',
      n_frames: options?.n_frames || 300,
      inpaint_items: options?.inpaint_items || [],
      remix_target_id: options?.remix_target_id || null,
      metadata: options?.metadata || null,
      cameo_ids: options?.cameo_ids || null,
      cameo_replacements: options?.cameo_replacements || null,
      model: options?.model || 'sy_8',
      style_id: options?.style_id || null,
      audio_caption: options?.audio_caption || null,
      audio_transcript: options?.audio_transcript || null,
      video_caption: options?.video_caption || null,
      storyboard_id: options?.storyboard_id || null
    };
    
    // Build headers
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'openai-sentinel-token': token
    };
    
    if (deviceId) headers['oai-device-id'] = deviceId;
    if (language) headers['oai-language'] = language;
    
    try {
      const response = await fetch('https://sora.chatgpt.com/backend/nf/create', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body)
      });
      
      let responseData = {};
      try {
        responseData = await response.json();
      } catch {}
      
      if (response.ok) {
        return { success: true, status: response.status, data: responseData };
      }
      
      // Handle errors
      return {
        success: false,
        status: response.status,
        data: responseData
      };
    } catch (err) {
      return { success: false, error: 'NETWORK_ERROR', message: err.message };
    }
  }, [{ prompt, options, token, deviceId, language }]);
  
  // Post-process the result to categorize errors
  if (!result.success && result.status === 429) {
    const parsed = parse429Response(result.data);
    debugLog('429 response:', parsed.error, parsed.message);
    return { ...result, ...parsed };
  }
  
  if (!result.success && (result.status === 401 || result.status === 403)) {
    debugLog('Auth error - invalidating token');
    await invalidateToken();
    return { 
      ...result, 
      error: 'AUTH_ERROR', 
      message: 'Authentication failed. Please generate once manually to refresh token.' 
    };
  }
  
  if (result.success) {
    debugLog('Submission successful');
  }
  
  return result;
}

/**
 * Parse 429 response to determine if it's concurrent limit or daily limit
 */
function parse429Response(data) {
  if (!data) {
    return { error: 'RATE_LIMIT_UNKNOWN', message: 'Rate limit reached (unknown type)' };
  }
  
  // Check for daily/credit limit exhausted
  if (data.type === 'rate_limit_exhausted' ||
      (data.rate_limit_and_credit_balance?.rate_limit_reached === true &&
       data.rate_limit_and_credit_balance?.credit_remaining === 0)) {
    
    const resetSeconds = data.rate_limit_and_credit_balance?.access_resets_in_seconds || 0;
    
    debugLog(`Daily limit detected, resets in ${resetSeconds}s`);
    
    return {
      error: 'DAILY_LIMIT',
      message: 'Daily generation limit reached.',
      resetSeconds,
      resetTime: resetSeconds > 0 ? Date.now() + (resetSeconds * 1000) : null,
      creditRemaining: data.rate_limit_and_credit_balance?.credit_remaining || 0
    };
  }
  
  // Check for concurrent task limit - multiple detection methods
  const errorCode = data.error?.code;
  const errorMessage = data.error?.message || '';
  const numTasks = data.error?.details?.num_tasks;
  
  const isConcurrentLimit = 
    errorCode === 'too_many_concurrent_tasks' ||
    numTasks === 3 ||
    /you already have 3 generations? in progress/i.test(errorMessage) ||
    /you can only generate 3 videos? at a time/i.test(errorMessage) ||
    /too many concurrent/i.test(errorMessage) ||
    /maximum.*concurrent.*generations/i.test(errorMessage);
  
  if (isConcurrentLimit) {
    debugLog('Concurrent limit detected');
    return {
      error: 'CONCURRENT_LIMIT',
      message: data.error?.message || 'Maximum concurrent generations reached (3).',
      numTasks: numTasks || 3
    };
  }
  
  // Unknown 429
  return {
    error: 'RATE_LIMIT_UNKNOWN',
    message: data.error?.message || 'Rate limit reached.',
    rawData: data
  };
}

// ============================================================================
// MULTI-TAB COORDINATION
// ============================================================================

async function registerController(tabId) {
  if (!tabId) return { success: false, error: 'No tab ID' };
  
  const now = Date.now();
  
  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.CONTROLLER_TAB,
      STORAGE_KEYS.CONTROLLER_HEARTBEAT
    ]);
    
    const currentController = result[STORAGE_KEYS.CONTROLLER_TAB];
    const lastHeartbeat = result[STORAGE_KEYS.CONTROLLER_HEARTBEAT] || 0;
    
    // If no controller or heartbeat is stale (> 10s), become controller
    if (!currentController || (now - lastHeartbeat) > 10000) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.CONTROLLER_TAB]: tabId,
        [STORAGE_KEYS.CONTROLLER_HEARTBEAT]: now
      });
      debugLog(`Tab ${tabId} is now controller`);
      return { success: true, isController: true };
    }
    
    // Check if current controller tab still exists
    try {
      await chrome.tabs.get(currentController);
      // Tab exists
      if (currentController === tabId) {
        return { success: true, isController: true };
      }
      return { success: true, isController: false, controllerId: currentController };
    } catch {
      // Tab doesn't exist, become controller
      await chrome.storage.local.set({
        [STORAGE_KEYS.CONTROLLER_TAB]: tabId,
        [STORAGE_KEYS.CONTROLLER_HEARTBEAT]: now
      });
      debugLog(`Tab ${tabId} is now controller (previous tab closed)`);
      return { success: true, isController: true };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleHeartbeat(tabId) {
  if (!tabId) return { success: false };
  
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.CONTROLLER_TAB]);
    
    if (result[STORAGE_KEYS.CONTROLLER_TAB] === tabId) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.CONTROLLER_HEARTBEAT]: Date.now()
      });
      return { success: true, isController: true };
    }
    
    return { success: true, isController: false };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

async function notifyAllSoraTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://sora.chatgpt.com/*' });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        // Tab might not have content script loaded
      }
    }
  } catch (err) {
    debugLog('notifyAllSoraTabs error:', err.message);
  }
}

async function getDebugState() {
  const tokenStatus = await getTokenStatus();
  
  let controllerInfo = {};
  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.CONTROLLER_TAB,
      STORAGE_KEYS.CONTROLLER_HEARTBEAT
    ]);
    controllerInfo = {
      controllerId: result[STORAGE_KEYS.CONTROLLER_TAB],
      lastHeartbeat: result[STORAGE_KEYS.CONTROLLER_HEARTBEAT]
    };
  } catch {}
  
  return {
    success: true,
    tokenStatus,
    controllerInfo,
    timestamp: Date.now()
  };
}

// ============================================================================
// LIFECYCLE
// ============================================================================

chrome.runtime.onInstalled.addListener(() => {
  debugLog('Extension installed/updated');
});

chrome.runtime.onStartup.addListener(() => {
  debugLog('Browser started');
});

// Clean up controller on tab close
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.CONTROLLER_TAB]);
    if (result[STORAGE_KEYS.CONTROLLER_TAB] === tabId) {
      await chrome.storage.local.remove([
        STORAGE_KEYS.CONTROLLER_TAB,
        STORAGE_KEYS.CONTROLLER_HEARTBEAT
      ]);
      debugLog(`Controller tab ${tabId} closed`);
    }
  } catch {}
});

debugLog('Service worker initialized');
