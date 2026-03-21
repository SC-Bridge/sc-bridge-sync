import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  manifest: {
    name: "SC Bridge Sync",
    description:
      "Syncs your Star Citizen hangar data from RSI to SC Bridge. Ships, insurance, pledges, CCU chains, and custom ship names.",
    permissions: ["cookies", "storage", "tabs", "alarms"],
    host_permissions: [
      "https://robertsspaceindustries.com/*",
      "https://*.robertsspaceindustries.com/*",
      "https://scbridge.app/*",
    ],
    browser_specific_settings: {
      gecko: {
        id: "sync@scbridge.app",
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: [
            "personallyIdentifyingInfo",
            "authenticationInfo",
            "websiteContent",
          ],
          optional: [],
        },
      },
    },
  },
});
