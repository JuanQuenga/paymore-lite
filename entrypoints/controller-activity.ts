// @ts-nocheck
/* eslint-disable @typescript-eslint/no-explicit-any */
/* global chrome */

import { defineContentScript } from "wxt/utils/define-content-script";

/**
 * Minimal gamepad listener that pings the background service worker
 * whenever the user connects a controller or interacts with it.
 * The background script then ensures the controller testing sidepanel is open.
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  allFrames: false,
  main() {
    // Only run once on the top-level browsing context
    if (window.top !== window) return;

    const log = (...args) => {
      try {
        console.log("[Paymore Lite CS]", ...args);
      } catch (_) {}
    };

    let autoOpen = true;
    let lastNotify = 0;

    chrome.storage?.local?.get({ autoShowModal: true }, (cfg) => {
      autoOpen = cfg?.autoShowModal ?? true;
      log("auto open controller sidepanel?", autoOpen);
    });

    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !changes?.autoShowModal) return;
      autoOpen = changes.autoShowModal.newValue ?? true;
      log("auto open preference updated", autoOpen);
    });

    const notifyActivity = (reason) => {
      if (!autoOpen) return;

      const now = Date.now();
      if (now - lastNotify < 1000) return; // Reduced debounce time for faster response
      lastNotify = now;

      // For input events, directly open the sidebar to maintain user gesture context
      if (reason === "input") {
        try {
          chrome.runtime.sendMessage({
            action: "openInSidebar",
            tool: "controller-testing",
            source: "controller-activity",
          });
          log("Controller input detected, opening sidebar directly");
        } catch (e) {
          log("failed to open sidebar for controller input", e);
        }
      } else {
        // For connection events, just notify the background
        try {
          chrome.runtime.sendMessage({
            action: "controllerActivityDetected",
            reason,
            timestamp: now,
            source: "controller-activity",
          });
          log("Controller activity detected, notifying background:", reason);
        } catch (e) {
          log("failed to notify controller activity", e);
        }
      }
    };

    window.addEventListener("gamepadconnected", (event) => {
      log("gamepadconnected", {
        id: event?.gamepad?.id,
        index: event?.gamepad?.index,
      });
      // Don't immediately open sidebar on connection as it's not a user gesture
      // Only log the connection for debugging
      log("Controller connected, waiting for user input to open sidebar");
    });

    const hasActiveInput = (gamepad) => {
      if (!gamepad) return false;

      try {
        if (
          gamepad.buttons?.some(
            (btn) => btn?.pressed || (btn?.value ?? 0) > 0.2
          )
        ) {
          return true;
        }
        if (gamepad.axes?.some((axis) => Math.abs(axis) > 0.25)) {
          return true;
        }
      } catch (e) {
        log("error inspecting gamepad", e);
      }
      return false;
    };

    const pollForInput = () => {
      try {
        const pads = navigator.getGamepads?.();
        if (pads) {
          for (const pad of pads) {
            if (hasActiveInput(pad)) {
              notifyActivity("input");
              break;
            }
          }
        }
      } catch (e) {
        log("poll error", e);
      }
      window.requestAnimationFrame(pollForInput);
    };

    // Voice transcript injection listener
    try {
      window.addEventListener("message", (e: any) => {
        // reserved for future page-level events
      });
      chrome.runtime.onMessage.addListener((message: any) => {
        if (message?.action === "pm-voice-transcript") {
          try {
            import("../src/utils/transcript-injector").then((m) => {
              m.handleTranscriptMessage({
                interim: !!message.interim,
                text: String(message.text || ""),
              });
            });
          } catch (_) {}
        }
      });
    } catch (_) {}

    // Start polling loop once the document is ready
    // Add a small delay to prevent immediate triggering on page load
    setTimeout(() => {
      try {
        window.requestAnimationFrame(pollForInput);
      } catch (e) {
        log("failed to start polling", e);
      }
    }, 2000); // 2 second delay before starting to poll for input
  },
});
