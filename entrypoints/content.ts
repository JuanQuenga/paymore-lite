/**
 * @fileoverview PayMore Chrome Extension Content Script
 * @description Handles core functionality without toolbar
 * @version 1.0.0
 * @author PayMore Team
 * @license MIT
 *
 * This content script handles:
 * - Controller modal functionality
 * - URL exclusion logic for specific domains
 * - Message communication with background script
 * - Auto-show/hide modal based on controller connection
 */

// @ts-nocheck
/* eslint-disable @typescript-eslint/no-explicit-any */
/* global chrome */
import { defineContentScript } from "wxt/utils/define-content-script";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  allFrames: true,
  main() {
    console.log("[Paymore] Content script loaded", location.href);
    // Check if extension should be active on this site
    checkSiteStatusAndInitialize();
  },
});

/**
 * Checks site status and initializes extension if allowed
 */
async function checkSiteStatusAndInitialize() {
  try {
    // Get current domain
    const currentDomain = window.location.hostname.toLowerCase();
    console.log("[Paymore] Checking site status for:", currentDomain);

    // Check with background script if site is disabled
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "checkSiteStatus", domain: currentDomain },
        (response) => {
          if (chrome.runtime.lastError) {
            console.log(
              "[Paymore CS] Error checking site status:",
              chrome.runtime.lastError
            );
            resolve({ success: false, disabled: false });
          } else {
            console.log("[Paymore CS] Site status response:", response);
            resolve(response || { success: false, disabled: false });
          }
        }
      );
    });

    if (response.success && response.disabled) {
      console.log("[Paymore CS] Extension disabled for site:", currentDomain);
      return; // Don't initialize extension on this site
    }

    console.log("[Paymore] Initializing extension...");
    // Initialize extension functionality
    initializeExtension();
  } catch (error) {
    console.log(
      "[Paymore CS] Error checking site status, initializing anyway:",
      error
    );
    // Initialize anyway if there's an error
    initializeExtension();
  }
}

/**
 * Initializes the extension functionality
 */
function initializeExtension() {
  /** @type {string} Inner modal ID defined in HTML */
  const MODAL_ID = "paymore-controller-modal";

  /** @type {string} Outer container ID that we create */
  const CONTAINER_ID = "paymore-controller-container";

  /** @type {boolean} Auto-show modal flag */
  let autoShow = true;

  /** @type {boolean} Current modal visibility state */
  let modalVisible = false;

  /** @type {boolean} Prevent immediate re-open while controller remains connected */
  let userDismissed = false;

  /**
   * Logs messages with content script prefix
   * @param {...any} a - Arguments to log
   */
  const log = (...a) => console.log("[Paymore CS]", ...a);

  /** @type {boolean} Flag indicating if modal has been injected */
  let modalInjected = false;

  /** @type {boolean} Desired modal visibility state */
  let wantedVisible = false;

  /** @type {number} Timestamp of last active state */
  let lastActive = 0;

  /** @type {number} Timestamp of last controller connection */
  let lastConnected = 0;

  /** @type {number} Timestamp when modal was last dismissed */
  let lastDismissedAt = 0;

  /** @type {boolean} Track user-initiated open to disable auto-hide */
  let manualOpen = false;

  // Block injection in iframes/embedded contexts
  try {
    const inFrame = (() => {
      try {
        return window.top !== window.self;
      } catch (_) {
        return true;
      }
    })();
    if (inFrame) {
      try {
        chrome.runtime?.sendMessage?.({
          action: "csReady",
          url: location.href,
          excluded: true,
          reason: "iframe",
        });
      } catch (_) {}
      return;
    }
  } catch (_) {}

  /**
   * Injects the controller modal into the page
   * @returns {void}
   */
  function injectModal() {
    // Legacy controller tester modal disabled. Use hosted tool instead.
    return;
  }

  // URL exclusion list for modal injection
  /** @type {RegExp[]} URL patterns to exclude modal injection */
  const EXCLUDE_URLS = [
    // Patterns to exclude modal (edit as needed)
    /paymore\-extension\.vercel\.app/i,
  ];

  /**
   * Checks if current URL should be excluded from modal injection
   * @param {string} url - URL to check
   * @returns {boolean} True if URL should be excluded
   */
  function isExcludedUrl(url) {
    try {
      // Exclude our own popup windows (opened by background with pm_popup=1)
      if (/([?&])pm_popup=1(?!\d)/.test(url)) return true;
      return EXCLUDE_URLS.some((re) => re.test(url));
    } catch (_) {
      return false;
    }
  }

  function isThisTabActive() {
    try {
      return (
        document.visibilityState === "visible" &&
        (document.hasFocus ? document.hasFocus() : true)
      );
    } catch (_) {
      return true;
    }
  }

  function showModal() {
    // Secondary guard in case a background message slips through
    if (isExcludedUrl(location.href)) return;
    injectModal();
    const root = document.getElementById(MODAL_ID);
    if (root) {
      root.style.display = "block";
      modalVisible = true;
      userDismissed = false;
      log("modal shown");
    } else if (!modalInjected) {
      // Defer until injection completes
      wantedVisible = true;
      log("modal not yet injected; will show when ready");
    }
  }

  function hideModal() {
    const root = document.getElementById(MODAL_ID);
    if (root) {
      root.style.display = "none";
      modalVisible = false;
      userDismissed = true;
      lastDismissedAt = Date.now();
      manualOpen = false;
      log("modal hidden");
    }
  }

  /** @param {any} message @param {any} _sender @param {any} sendResponse */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    log("received message", message);
    // Provide sanitized page context for AI when requested by side panel
    if (message && message.action === "pm:getPageContext") {
      try {
        const maxChars = 20000; // keep token usage reasonable
        const getMeta = (name) =>
          document.querySelector(`meta[name="${name}"]`)?.content || "";
        const selection = (window.getSelection?.()?.toString?.() || "").slice(
          0,
          4000
        );
        const text = (document.body?.innerText || "")
          .replace(/\s+/g, " ")
          .slice(0, maxChars);
        const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
          .map((h) => h.textContent?.trim())
          .filter(Boolean)
          .slice(0, 40);

        // Enhanced context for specific pages
        let enhancedContext = {};

        // Special handling for pos.paymore.tech/autolister
        if (
          location.hostname === "pos.paymore.tech" &&
          location.pathname.includes("/autolister")
        ) {
          try {
            // Capture form fields and their values
            const formFields = {};
            const formInputs = document.querySelectorAll(
              "input, select, textarea"
            );
            formInputs.forEach((input, index) => {
              if (index < 100) {
                // Limit to prevent overwhelming data
                const name = input.name || input.id || `field_${index}`;
                const value = input.value || input.textContent || "";
                const type = input.type || input.tagName.toLowerCase();
                const placeholder = input.placeholder || "";

                if (value.trim() || placeholder.trim()) {
                  formFields[name] = {
                    value: value.trim(),
                    type: type,
                    placeholder: placeholder.trim(),
                  };
                }
              }
            });

            // Capture attribute data from the page
            const attributeData = {};
            const attributeElements = document.querySelectorAll(
              "[data-attribute], [class*='attribute'], [class*='spec'], [class*='field']"
            );
            attributeElements.forEach((elem, index) => {
              if (index < 50) {
                const text = elem.textContent?.trim();
                if (text && text.length > 2 && text.length < 200) {
                  attributeData[`attr_${index}`] = text;
                }
              }
            });

            // Try to capture iframe content if accessible
            let iframeContent = null;
            try {
              const iframes = document.querySelectorAll("iframe");
              if (iframes.length > 0) {
                const iframe = iframes[0]; // Usually the main output iframe
                if (iframe.contentDocument && iframe.contentDocument.body) {
                  const iframeText =
                    iframe.contentDocument.body.innerText || "";
                  iframeContent = iframeText.slice(0, 5000); // Limit iframe content
                }
              }
            } catch (iframeError) {
              // Could not access iframe content (cross-origin restriction)
            }

            // Capture specific autolister elements
            const autolisterData = {};

            // Collection and sub-collection info
            const collectionElements = document.querySelectorAll(
              "[class*='collection'], [class*='category']"
            );
            collectionElements.forEach((elem, index) => {
              if (index < 10) {
                const text = elem.textContent?.trim();
                if (text) {
                  autolisterData[`collection_${index}`] = text;
                }
              }
            });

            // Product specifications
            const specElements = document.querySelectorAll(
              "[class*='spec'], [class*='specification'], [class*='detail']"
            );
            specElements.forEach((elem, index) => {
              if (index < 20) {
                const text = elem.textContent?.trim();
                if (text && text.length > 3) {
                  autolisterData[`spec_${index}`] = text;
                }
              }
            });

            // What's included items
            const includedElements = document.querySelectorAll(
              "[class*='included'], [class*='item'], [class*='checklist']"
            );
            includedElements.forEach((elem, index) => {
              if (index < 15) {
                const text = elem.textContent?.trim();
                if (text && text.length > 3) {
                  autolisterData[`included_${index}`] = text;
                }
              }
            });

            enhancedContext = {
              formFields,
              attributeData,
              iframeContent,
              autolisterData,
              pageType: "autolister_form",
            };

            console.log("✅ Enhanced autolister context captured:", {
              formFieldsCount: Object.keys(formFields).length,
              attributeDataCount: Object.keys(attributeData).length,
              iframeContentLength: iframeContent ? iframeContent.length : 0,
              autolisterDataCount: Object.keys(autolisterData).length,
            });
          } catch (enhancedError) {
            console.error(
              "❌ Error capturing enhanced context:",
              enhancedError
            );
          }
        }

        const context = {
          url: location.href,
          title: document.title || "",
          description: getMeta("description"),
          selection,
          headings,
          excerpt: text,
          tabName: document.title || "",
          domain: location.hostname,
          timestamp: Date.now(),
          ...enhancedContext,
        };

        try {
          sendResponse({ ok: true, context });
        } catch (_) {}
      } catch (e) {
        console.error("❌ Error preparing page context:", e);
        try {
          sendResponse({ ok: false, error: e?.message || String(e) });
        } catch (_) {}
      }
      return; // ensure we don't fall-through to the generic responder below
    }
    if (message.action === "showControllerModal") {
      manualOpen = true;
      showModal();
    }
    if (message.action === "hideControllerModal") {
      manualOpen = false;
      hideModal();
    }
    if (message.action === "openCheckoutPrices") {
      // This is now handled by the background script opening a new tab
      // No local action needed
    }
    if (message.action === "pm-chat:attention") {
      // Chat attention handling without toolbar
      try {
        // Increment unread on runtime broadcast
        chrome.storage?.local?.get({ pmChatUnread: 0 }, (cfg) => {
          const next = Math.min(99, Number(cfg?.pmChatUnread || 0) + 1);
          chrome.storage?.local?.set({ pmChatUnread: next });
        });
      } catch (_) {}
    } else if (message.action === "scout:scanPOS") {
      // Handle Scout POS scanning request
      try {
        const posData = scanPOSWebsite();
        sendResponse({ success: true, ...posData });
      } catch (error) {
        console.error("Error scanning POS website:", error);
        sendResponse({ success: false, error: error.message });
      }
      return true; // Keep message channel open for async response
    } else if (message.action === "GET_WEBPAGE_CONTEXT") {
      // Handle webpage context request for AI chat
      try {
        const currentUrl = window.location.href;
        const currentTitle = document.title;
        const currentDomain = window.location.hostname;
        const currentPath = window.location.pathname;

        // Extract product information for e-commerce sites
        let productTitle = "";
        let listingTitle = "";

        if (
          currentDomain.includes("amazon.com") ||
          currentDomain.includes("amazon.ca")
        ) {
          productTitle =
            document.querySelector('h1[id="title"]')?.textContent?.trim() || "";
        } else if (currentDomain.includes("ebay.com")) {
          listingTitle =
            document.querySelector('h1[class*="title"]')?.textContent?.trim() ||
            "";
        }

        const contextData = {
          url: currentUrl,
          title: currentTitle,
          domain: currentDomain,
          path: currentPath,
          productTitle,
          listingTitle,
        };

        sendResponse({ success: true, data: contextData });
      } catch (error) {
        console.error("Error getting webpage context:", error);
        sendResponse({ success: false, error: error.message });
      }
      return true; // Keep message channel open for async response
    } else if (message.action === "pm-settings-changed") {
      // Handle settings changes from background script
      log("Settings changed, checking if extension should be disabled");
      const currentDomain = window.location.hostname.toLowerCase();
      const disabledSites = message.disabledSites || [];

      const isCurrentlyDisabled = disabledSites.some((site) => {
        return currentDomain === site || currentDomain.endsWith("." + site);
      });

      if (isCurrentlyDisabled) {
        log("Extension disabled for current site:", currentDomain);
        // Hide any existing modal and stop functionality
        hideModal();
        // Remove any injected elements
        const existingContainer = document.getElementById(CONTAINER_ID);
        if (existingContainer) {
          existingContainer.remove();
        }
      } else {
        log("Extension enabled for current site:", currentDomain);
        // Re-initialize if needed
        if (!modalInjected) {
          initializeModal();
        }
      }

      sendResponse({ success: true });
      return true; // Keep message channel open for async response
    }
    try {
      sendResponse({ ok: true });
    } catch (_) {}
  });

  // optional: auto-inject silently; shown on demand
  // If the current page is excluded, skip all setup entirely
  if (isExcludedUrl(location.href)) {
    try {
      chrome.runtime.sendMessage({
        action: "csReady",
        url: location.href,
        excluded: true,
      });
    } catch (_) {}
  } else if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        try {
          chrome.runtime.sendMessage({ action: "csReady", url: location.href });
        } catch (_) {}
        log("sent csReady");
      },
      { once: true }
    );
  } else {
    try {
      chrome.runtime.sendMessage({ action: "csReady", url: location.href });
    } catch (_) {}
    log("sent csReady");
  }
  // Also listen for clicks inside popup-opened action to confirm
  window.addEventListener("message", (e) => {
    if (e?.data === "paymore:show") {
      manualOpen = true;
      showModal();
    }
    if (e?.data === "paymore:hide") {
      manualOpen = false;
      hideModal();
    }
  });

  // Fallback: handle SW postMessage bridge
  window.addEventListener("message", (ev) => {
    const data = ev?.data || {};
    // Forward tool preferred size from Next.js pages
    if (
      data?.type === "pm-tools:preferredSize" &&
      (typeof data.width === "number" || typeof data.height === "number")
    ) {
      try {
        chrome.runtime.sendMessage({
          action: "resizeToolForTab",
          width: Number(data.width) || null,
          height: Number(data.height) || null,
        });
      } catch (_) {}
    }
    // Chat attention broadcast
    if (data?.type === "pm-chat:attention") {
      try {
        // increment unread count
        chrome.storage?.local?.get({ pmChatUnread: 0 }, (cfg) => {
          const next = Math.min(99, Number(cfg?.pmChatUnread || 0) + 1);
          chrome.storage?.local?.set({ pmChatUnread: next });
        });
      } catch (_) {}
      // Do not forward to background here to avoid feedback loops; background is notified directly by chat tool
    }
    if (data?.source === "paymore" && data?.action === "showControllerModal") {
      log("postMessage bridge -> show");
      manualOpen = true;
      showModal();
    }
    if (data?.source === "paymore" && data?.action === "hideControllerModal") {
      log("postMessage bridge -> hide");
      manualOpen = false;
      hideModal();
    }
  });

  // Auto-show when controller is connected and used
  try {
    /** @param {{autoShowModal?: boolean}} cfg */
    chrome.storage?.local?.get({ autoShowModal: true }, (cfg) => {
      autoShow = cfg?.autoShowModal ?? true;
      log("storage settings", { autoShow });
    });
  } catch (_) {}

  let gamepadAccessDenied = false;

  function isGamepadAllowed() {
    if (gamepadAccessDenied) return false;

    try {
      const policy = (document as any)?.permissionsPolicy;
      if (policy?.allows) return policy.allows("gamepad");
    } catch (_) {
      // Fall through to try older Feature Policy API
    }

    try {
      const featurePolicy = (document as any)?.featurePolicy;
      if (featurePolicy?.allowsFeature) {
        return featurePolicy.allowsFeature("gamepad");
      }
      if (featurePolicy?.features) {
        return featurePolicy.features().includes("gamepad");
      }
    } catch (_) {
      // Ignore failures and fall through to assume access is allowed
    }

    return true;
  }

  function safeGetGamepads() {
    if (gamepadAccessDenied) return [];
    if (!isGamepadAllowed()) {
      gamepadAccessDenied = true;
      log("Gamepad access blocked by Permissions Policy (pre-check)");
      return [];
    }

    try {
      if (typeof navigator.getGamepads !== "function") return [];
      return Array.from(navigator.getGamepads());
    } catch (error) {
      gamepadAccessDenied = true;
      log("Gamepad access blocked by Permissions Policy", error);
      return [];
    }
  }

  function anyGamepadConnected() {
    return safeGetGamepads().some((gp) => gp);
  }

  function anyGamepadActive() {
    const gps = safeGetGamepads();
    for (const gp of gps) {
      if (!gp) continue;
      if (gp.buttons?.some((b) => b?.pressed || (b?.value ?? 0) > 0.15))
        return true;
      if (gp.axes?.some((a) => Math.abs(a) > 0.2)) return true;
    }
    return false;
  }

  let lastControllerPopupAt = 0;
  window.addEventListener("gamepadconnected", (e) => {
    log("gamepadconnected", { id: e.gamepad?.id, index: e.gamepad?.index });
    lastConnected = Date.now();
    userDismissed = false; // new connection lifts manual dismissal
    // Open hosted Controller Test instead of legacy modal
    const now = Date.now();
    if (isThisTabActive() && now - lastControllerPopupAt > 5000) {
      lastControllerPopupAt = now;
      try {
        chrome.runtime.sendMessage({
          action: "openInSidebar",
          tool: "controller-testing",
        });
      } catch (_) {}
    }
  });
  window.addEventListener("gamepaddisconnected", (e) => {
    log("gamepaddisconnected", { id: e.gamepad?.id, index: e.gamepad?.index });
    // don't immediately hide; polling loop applies grace period
  });

  // Light polling to detect activity and auto-open
  setInterval(() => {
    const now = Date.now();
    const active = anyGamepadActive();
    if (active) {
      lastActive = now;
      log("activity", { t: now });
    }
    const connected = anyGamepadConnected();
    const recentlyActive = now - lastActive < 1000; // 1s grace
    const recentlyConnected = now - lastConnected < 1500; // 1.5s grace

    // Reopen rules:
    // - If never manually dismissed, show on connected/recent activity as before
    // - If manually dismissed, only reopen on fresh activity after dismissal
    const shouldReopenAfterDismiss =
      userDismissed && (lastActive > lastDismissedAt || recentlyConnected);
    const shouldAutoOpen =
      isThisTabActive() &&
      (connected || recentlyActive || recentlyConnected) &&
      (!userDismissed || shouldReopenAfterDismiss);
    // Auto-open the hosted Controller Testing in the sidebar on fresh activity/connection
    if (autoShow && shouldAutoOpen && now - lastControllerPopupAt > 5000) {
      lastControllerPopupAt = now;
      try {
        chrome.runtime.sendMessage({
          action: "openInSidebar",
          tool: "controller-testing",
        });
      } catch (_) {}
    }

    // Only hide if no connection and no activity grace windows
    // No-op
  }, 250);

  // Hide when tab loses visibility/focus to keep it scoped to active tab
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" && modalVisible) hideModal();
  });
  window.addEventListener("blur", () => {
    if (modalVisible) hideModal();
  });

  // Function to scan POS website data
  function scanPOSWebsite() {
    const data = {
      products: [],
      customers: [],
      orders: [],
    };

    try {
      // Check if we're on the POS inventory page
      if (location.href.includes("pos.paymore.tech/inventory")) {
        // Enhanced handling for POS inventory page with proper table structure
        const inventoryRows = document.querySelectorAll(
          'tr[class*="bg-light"], tr[class*="bg-light-danger"], tr[class*="bg-light-success"], tr[class*="bg-light-warning"]'
        );

        inventoryRows.forEach((row, index) => {
          const cells = row.querySelectorAll("td");
          if (cells.length >= 12) {
            const orderId =
              cells[1]?.textContent?.trim() || `Order-${index + 1}`;
            const customerName = cells[2]?.textContent?.trim() || "Unknown";
            const quantity = parseInt(cells[3]?.textContent?.trim()) || 0;
            const paymentMethod = cells[4]?.textContent?.trim() || "";
            const totalPrice = cells[5]?.textContent?.trim() || "";
            const profit = cells[6]?.textContent?.trim() || "";
            const profitPercentage = cells[7]?.textContent?.trim() || "";
            const grade = cells[8]?.textContent?.trim() || "";
            const date = cells[9]?.textContent?.trim() || "";
            const employee = cells[10]?.textContent?.trim() || "";
            const timeRemaining = cells[11]?.textContent?.trim() || "";

            // Extract price values
            const totalPriceValue =
              parseFloat(totalPrice.replace(/[^0-9.-]/g, "")) || 0;
            const profitValue =
              parseFloat(profit.replace(/[^0-9.-]/g, "")) || 0;
            const profitPercentValue =
              parseFloat(profitPercentage.replace(/[^0-9.-]/g, "")) || 0;

            // Check if this row is expandable and has sub-items
            const isExpandable =
              row.hasAttribute("data-bs-toggle") ||
              row.querySelector('[data-bs-toggle="collapse"]');
            const targetId =
              row.getAttribute("data-bs-target") ||
              row
                .querySelector("[data-bs-target]")
                ?.getAttribute("data-bs-target");

            let subItems = [];
            if (isExpandable && targetId) {
              // Try to find expanded content
              const expandedContent = document.querySelector(targetId);
              if (expandedContent) {
                const subRows = expandedContent.querySelectorAll("tr");
                subRows.forEach((subRow, subIndex) => {
                  const subCells = subRow.querySelectorAll("td");
                  if (subCells.length >= 3) {
                    const subItemName =
                      subCells[0]?.textContent?.trim() ||
                      `Sub-item ${subIndex + 1}`;
                    const subItemPrice = subCells[1]?.textContent?.trim() || "";
                    const subItemGrade = subCells[2]?.textContent?.trim() || "";

                    const subItemPriceValue =
                      parseFloat(subItemPrice.replace(/[^0-9.-]/g, "")) || 0;

                    subItems.push({
                      name: subItemName,
                      price: subItemPriceValue,
                      grade: subItemGrade,
                      sku: `${orderId}-SUB-${subIndex + 1}`,
                    });
                  }
                });
              }

              // If no expanded content found, try to trigger expansion
              if (subItems.length === 0) {
                try {
                  // Try to find and click the expand button
                  const expandBtn = row.querySelector(
                    '[data-bs-toggle="collapse"]'
                  );
                  if (expandBtn) {
                    // Create a temporary click event to expand
                    const clickEvent = new MouseEvent("click", {
                      bubbles: true,
                      cancelable: true,
                      view: window,
                    });
                    expandBtn.dispatchEvent(clickEvent);

                    // Wait a bit for expansion animation
                    setTimeout(() => {
                      const expandedContent = document.querySelector(targetId);
                      if (
                        expandedContent &&
                        expandedContent.classList.contains("show")
                      ) {
                        const subRows = expandedContent.querySelectorAll("tr");
                        subRows.forEach((subRow, subIndex) => {
                          const subCells = subRow.querySelectorAll("td");
                          if (subCells.length >= 3) {
                            const subItemName =
                              subCells[0]?.textContent?.trim() ||
                              `Sub-item ${subIndex + 1}`;
                            const subItemPrice =
                              subCells[1]?.textContent?.trim() || "";
                            const subItemGrade =
                              subCells[2]?.textContent?.trim() || "";

                            const subItemPriceValue =
                              parseFloat(
                                subItemPrice.replace(/[^0-9.-]/g, "")
                              ) || 0;

                            subItems.push({
                              name: subItemName,
                              price: subItemPriceValue,
                              grade: subItemGrade,
                              sku: `${orderId}-SUB-${subIndex + 1}`,
                            });
                          }
                        });
                      }
                    }, 100);
                  }
                } catch (error) {
                  console.log("Could not expand row:", error);
                }
              }
            }

            // Create main order entry
            const orderEntry = {
              orderId: orderId,
              customer: customerName,
              quantity: quantity,
              paymentMethod: paymentMethod,
              totalPrice: totalPriceValue,
              profit: profitValue,
              profitPercentage: profitPercentValue,
              grade: grade,
              date: date,
              employee: employee,
              timeRemaining: timeRemaining,
              subItems: subItems,
              isMultiItem: quantity > 1 || subItems.length > 0,
            };

            data.orders.push(orderEntry);

            // Create product entries for each item
            if (subItems.length > 0) {
              // Use sub-items if available
              subItems.forEach((subItem, subIndex) => {
                data.products.push({
                  name: subItem.name,
                  price: subItem.price,
                  sku: subItem.sku,
                  category: subItem.grade,
                  stock: 1,
                  customer: customerName,
                  paymentMethod: paymentMethod,
                  profit: subItem.price * (profitPercentValue / 100),
                  profitPercentage: profitPercentValue,
                  date: date,
                  employee: employee,
                  timeRemaining: timeRemaining,
                  orderId: orderId,
                  isSubItem: true,
                });
              });
            } else {
              // Create single product entry
              data.products.push({
                name: `${orderId} - ${customerName}`,
                price: totalPriceValue,
                sku: orderId,
                category: grade,
                stock: quantity,
                customer: customerName,
                paymentMethod: paymentMethod,
                profit: profitValue,
                profitPercentage: profitPercentValue,
                date: date,
                employee: employee,
                timeRemaining: timeRemaining,
                orderId: orderId,
                isSubItem: false,
              });
            }

            // Add customer if not already present
            const existingCustomer = data.customers.find(
              (c) => c.name === customerName
            );
            if (!existingCustomer) {
              data.customers.push({
                name: customerName,
                email: `${customerName
                  .toLowerCase()
                  .replace(/\s+/g, ".")}@example.com`,
                phone: `555-${String(index + 1).padStart(3, "0")}`,
                totalSpent: totalPriceValue,
                lastVisit: date,
              });
            }
          }
        });

        // If no inventory rows found, try alternative selectors
        if (data.products.length === 0) {
          const allRows = document.querySelectorAll("tr");
          allRows.forEach((row, index) => {
            const cells = row.querySelectorAll("td");
            if (cells.length >= 5) {
              const itemId = cells[1]?.textContent?.trim();
              const customerName = cells[2]?.textContent?.trim();
              const quantity = cells[3]?.textContent?.trim();
              const payment = cells[4]?.textContent?.trim();
              const total = cells[5]?.textContent?.trim();

              if (itemId && itemId !== "") {
                data.products.push({
                  name: `${itemId} - ${customerName || "Unknown"}`,
                  price: parseFloat(total?.replace(/[^0-9.-]/g, "")) || 0,
                  sku: itemId,
                  category: "Inventory",
                  stock: parseInt(quantity) || 0,
                  customer: customerName || "Unknown",
                  paymentMethod: payment || "Unknown",
                });
              }
            }
          });
        }
      } else {
        // Original scanning logic for other websites
        const productElements = document.querySelectorAll(
          '[class*="product"], [class*="item"], [class*="sku"], [id*="product"], [id*="item"]'
        );
        productElements.forEach((element, index) => {
          const name = element
            .querySelector(
              '[class*="name"], [class*="title"], h1, h2, h3, h4, h5, h6'
            )
            ?.textContent?.trim();
          const price = element
            .querySelector(
              '[class*="price"], [class*="cost"], [class*="amount"]'
            )
            ?.textContent?.trim();
          const sku = element
            .querySelector('[class*="sku"], [class*="code"], [class*="id"]')
            ?.textContent?.trim();

          if (name) {
            data.products.push({
              name: name || `Product ${index + 1}`,
              price: parseFloat(price?.replace(/[^0-9.-]/g, "")) || 0,
              stock: Math.floor(Math.random() * 100) + 1, // Placeholder
            });
          }
        });
      }

      // Scan for customer information
      const customerElements = document.querySelectorAll(
        '[class*="customer"], [class*="user"], [class*="profile"], [id*="customer"], [id*="user"]'
      );
      customerElements.forEach((element, index) => {
        const name = element
          .querySelector(
            '[class*="name"], [class*="title"], h1, h2, h3, h4, h5, h6'
          )
          ?.textContent?.trim();
        const email =
          element.querySelector('[type="email"], [class*="email"]')?.value ||
          element.querySelector('[class*="email"]')?.textContent?.trim();
        const phone =
          element.querySelector(
            '[type="tel"], [class*="phone"], [class*="telephone"]'
          )?.value ||
          element.querySelector('[class*="phone"]')?.textContent?.trim();

        if (name) {
          data.customers.push({
            name: name || `Customer ${index + 1}`,
            email: email || `customer${index + 1}@example.com`,
            phone: phone || `555-${String(index + 1).padStart(3, "0")}`,
            totalSpent: Math.floor(Math.random() * 1000) + 100,
            lastVisit: new Date().toLocaleDateString(),
          });
        }
      });

      // Scan for order information
      const orderElements = document.querySelectorAll(
        '[class*="order"], [class*="transaction"], [class*="receipt"], [id*="order"], [id*="transaction"]'
      );
      orderElements.forEach((element, index) => {
        const id = element
          .querySelector(
            '[class*="id"], [class*="number"], [class*="order-id"]'
          )
          ?.textContent?.trim();
        const customer = element
          .querySelector(
            '[class*="customer"], [class*="buyer"], [class*="name"]'
          )
          ?.textContent?.trim();
        const total = element
          .querySelector('[class*="total"], [class*="amount"], [class*="sum"]')
          ?.textContent?.trim();
        const status = element
          .querySelector('[class*="status"], [class*="state"]')
          ?.textContent?.trim();

        if (id || customer) {
          data.orders.push({
            id: id || `ORDER-${index + 1}`,
            customer: customer || `Customer ${index + 1}`,
            total: parseFloat(total?.replace(/[^0-9.-]/g, "")) || 0,
            status: status || "Completed",
            date: new Date().toLocaleDateString(),
            items: [],
          });
        }
      });

      // If no structured data found, try to extract from page content
      if (
        data.products.length === 0 &&
        data.customers.length === 0 &&
        data.orders.length === 0
      ) {
        // Fallback: look for common patterns in text content
        const pageText = document.body.textContent || "";

        // Look for price patterns
        const priceMatches = pageText.match(/\$\d+\.?\d*/g);
        if (priceMatches) {
          priceMatches.slice(0, 10).forEach((price, index) => {
            data.products.push({
              name: `Product ${index + 1}`,
              price: parseFloat(price.replace("$", "")),
              sku: `SKU-${index + 1}`,
              category: "General",
              stock: Math.floor(Math.random() * 100) + 1,
            });
          });
        }

        // Look for email patterns
        const emailMatches = pageText.match(
          /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
        );
        if (emailMatches) {
          emailMatches.slice(0, 5).forEach((email, index) => {
            data.customers.push({
              name: `Customer ${index + 1}`,
              email: email,
              phone: `555-${String(index + 1).padStart(3, "0")}`,
              totalSpent: Math.floor(Math.random() * 1000) + 100,
              lastVisit: new Date().toLocaleDateString(),
            });
          });
        }
      }
    } catch (error) {
      console.error("Error during POS scanning:", error);
    }

    return data;
  }

  // Initialize modal function
  function initializeModal() {
    // Modal initialization logic (currently disabled)
    // Legacy controller tester modal disabled. Use hosted tool instead.
  }
}
