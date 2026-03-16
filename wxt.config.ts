import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  manifest: {
    name: "SC Bridge Sync",
    description:
      "Syncs your Star Citizen hangar data from RSI to SC Bridge. Ships, insurance, pledges, CCU chains, and custom ship names.",
    permissions: ["cookies", "storage", "tabs"],
    host_permissions: [
      "https://robertsspaceindustries.com/*",
      "https://*.robertsspaceindustries.com/*",
      "https://scbridge.app/*",
    ],
    browser_specific_settings: {
      gecko: {
        id: "sync@scbridge.app",
        strict_min_version: "128.0",
        data_collection_permissions: {
          personally_identifiable_information: true,
          health_information: false,
          financial_and_payment_information: false,
          authentication_information: true,
          personal_communications: false,
          location: false,
          web_history: false,
          user_activity: false,
          website_content: true,
          technical_and_interaction_data: false,
        },
      },
    },
  },
});
