/**
 * PayMore Lite Chrome Extension Background Service Worker
 * Migrated to WXT background entrypoint.
 */
// @ts-nocheck
/* eslint-disable @typescript-eslint/no-explicit-any */
/* global chrome */
import { defineBackground } from "wxt/utils/define-background";

export default defineBackground({
  main() {
    /**
     * @fileoverview PayMore Lite Chrome Extension Background Service Worker
     * @description Manages extension lifecycle, message handling, and core functionality
     * @version 1.0.0
     * @author PayMore Team
     * @license MIT
     *
     * This lite service worker handles:
     * - Extension installation and startup
     * - Message routing between content scripts and popup
     * - Side panel state management for controller testing
     * - Basic storage configuration
     * - Tab communication and injection
     * - Controller detection and testing
     */

    // Paymore extension background service worker (MV3) with verbose debug logging

    /** @type {boolean} Debug mode flag for console logging */
    let DEBUG = true;

    /**
     * @type {Map<number, {open: boolean, tool: string}>}
     * Track side panel state per tab for toggle/switch functionality
     */
    const SIDE_PANEL_STATE = new Map(); // tabId -> { open: boolean, tool: string }

    // Track controller connection state
    let CONTROLLER_CONNECTED = false;
    let CONTROLLER_CHECK_INTERVAL = null;
    let LAST_CONTROLLER_COUNT = 0;

    const STORAGE_STATS_KEY = "grokStorageStats";
    const DEFAULT_STORAGE_STATS = {
      indexedPages: 0,
      totalDocuments: 0,
      totalTabs: 0,
      indexSize: 0,
      isInitialized: false,
    };
    const DEFAULT_ACTION_POPUP = "popup.html";
    const OPTIONS_ACTION_POPUP = "options.html";

    async function openOptionsAsActionPopup() {
      const manifest = chrome.runtime?.getManifest?.();
      const restoredPopup =
        (manifest?.action && manifest.action.default_popup) ||
        DEFAULT_ACTION_POPUP;

      try {
        await chrome.action.setPopup({ popup: OPTIONS_ACTION_POPUP });
        await chrome.action.openPopup();
        return true;
      } catch (error) {
        log("Failed to open options popup via action", error);
        return false;
      } finally {
        try {
          await chrome.action.setPopup({ popup: restoredPopup });
        } catch (restoreError) {
          log("Failed to restore default action popup", restoreError);
        }
      }
    }

    /**
     * Logs debug messages when DEBUG mode is enabled
     * @param {...any} args - Arguments to log
     */
    function log(...args) {
      if (DEBUG) console.log("[Paymore SW]", ...args);
    }

    log("Service worker booted", { time: new Date().toISOString() });

    // Track previous active tab for CMDK "return to previous tab" feature
    let previousActiveTabId = null;
    let lastActiveTabId = null;
    let currentActiveTabId = null;

    try {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const active = tabs && tabs[0];
        if (active?.id) {
          lastActiveTabId = active.id;
          currentActiveTabId = active.id;
        }
      });
    } catch (_) {}

    chrome.tabs.onActivated.addListener(({ tabId }) => {
      try {
        if (lastActiveTabId && lastActiveTabId !== tabId) {
          previousActiveTabId = lastActiveTabId;
        }
        lastActiveTabId = tabId;
        currentActiveTabId = tabId;
      } catch (_) {}
    });
    // Clean up tracking if tabs are closed
    try {
      chrome.tabs.onRemoved.addListener((closedTabId) => {
        if (previousActiveTabId === closedTabId) previousActiveTabId = null;
        if (lastActiveTabId === closedTabId) lastActiveTabId = null;
        if (currentActiveTabId === closedTabId) {
          currentActiveTabId = null;
          try {
            chrome.tabs.query(
              { active: true, lastFocusedWindow: true },
              (tabs) => {
                const active = tabs && tabs[0];
                if (active?.id) currentActiveTabId = active.id;
              }
            );
          } catch (_) {}
        }
      });
    } catch (_) {}

    // Listen for keyboard commands
    chrome.commands.onCommand.addListener((command) => {
      if (command === "open-options") {
        log("Open options command triggered");
        openOptionsAsActionPopup().catch((error) =>
          log("openOptions command handler error", error)
        );
      } else if (command === "_execute_action") {
        log("Command popup shortcut triggered");
        // Open the action popup which will show the CMDK palette
        chrome.action.openPopup(() => {
          const err = chrome.runtime.lastError;
          if (err) log("openPopup error", err.message);
        });
      } else if (command === "open-voice") {
        log("Voice popup shortcut triggered");
        try {
          chrome.windows.create({
            url: chrome.runtime.getURL("voice.html"),
            type: "popup",
            width: 420,
            height: 560,
            focused: true,
          });
        } catch (e) {
          log("open-voice open error", e?.message || e);
        }
      } else if (command === "open-controller-testing") {
        log("Controller testing shortcut triggered");
        // Open the controller testing sidepanel
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const active = tabs && tabs[0];
          if (active?.id) {
            toggleSidePanelForTab(active.id, "controller-testing");
          } else {
            log("open-controller-testing: no active tab id");
          }
        });
      }
    });

    // Create a context menu item for searching selected text on eBay (sold listings)
    try {
      const EBAY_SOLD_BASE =
        "https://www.ebay.com/sch/i.html?_nkw=iphone+15&_sacat=0&_from=R40&_dmd=2&rt=nc&LH_Sold=1&LH_Complete=1";

      // Ensure no stale items
      try {
        chrome.contextMenus.removeAll(() => {});
      } catch (_) {}

      try {
        chrome.contextMenus.create({
          id: "pm-search-ebay-sold",
          title: 'Search eBay sold listings for "%s"',
          contexts: ["selection"],
        });
      } catch (e) {
        log("contextMenus.create error", e?.message || e);
      }

      chrome.contextMenus.onClicked.addListener((info, _tab) => {
        const selection = (info.selectionText || "").trim();
        if (!selection) return;

        if (info.menuItemId === "pm-search-ebay-sold") {
          try {
            const u = new URL(EBAY_SOLD_BASE);
            u.searchParams.set("_nkw", selection);
            chrome.tabs.create({ url: u.href });
          } catch (err) {
            // Fallback: naive replacement + encode
            try {
              const q = encodeURIComponent(selection);
              const url = EBAY_SOLD_BASE.replace(/_nkw=[^&]*/, `_nkw=${q}`);
              chrome.tabs.create({ url });
            } catch (_) {
              log("Failed to open eBay search for selection", selection);
            }
          }
          return;
        }

        // only eBay handler kept
      });
    } catch (_) {}

    // Provide a fetch fallback for content scripts that cannot fetch extension
    // resources directly due to page restrictions. Content scripts can request
    // `fetchResource` and the service worker will return the resource text.
    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.action === "fetchResource" && message?.url) {
          const url = chrome.runtime.getURL(message.url);
          fetch(url)
            .then((r) => {
              if (!r.ok)
                throw new Error("HTTP " + r.status + " " + r.statusText);
              return r.text();
            })
            .then((text) => sendResponse({ ok: true, html: text }))
            .catch((err) => sendResponse({ ok: false, error: String(err) }));
          return true; // keep channel open for async response
        }
      });
    } catch (_) {}

    /**
     * Handles extension installation and initial setup
     * Sets default storage values and configuration
     */
    chrome.runtime.onInstalled.addListener((details) => {
      log("onInstalled", details);
      chrome.storage.local.set({
        isEnabled: true,
        autoShowModal: true,
        vibrationEnabled: true,
        debugLogs: true,
      });
    });

    /**
     * Handles extension startup and initializes controller detection
     * Loads debug configuration and starts controller functionality
     */
    chrome.runtime.onStartup?.addListener(() => {
      log("onStartup");
      chrome.storage.local.get({ debugLogs: true }, (cfg) => {
        DEBUG = !!cfg.debugLogs;
        log("Debug flag loaded", DEBUG);
      });
      // Start controller detection
      startControllerDetection();
    });

    /**
     * Handles extension context invalidation and recovery
     * Sends heartbeat messages to content scripts to check if they're still valid
     */
    chrome.runtime.onSuspend?.addListener(() => {
      log("Extension suspended, cleaning up resources");
    });

    // Add message handler for extension health checks
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === "EXTENSION_HEALTH_CHECK") {
        log("Extension health check received from tab:", sender.tab?.id);
        sendResponse({ status: "healthy", timestamp: Date.now() });
        return true;
      }

      // Relay incoming transcripts to active tab (content script)
      if (message?.action === "pm-voice-transcript") {
        try {
          sendToActiveTab({
            action: "pm-voice-transcript",
            interim: !!message.interim,
            text: String(message.text || ""),
            timestampMs: Date.now(),
          });
        } catch (_) {}
        sendResponse({ ok: true });
        return true;
      }

      if (message.type === "CONTENT_SCRIPT_READY") {
        log("Content script ready notification from tab:", sender.tab?.id);
        sendResponse({ status: "acknowledged" });
        return true;
      }
    });

    /**
     * Sends a message to the currently active tab
     * Creates a new tab if no injectable tab is available
     * @param {Object} message - Message to send to the tab
     */
    function sendToActiveTab(message) {
      log("sendToActiveTab", message);
      chrome.tabs.query({ lastFocusedWindow: true }, (tabs) => {
        const isInjectable = (u = "") => /^(https?:|file:|ftp:)/.test(u);
        const active = tabs.find((t) => t.active);
        let target =
          active && isInjectable(active.url)
            ? active
            : tabs.find((t) => isInjectable(t.url));

        if (!target) {
          log("No injectable tab in currentWindow; creating a new one");
          chrome.tabs.create({ url: "https://example.com" }, (newTab) => {
            chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
              if (tabId === newTab.id && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                deliverToTab(newTab.id, message);
              }
            });
          });
          return;
        }

        // Allow localhost/127.0.0.1 during development

        deliverToTab(target.id, message);
      });
    }

    /**
     * Returns content script declarations from the manifest so hashed bundles can be executed.
     * @returns {chrome.runtime.ManifestV3['content_scripts']} Manifest content scripts array.
     */
    function getManifestContentScripts() {
      try {
        return chrome.runtime.getManifest()?.content_scripts || [];
      } catch (_) {
        return [];
      }
    }

    /**
     * Ensures content scripts declared in the manifest are injected.
     * @param {number} tabId - Target tab ID
     */
    function injectManifestContentScripts(tabId) {
      const entries = getManifestContentScripts();
      entries.forEach((entry) => {
        const target = { tabId, allFrames: Boolean(entry.all_frames) };
        (entry.css || []).forEach((file) => {
          try {
            chrome.scripting.insertCSS({ target, files: [file] });
          } catch (_) {}
        });
        (entry.js || []).forEach((file) => {
          try {
            chrome.scripting.executeScript({ target, files: [file] });
          } catch (_) {}
        });
      });
    }

    /**
     * Delivers a message to a specific tab with retry logic
     * Handles content script injection if needed
     * @param {number} tabId - Target tab ID
     * @param {Object} message - Message to deliver
     */
    function deliverToTab(tabId, message) {
      const trySend = (attempt) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            log(`send attempt ${attempt} failed`, lastErr.message);
            if (attempt === 1) {
              // Try explicit injection then retry once
              log("injecting content script via scripting API");
              injectManifestContentScripts(tabId);
              setTimeout(() => trySend(2), 500);
            } else if (attempt === 2) {
              // Final fallback: postMessage into page
              log("final fallback: postMessage showControllerModal");
              chrome.scripting.executeScript({
                target: { tabId, allFrames: true },
                func: () =>
                  window.postMessage(
                    { source: "paymore", action: "showControllerModal" },
                    "*"
                  ),
              });
            }
          } else {
            log("Message delivered; response=", response);
          }
        });
      };
      trySend(1);
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      log("onMessage", {
        message,
        sender: { id: sender?.tab?.id, url: sender?.tab?.url },
      });

      switch (message.action) {
        case "csReady":
          log("content script ready", message?.url);
          sendResponse({ ok: true });
          break;
        case "openInActionPopup": {
          const tool = message?.tool;
          if (!tool) {
            sendResponse({ success: false, error: "missing_tool" });
            break;
          }
          openInActionPopup(tool);
          sendResponse({ success: true });
          break;
        }
        case "openInSidebar": {
          const tool = message?.tool;
          if (!tool) {
            sendResponse({ success: false, error: "missing_tool" });
            break;
          }
          toggleSidePanelForTab(sender?.tab?.id, tool);
          sendResponse({ success: true });
          break;
        }
        case "openToolbarCustomization": {
          const intentKey = "popupIntent";
          const intentValue = "toolbar-customization";
          let notifyQueued = false;
          const notifyPopup = () => {
            if (notifyQueued) return;
            notifyQueued = true;
            setTimeout(() => {
              try {
                chrome.runtime.sendMessage({
                  action: "toolbarCustomizationIntent",
                });
              } catch (e) {
                log("openToolbarCustomization notify error", e?.message || e);
              }
            }, 100);
          };

          chrome.storage.local.set({ [intentKey]: intentValue });
          // Try to open the action popup; if that fails (no user gesture or other
          // restriction), fall back to opening the popup page as a normal window.
          try {
            chrome.action.openPopup(() => {
              const err = chrome.runtime.lastError;
              if (err) {
                log("openPopup error", err.message);
                try {
                  chrome.windows.create({
                    url: chrome.runtime.getURL("popup.html"),
                    type: "popup",
                    width: 480,
                    height: 640,
                    focused: true,
                  });
                } catch (_) {}
              }
              notifyPopup();
            });
          } catch (e) {
            log("openToolbarCustomization openPopup threw", e?.message || e);
            try {
              chrome.windows.create({
                url: chrome.runtime.getURL("popup.html"),
                type: "popup",
                width: 480,
                height: 640,
                focused: true,
              });
            } catch (_) {}
            notifyPopup();
          }
          sendResponse({ success: true });
          break;
        }
        case "closeSidebar": {
          const tabId = sender?.tab?.id;
          if (tabId) {
            try {
              chrome.sidePanel.close({ tabId });
              SIDE_PANEL_STATE.set(tabId, { open: false, tool: null });
              log(`Sidepanel closed for tab: ${tabId}`);
            } catch (e) {
              log("sidePanel close error", e?.message || e);
            }
          }
          sendResponse({ success: true });
          break;
        }
        case "openToolWindow": {
          const tool = message?.tool;
          if (!tool) {
            sendResponse({ success: false, error: "missing_tool" });
            break;
          }
          // Open near toolbar by default (right-middle of primary work area)
          try {
            chrome.system.display.getInfo((displays) => {
              const d = (displays && displays[0] && displays[0].workArea) || {
                left: 0,
                top: 0,
                width: 1280,
                height: 800,
              };
              const anchor = {
                x: d.left + d.width - 72,
                y: d.top + Math.floor(d.height / 2),
              };
              openToolNear(tool, anchor, 0.4);
            });
          } catch (_) {
            openToolNear(tool, { x: 1200, y: 600 }, 0.4);
          }
          sendResponse({ success: true });
          break;
        }
        case "openToolWindowAt": {
          const tool = message?.tool;
          const anchor = message?.anchor || {};
          if (!tool) {
            sendResponse({ success: false, error: "missing_tool" });
            break;
          }
          openToolNear(tool, anchor, 0.4);
          sendResponse({ success: true });
          break;
        }
        case "resizeToolForTab": {
          const width = Number(message?.width || 0);
          const height = Number(message?.height || 0);
          resizeFocusedPopup(width || null, height || null);
          sendResponse({ success: true });
          break;
        }
        case "getControllerStatus":
          // Hook for future background gamepad monitoring
          sendResponse({ connected: false, name: null });
          break;
        case "triggerControllerTest":
          openControllerTest();
          sendResponse({ success: true });
          break;
        case "checkControllerStatus":
          // Check current controller status
          checkForControllers();
          sendResponse({ success: true, connected: CONTROLLER_CONNECTED });
          break;
        case "enableControllerDetection":
          startControllerDetection();
          sendResponse({ success: true });
          break;
        case "disableControllerDetection":
          stopControllerDetection();
          sendResponse({ success: true });
          break;
        case "openUrl": {
          const url = message?.url;
          if (!url) {
            sendResponse({ success: false, error: "missing_url" });
            break;
          }
          chrome.tabs.create({ url }, (tab) => {
            sendResponse({ success: true, tabId: tab?.id });
          });
          return true;
        }
        case "OPEN_OPTIONS": {
          openOptionsAsActionPopup()
            .then((opened) => {
              sendResponse({ success: opened });
            })
            .catch((error) => {
              log("OPEN_OPTIONS handler error", error);
              sendResponse({ success: false, error: String(error) });
            });
          return true;
        }
        case "hideControllerModal":
          sendToActiveTab({ action: "hideControllerModal" });
          sendResponse({ success: true });
          break;
        case "GET_WEBPAGE_CONTEXT":
          // Get webpage context from the active tab
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length > 0) {
              const activeTab = tabs[0];
              // Send message to content script to get webpage data
              chrome.tabs.sendMessage(
                activeTab.id,
                { action: "GET_WEBPAGE_CONTEXT" },
                (response) => {
                  if (chrome.runtime.lastError) {
                    log(
                      "Error getting webpage context:",
                      chrome.runtime.lastError
                    );
                    sendResponse({
                      success: false,
                      error: "Failed to get webpage context",
                    });
                  } else if (response && response.success) {
                    sendResponse({ success: true, data: response.data });
                  } else {
                    sendResponse({
                      success: false,
                      error: "No webpage context available",
                    });
                  }
                }
              );
            } else {
              sendResponse({ success: false, error: "No active tab found" });
            }
          });
          return true; // Keep message channel open for async response
        case "getActiveTab":
          // Get the currently active tab
          log("getActiveTab requested");
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length > 0) {
              log("getActiveTab: found tab", tabs[0]);
              sendResponse({ tab: tabs[0] });
            } else {
              log("getActiveTab: no tabs found");
              sendResponse({ error: "No active tab found" });
            }
          });
          return true; // Keep message channel open for async response
        case "GET_TABS":
          // Get all tabs for CMDK palette
          chrome.tabs.query({}, (tabs) => {
            const tabInfo = tabs.map((tab) => ({
              id: tab.id,
              title: tab.title,
              url: tab.url,
              favIconUrl: tab.favIconUrl,
              active: tab.active,
              windowId: tab.windowId,
            }));
            sendResponse({ tabs: tabInfo });
          });
          return true; // Keep message channel open for async response
        case "SWITCH_TAB":
          // Switch to a specific tab
          const tabId = message.tabId;
          if (tabId) {
            chrome.tabs.update(tabId, { active: true }, (tab) => {
              if (tab) {
                chrome.windows.update(tab.windowId, { focused: true });
              }
              sendResponse({ success: true });
            });
          } else {
            sendResponse({ success: false, error: "No tabId provided" });
          }
          return true;
        case "GET_PREVIOUS_TAB":
          // Get the previous active tab ID
          sendResponse({ tabId: previousActiveTabId });
          break;
        case "OPEN_TAB":
          // Open a new tab with the given URL
          const newTabUrl = message.url;
          if (newTabUrl) {
            chrome.tabs.create({ url: newTabUrl }, (tab) => {
              sendResponse({ success: true, tabId: tab?.id });
            });
          } else {
            sendResponse({ success: false, error: "No URL provided" });
          }
          return true;
        case "FETCH_CSV_LINKS":
          // Fetch CSV data (bypasses CORS in content scripts)
          const csvUrl = message.url;
          if (csvUrl) {
            fetch(csvUrl)
              .then((response) => response.text())
              .then((data) => {
                sendResponse({ success: true, data });
              })
              .catch((error) => {
                log("CSV fetch error:", error);
                sendResponse({ success: false, error: error.message });
              });
          } else {
            sendResponse({ success: false, error: "No URL provided" });
          }
          return true; // Keep channel open for async response
        case "toggleDebug":
          DEBUG = !!message.value;
          chrome.storage.local.set({ debugLogs: DEBUG });
          log("DEBUG toggled", DEBUG);
          sendResponse({ success: true, debug: DEBUG });
          break;
        case "generateQr": {
          // Generate QR in SW to bypass page CSP (return as data URL)
          const text = message?.text || "";
          const size = Number(message?.size || 256);
          if (!text) {
            sendResponse({ success: false, error: "missing_text" });
            break;
          }
          const endpoint = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(
            text
          )}`;
          fetch(endpoint)
            .then(async (r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const buf = await r.arrayBuffer();
              const base64 = arrayBufferToBase64(buf);
              const dataUrl = `data:image/png;base64,${base64}`;
              sendResponse({ success: true, dataUrl });
            })
            .catch((err) => {
              log("generateQr error", err?.message || err);
              sendResponse({
                success: false,
                error: String(err?.message || err),
              });
            });
          return true;
        }
        case "ping":
          log("pong");
          sendResponse({ pong: true, time: Date.now() });
          break;
        case "openFloatingToolbar":
          openFloatingToolbar();
          sendResponse({ success: true });
          break;
        case "toggleSidepanelTool": {
          const tool = message?.tool || "controller-testing";
          toggleSidePanelForTab(sender?.tab?.id, tool);
          sendResponse({ success: true });
          break;
        }
        case "goBackToPOS":
          goBackToPOS();
          sendResponse({ success: true });
          break;
        case "checkSiteStatus": {
          const domain = message?.domain;
          if (!domain) {
            sendResponse({ success: false, error: "missing_domain" });
            break;
          }

          chrome.storage.local.get(
            { disabledSites: [], globalEnabled: true },
            (cfg) => {
              const isDisabled =
                !cfg.globalEnabled ||
                cfg.disabledSites.some((site) => {
                  // Simple domain matching (can be enhanced with wildcard support)
                  return domain === site || domain.endsWith("." + site);
                });

              sendResponse({
                success: true,
                disabled: isDisabled,
                globalEnabled: cfg.globalEnabled,
                disabledSites: cfg.disabledSites,
              });
            }
          );
          return true; // Keep message channel open for async response
        }
        case "updateDisabledSites": {
          const sites = message?.sites;
          if (!Array.isArray(sites)) {
            sendResponse({ success: false, error: "invalid_sites_array" });
            break;
          }

          chrome.storage.local.set({ disabledSites: sites }, () => {
            // Broadcast settings change to all tabs
            chrome.tabs.query({}, (tabs) => {
              tabs.forEach((t) => {
                try {
                  chrome.tabs.sendMessage(t.id, {
                    action: "pm-settings-changed",
                    disabledSites: sites,
                  });
                } catch (_) {}
              });
            });

            sendResponse({ success: true });
          });
          return true; // Keep message channel open for async response
        }
        case "toggleCurrentSite": {
          const enabled = message?.enabled;
          const domain = message?.domain;

          if (typeof enabled !== "boolean" || !domain) {
            sendResponse({ success: false, error: "invalid_parameters" });
            break;
          }

          chrome.storage.local.get({ disabledSites: [] }, (cfg) => {
            let updatedSites;

            if (enabled) {
              // Remove domain from disabled list
              updatedSites = cfg.disabledSites.filter(
                (site) => site !== domain
              );
            } else {
              // Add domain to disabled list
              updatedSites = [...cfg.disabledSites, domain];
            }

            chrome.storage.local.set({ disabledSites: updatedSites }, () => {
              // Broadcast settings change to all tabs
              chrome.tabs.query({}, (tabs) => {
                tabs.forEach((t) => {
                  try {
                    chrome.tabs.sendMessage(t.id, {
                      action: "pm-settings-changed",
                      disabledSites: updatedSites,
                    });
                  } catch (_) {}
                });
              });

              sendResponse({ success: true, disabledSites: updatedSites });
            });
          });
          return true; // Keep message channel open for async response
        }
        default:
          log("Unknown action", message?.action);
          sendResponse({ ok: false, error: "unknown_action" });
      }
      return true; // keep the message channel open if needed
    });

    function openControllerTest() {
      log("Opening Controller Test");
      // Use sidebar instead of action popup
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const active = tabs && tabs[0];
        if (active?.id) {
          toggleSidePanelForTab(active.id, "controller-testing");
        } else {
          log("openControllerTest: no active tab id");
        }
      });
    }

    function openFloatingToolbar() {
      log("Opening Floating Toolbar");
      openInActionPopup("floating-toolbar");
    }

    function goBackToPOS() {
      log("Going back to POS tab");

      // Find the last tab with pos.paymore.tech URL
      chrome.tabs.query({}, (tabs) => {
        const posTabs = tabs.filter(
          (tab) => tab.url && tab.url.includes("pos.paymore.tech")
        );

        if (posTabs.length > 0) {
          // Sort by last accessed time (most recent first)
          const sortedTabs = posTabs.sort((a, b) => {
            const aTime = a.lastAccessed || 0;
            const bTime = b.lastAccessed || 0;
            return bTime - aTime;
          });

          const targetTab = sortedTabs[0];
          log("Found POS tab:", targetTab.id, targetTab.url);

          // Activate and focus the POS tab
          chrome.tabs.update(targetTab.id, { active: true });
          chrome.windows.update(targetTab.windowId, { focused: true });

          // Close the current toolbar tab
          chrome.tabs.query(
            { active: true, currentWindow: true },
            (activeTabs) => {
              if (activeTabs.length > 0) {
                chrome.tabs.remove(activeTabs[0].id);
              }
            }
          );
        } else {
          log("No POS tabs found, opening new one");
          // If no POS tab exists, open a new one
          chrome.tabs.create({
            url: "https://pos.paymore.tech",
            active: true,
          });
        }
      });
    }

    function toggleSidePanelForTab(tabId, tool) {
      const desiredTool = tool || "controller-testing";

      const asValidTabId = (value) => {
        if (typeof value === "number" && Number.isInteger(value) && value >= 0)
          return value;
        if (typeof value === "string") {
          const parsed = Number(value);
          if (Number.isInteger(parsed) && parsed >= 0) return parsed;
        }
        return null;
      };

      try {
        const openForTab = (id) => {
          const prev = SIDE_PANEL_STATE.get(id) || { open: false, tool: null };

          if (prev.open && prev.tool === desiredTool) {
            try {
              chrome.sidePanel.close({ tabId: id });
              SIDE_PANEL_STATE.set(id, { open: false, tool: null });
              log(`Sidepanel closed for tool: ${desiredTool}`);
            } catch (closeErr) {
              log("sidePanel close error", closeErr?.message || closeErr);
            }
            return;
          }

          try {
            chrome.storage.local.set({
              sidePanelTool: desiredTool,
              sidePanelUrl: null,
            });
          } catch (storageErr) {
            log(
              "Failed to set chrome storage for tool:",
              storageErr?.message || storageErr
            );
          }

          try {
            const setPromise = chrome.sidePanel.setOptions({
              tabId: id,
              enabled: true,
              path: "sidepanel.html",
            });
            if (typeof setPromise?.catch === "function") {
              setPromise.catch((setErr) =>
                log("sidePanel setOptions error", setErr?.message || setErr)
              );
            }
          } catch (setErr) {
            log("sidePanel setOptions error", setErr?.message || setErr);
          }

          try {
            chrome.sidePanel.open({ tabId: id }, () => {
              const err = chrome.runtime.lastError;
              if (err) {
                log("sidePanel open lastError", err.message);
              } else {
                SIDE_PANEL_STATE.set(id, { open: true, tool: desiredTool });
                log(`Sidepanel opened for tool: ${desiredTool} on tab: ${id}`);
              }
            });
          } catch (openErr) {
            log("sidePanel open error", openErr?.message || openErr);
          }
        };

        const resolvedTabId =
          asValidTabId(tabId) ??
          asValidTabId(currentActiveTabId) ??
          asValidTabId(lastActiveTabId);

        if (resolvedTabId !== null) {
          openForTab(resolvedTabId);
          return;
        }

        log(
          "toggleSidePanelForTab: could not resolve tab id immediately; querying"
        );
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const active = tabs && tabs[0];
          const fallbackId = asValidTabId(active?.id);
          if (fallbackId !== null) {
            openForTab(fallbackId);
          } else {
            log(
              "toggleSidePanelForTab: unable to resolve active tab id for sidepanel"
            );
          }
        });
      } catch (e) {
        log("toggleSidePanelForTab error", e?.message || e);
      }
    }

    function arrayBufferToBase64(buffer) {
      let binary = "";
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      // btoa works with binary strings
      return btoa(binary);
    }

    function toolToPath(tool) {
      switch (tool) {
        case "controller-testing":
          return "/tools/controller-testing";
        case "price-charting":
          return "/tools/price-charting";
        case "upc-search":
          return "/tools/upc-search";
        case "scout":
          return "/tools/scout";
        case "settings":
          return "/tools/settings";
        case "floating-toolbar":
          return "/tools/floating-toolbar";
        case "help":
          return "/tools/help";
        case "min-reqs":
          return "/tools/min-reqs";
        case "shopify-search":
          return "/tools/shopify/search";
        case "shopify-storefront":
          return "/tools/shopify/storefront";
        case "ebay":
          return "/tools/ebay";
        case "links":
          return "/tools/links";

        case "paymore":
          return "/tools/paymore";
        default:
          return "/";
      }
    }

    function openInActionPopup(tool) {
      chrome.storage.local.get(
        {
          toolsPassword: "",
        },
        (cfg) => {
          const baseUrl = "https://paymore-extension.vercel.app";
          const path = toolToPath(tool);
          let url = `${baseUrl}${path}`;

          // Add password to all tool URLs if configured
          if (cfg?.toolsPassword) {
            try {
              const u = new URL(url);
              u.searchParams.set("password", cfg.toolsPassword);
              url = u.href;
            } catch (_) {
              url = `${url}${
                url.includes("?") ? "&" : "?"
              }password=${encodeURIComponent(cfg.toolsPassword)}`;
            }
          }

          // Size Next.js help tool nicely inside the action popup
          if (tool === "help") {
            try {
              const u = new URL(url);
              u.searchParams.set("pm_w", "460");
              u.searchParams.set("pm_h", "560");
              url = u.href;
            } catch (_) {
              url = `${url}${url.includes("?") ? "&" : "?"}pm_w=460&pm_h=560`;
            }
          }
          // If pm_window=1 is present, open as chromeless popup window with optional sizing/position
          try {
            const u = new URL(url);
            const windowMode = u.searchParams.get("pm_window") === "1";
            if (windowMode) {
              const wp = parseFloat(u.searchParams.get("pm_wp") || "0") || null;
              const hp = parseFloat(u.searchParams.get("pm_hp") || "0") || null;
              const margin =
                parseInt(u.searchParams.get("pm_margin") || "0", 10) || 0;
              const wFixed =
                parseInt(u.searchParams.get("pm_w") || "0", 10) || null;
              const hFixed =
                parseInt(u.searchParams.get("pm_h") || "0", 10) || null;
              const leftParam = parseInt(
                u.searchParams.get("pm_left") || "",
                10
              );
              const topParam = parseInt(u.searchParams.get("pm_top") || "", 10);
              try {
                chrome.system.display.getInfo((displays) => {
                  const d = (displays &&
                    displays[0] &&
                    displays[0].workArea) || {
                    left: 0,
                    top: 0,
                    width: 1280,
                    height: 800,
                  };
                  const w = Math.max(
                    400,
                    wFixed || (wp ? Math.floor(d.width * wp) : 900)
                  );
                  const h = Math.max(
                    300,
                    hFixed || (hp ? Math.floor(d.height * hp) : 820)
                  );
                  const maxW = d.width - margin * 2;
                  const maxH = d.height - margin * 2;
                  const finalW = Math.min(w, maxW);
                  const finalH = Math.min(h, maxH);
                  const left = Number.isFinite(leftParam)
                    ? Math.max(
                        d.left + margin,
                        Math.min(d.left + d.width - finalW - margin, leftParam)
                      )
                    : Math.max(
                        d.left + margin,
                        d.left + Math.floor((d.width - finalW) / 2)
                      );
                  const top = Number.isFinite(topParam)
                    ? Math.max(
                        d.top + margin,
                        Math.min(d.top + d.height - finalH - margin, topParam)
                      )
                    : Math.max(
                        d.top + margin,
                        d.top + Math.floor((d.height - finalH) / 2)
                      );
                  // Ensure only one popup at a time: reuse/resize existing popup if present
                  const createWindow = () =>
                    chrome.windows.create(
                      {
                        url: u.href,
                        type: "popup",
                        state: "normal",
                        width: finalW,
                        height: finalH,
                        left,
                        top,
                        focused: true,
                      },
                      (win) => {
                        CURRENT_TOOL_POPUP_ID = win?.id || null;
                        ensureAutoCloseListener();
                      }
                    );

                  if (CURRENT_TOOL_POPUP_ID) {
                    try {
                      chrome.windows.update(
                        CURRENT_TOOL_POPUP_ID,
                        {
                          state: "normal",
                          width: finalW,
                          height: finalH,
                          left,
                          top,
                          focused: true,
                        },
                        (win) => {
                          const err = chrome.runtime.lastError;
                          if (err || !win) {
                            CURRENT_TOOL_POPUP_ID = null;
                            createWindow();
                          }
                        }
                      );
                    } catch (_) {
                      CURRENT_TOOL_POPUP_ID = null;
                      createWindow();
                    }
                  } else {
                    createWindow();
                  }
                });
              } catch (e) {
                log("windowMode error", e?.message || e);
                chrome.windows.create({
                  url: u.href,
                  type: "popup",
                  focused: true,
                });
              }
              return;
            }
            url = u.href;
          } catch (_) {}
          log("openInActionPopup", { tool, url });
          chrome.storage.local.set({ actionPopupUrl: url }, () => {
            try {
              chrome.action.openPopup(() => {
                const err = chrome.runtime.lastError;
                if (err) log("openPopup error", err.message);
              });
            } catch (e) {
              log("openPopup threw", e?.message || e);
            }
          });
        }
      );
    }

    let CURRENT_TOOL_POPUP_ID = null;
    let AUTOCLOSE_ON_BLUR = true;
    let FOCUS_LISTENER_ATTACHED = false;

    function ensureAutoCloseListener() {
      if (FOCUS_LISTENER_ATTACHED) return;
      try {
        chrome.windows.onFocusChanged.addListener((winId) => {
          try {
            if (!AUTOCLOSE_ON_BLUR) return;
            // If our popup is open and focus moved to another window (or to none), close it
            if (
              CURRENT_TOOL_POPUP_ID &&
              winId !== CURRENT_TOOL_POPUP_ID &&
              winId !== chrome.windows.WINDOW_ID_NONE
            ) {
              chrome.windows.remove(CURRENT_TOOL_POPUP_ID, () => {});
              CURRENT_TOOL_POPUP_ID = null;
            }
          } catch (_) {}
        });
        chrome.windows.onRemoved.addListener((winId) => {
          if (winId === CURRENT_TOOL_POPUP_ID) CURRENT_TOOL_POPUP_ID = null;
        });
        FOCUS_LISTENER_ATTACHED = true;
      } catch (_) {}
    }

    function openToolInCenteredWindow(tool, percent) {
      chrome.storage.local.get(
        {
          toolsPassword: "",
        },
        (cfg) => {
          const baseUrl = "https://paymore-extension.vercel.app";
          const path = toolToPath(tool);
          let url = `${baseUrl}${path}${
            path.includes("?") ? "&" : "?"
          }pm_popup=1`;

          // Add password to all tool URLs if configured
          if (cfg?.toolsPassword) {
            try {
              const u = new URL(url);
              u.searchParams.set("password", cfg.toolsPassword);
              url = u.href;
            } catch (_) {
              url = `${url}${
                url.includes("?") ? "&" : "?"
              }password=${encodeURIComponent(cfg.toolsPassword)}`;
            }
          }
          try {
            chrome.system.display.getInfo((displays) => {
              // Use primary display workArea (excludes taskbars)
              const d = (displays && displays[0] && displays[0].workArea) || {
                left: 0,
                top: 0,
                width: 1280,
                height: 800,
              };
              const w = Math.max(500, Math.floor(d.width * (percent || 0.85)));
              const h = Math.max(400, Math.floor(d.height * (percent || 0.85)));
              const left = Math.max(0, d.left + Math.floor((d.width - w) / 2));
              const top = Math.max(0, d.top + Math.floor((d.height - h) / 2));
              chrome.windows.create(
                {
                  url,
                  type: "popup",
                  width: w,
                  height: h,
                  left,
                  top,
                  focused: true,
                },
                (win) => {
                  try {
                    CURRENT_TOOL_POPUP_ID = win?.id || null;
                    ensureAutoCloseListener();
                  } catch (_) {}
                }
              );
            });
          } catch (e) {
            log("openToolInCenteredWindow error", e?.message || e);
            chrome.windows.create(
              { url, type: "popup", focused: true },
              (win) => {
                try {
                  CURRENT_TOOL_POPUP_ID = win?.id || null;
                  ensureAutoCloseListener();
                } catch (_) {}
              }
            );
          }
        }
      );
    }

    function openToolNear(tool, anchor, percent) {
      chrome.storage.local.get(
        {
          toolsPassword: "",
        },
        (cfg) => {
          const baseUrl = "https://paymore-extension.vercel.app";
          const path = toolToPath(tool);
          let url = `${baseUrl}${path}${
            path.includes("?") ? "&" : "?"
          }pm_window=1`;

          // Add password to all tool URLs if configured
          if (cfg?.toolsPassword) {
            try {
              const u = new URL(url);
              u.searchParams.set("password", cfg.toolsPassword);
              url = u.href;
            } catch (_) {
              url = `${url}${
                url.includes("?") ? "&" : "?"
              }password=${encodeURIComponent(cfg.toolsPassword)}`;
            }
          }
          const ax = Math.max(0, Number(anchor?.x || 0));
          const ay = Math.max(0, Number(anchor?.y || 0));
          try {
            chrome.system.display.getInfo((displays) => {
              const d = (displays && displays[0] && displays[0].workArea) || {
                left: 0,
                top: 0,
                width: 1280,
                height: 800,
              };
              const w = Math.max(420, Math.floor(d.width * (percent || 0.35)));
              const h = Math.max(360, Math.floor(d.height * (percent || 0.35)));
              const gap = 16;
              const openLeft = ax > d.left + d.width * 0.5; // anchor on right half
              let left = openLeft
                ? Math.floor(ax - w - gap)
                : Math.floor(ax + gap);
              let top = Math.floor(ay - Math.floor(h / 2));
              left = Math.min(Math.max(d.left, left), d.left + d.width - w);
              top = Math.min(Math.max(d.top, top), d.top + d.height - h);
              // Reuse existing popup window when possible
              const createWindow = () =>
                chrome.windows.create(
                  {
                    url,
                    type: "popup",
                    state: "normal",
                    width: w,
                    height: h,
                    left,
                    top,
                    focused: true,
                  },
                  (win) => {
                    CURRENT_TOOL_POPUP_ID = win?.id || null;
                    ensureAutoCloseListener();
                  }
                );
              if (CURRENT_TOOL_POPUP_ID) {
                try {
                  chrome.windows.update(
                    CURRENT_TOOL_POPUP_ID,
                    {
                      state: "normal",
                      width: w,
                      height: h,
                      left,
                      top,
                      focused: true,
                    },
                    (updated) => {
                      const err = chrome.runtime.lastError;
                      if (err || !updated) {
                        CURRENT_TOOL_POPUP_ID = null;
                        createWindow();
                      }
                    }
                  );
                } catch (_) {
                  CURRENT_TOOL_POPUP_ID = null;
                  createWindow();
                }
              } else {
                createWindow();
              }
            });
          } catch (e) {
            log("openToolNear error", e?.message || e);
            chrome.windows.create(
              { url, type: "popup", focused: true },
              (win) => {
                try {
                  CURRENT_TOOL_POPUP_ID = win?.id || null;
                  ensureAutoCloseListener();
                } catch (_) {}
              }
            );
          }
        }
      );
    }

    function resizeFocusedPopup(width, height) {
      try {
        chrome.windows.getCurrent((win) => {
          if (!win || win.type !== "popup") return;
          const update = {};
          if (width && Number.isFinite(width)) update.width = Math.floor(width);
          if (height && Number.isFinite(height))
            update.height = Math.floor(height);
          if (Object.keys(update).length) chrome.windows.update(win.id, update);
        });
      } catch (e) {
        log("resizeFocusedPopup error", e?.message || e);
      }
    }

    /**
     * Creates an offscreen document for gamepad detection
     * @returns {Promise<boolean>} Success status
     */
    async function createOffscreenDocument() {
      // Check if offscreen document already exists
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL("offscreen.html")],
      });

      if (existingContexts.length > 0) {
        return true; // Already exists
      }

      try {
        await chrome.offscreen.createDocument({
          url: chrome.runtime.getURL("offscreen.html"),
          reasons: ["DOM_SCRAPING"],
          justification: "Gamepad detection requires access to Gamepad API",
        });
        log("Offscreen document created for gamepad detection");
        return true;
      } catch (error) {
        log("Failed to create offscreen document:", error);
        return false;
      }
    }

    /**
     * Starts monitoring for gamepad connections using offscreen document
     */
    async function startControllerDetection() {
      log("Starting improved controller detection");

      // Clear any existing interval
      if (CONTROLLER_CHECK_INTERVAL) {
        clearInterval(CONTROLLER_CHECK_INTERVAL);
      }

      // Create offscreen document for reliable gamepad detection
      const offscreenCreated = await createOffscreenDocument();
      if (!offscreenCreated) {
        log(
          "Failed to create offscreen document, controller detection may not work reliably"
        );
        // Fall back to the old method
        startFallbackControllerDetection();
        return;
      }

      // Initial check
      checkForControllersWithOffscreen();

      // Set up periodic checking
      CONTROLLER_CHECK_INTERVAL = setInterval(() => {
        checkForControllersWithOffscreen();
      }, 1000); // Check every second for better responsiveness
    }

    /**
     * Fallback controller detection method for when offscreen fails
     */
    function startFallbackControllerDetection() {
      log("Using fallback controller detection");

      // Set up periodic checking with the old method
      CONTROLLER_CHECK_INTERVAL = setInterval(() => {
        checkForControllersFallback();
      }, 2000);
    }

    /**
     * Checks for connected gamepads using offscreen document
     */
    async function checkForControllersWithOffscreen() {
      try {
        // Get the active tab
        const tabs = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tabs.length === 0) return;

        const activeTab = tabs[0];

        // Send message to offscreen document to check for gamepads
        const response = await chrome.runtime.sendMessage({
          action: "checkGamepads",
        });

        if (response && response.success) {
          const { connectedCount, controllerInfo } = response.data;

          // Check if a new controller was connected
          if (connectedCount > LAST_CONTROLLER_COUNT && connectedCount > 0) {
            log(`New controller detected: ${controllerInfo?.id || "Unknown"}`);
            LAST_CONTROLLER_COUNT = connectedCount;
            CONTROLLER_CONNECTED = true;

            // Open the controller testing sidepanel
            toggleSidePanelForTab(activeTab.id, "controller-testing");
          } else if (connectedCount === 0 && LAST_CONTROLLER_COUNT > 0) {
            log("All controllers disconnected");
            LAST_CONTROLLER_COUNT = 0;
            CONTROLLER_CONNECTED = false;
          }
        }
      } catch (error) {
        log("Error in checkForControllersWithOffscreen:", error);
        // Fall back to the old method
        if (CONTROLLER_CHECK_INTERVAL) {
          clearInterval(CONTROLLER_CHECK_INTERVAL);
          startFallbackControllerDetection();
        }
      }
    }

    /**
     * Fallback method to check for connected gamepads
     */
    function checkForControllersFallback() {
      try {
        // Get the active tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length === 0) return;

          const activeTab = tabs[0];

          // Inject a content script to check for gamepads
          chrome.scripting.executeScript(
            {
              target: { tabId: activeTab.id },
              func: () => {
                // This function runs in the content script context
                const gamepads = navigator.getGamepads?.() || [];
                let connectedCount = 0;
                let controllerInfo = null;

                for (let i = 0; i < gamepads.length; i++) {
                  if (gamepads[i]) {
                    connectedCount++;
                    if (!controllerInfo) {
                      controllerInfo = {
                        index: i,
                        id: gamepads[i].id,
                        mapping: gamepads[i].mapping,
                      };
                    }
                  }
                }

                return {
                  connectedCount,
                  controllerInfo,
                };
              },
            },
            (result) => {
              if (chrome.runtime.lastError) {
                log(
                  "Error checking for controllers:",
                  chrome.runtime.lastError
                );
                return;
              }

              if (result && result.length > 0) {
                const { connectedCount, controllerInfo } = result[0].result;

                // Check if a new controller was connected
                if (
                  connectedCount > LAST_CONTROLLER_COUNT &&
                  connectedCount > 0
                ) {
                  log(
                    `New controller detected: ${
                      controllerInfo?.id || "Unknown"
                    }`
                  );
                  LAST_CONTROLLER_COUNT = connectedCount;
                  CONTROLLER_CONNECTED = true;

                  // Open the controller testing sidepanel
                  toggleSidePanelForTab(activeTab.id, "controller-testing");
                } else if (connectedCount === 0 && LAST_CONTROLLER_COUNT > 0) {
                  log("All controllers disconnected");
                  LAST_CONTROLLER_COUNT = 0;
                  CONTROLLER_CONNECTED = false;
                }
              }
            }
          );
        });
      } catch (error) {
        log("Error in checkForControllersFallback:", error);
      }
    }

    /**
     * Stops the controller detection interval
     */
    function stopControllerDetection() {
      if (CONTROLLER_CHECK_INTERVAL) {
        clearInterval(CONTROLLER_CHECK_INTERVAL);
        CONTROLLER_CHECK_INTERVAL = null;
        log("Stopped controller detection");
      }
    }
  },
});
