import { defineConfig, type WxtViteConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Use the official Tailwind v4 Vite plugin for class scanning + HMR.
  vite: () => ({ plugins: [tailwindcss()] } as WxtViteConfig),
  outDir: ".output", // Base output directory
  outDirTemplate: "paymore-chrome-lite", // Custom output directory name (removes browser/manifest folder nesting)
  contentScripts: [
    {
      matches: ["<all_urls>"],
      entries: ["controller-activity"],
    },
  ],
  manifest: {
    name: "Paymore Chrome Lite",
    version: "1.0.0",
    description: "Chrome extension for Paymore Employees (Lite Version).",
    permissions: [
      "storage",
      "tabs",
      "activeTab",
      "scripting",
      "sidePanel",
      "system.display",
      // Needed for adding right-click context menu actions
      "contextMenus",
      // Needed for CMDK bookmarks and history
      "bookmarks",
      "history",
    ],
    host_permissions: ["<all_urls>"],
    icons: {
      16: "assets/icons/icon16.png",
      32: "assets/icons/icon32.png",
      48: "assets/icons/icon48.png",
      128: "assets/icons/icon128.png",
    },
    action: {
      default_icon: "assets/images/brand.png",
      default_popup: "popup.html",
    },
    side_panel: {
      default_path: "sidepanel.html",
    },
    options_page: "options.html",
    content_scripts: [
      {
        matches: ["<all_urls>"],
        run_at: "document_idle",
        js: ["controller-activity.js"],
      },
    ],
    commands: {
      _execute_action: {
        suggested_key: {
          default: "Ctrl+Shift+K",
          mac: "Command+Shift+K",
        },
        description: "Open Command Popup",
      },
      "open-voice": {
        suggested_key: {
          default: "Ctrl+Shift+V",
          mac: "Command+Shift+V",
        },
        description: "Open Voice Popup",
      },
      "open-options": {
        suggested_key: {
          default: "Ctrl+O",
          mac: "Command+O",
        },
        description: "Open extension options",
      },
      "open-controller-testing": {
        suggested_key: {
          default: "Ctrl+J",
          mac: "Command+J",
        },
        description: "Open Controller Testing Sidepanel",
      },
    },
    // Expose assets to the extension
    web_accessible_resources: [
      {
        resources: ["assets/images/*"],
        matches: ["<all_urls>"],
      },
    ],
  },
} as any);
