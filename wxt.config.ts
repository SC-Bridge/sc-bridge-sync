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
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: true,
          personally_identifiable_information: {
            collected: true,
            purpose: "Collects RSI handle and display name to link your RSI account with SC Bridge.",
          },
          health_information: { collected: false },
          financial_and_payment_information: { collected: false },
          authentication_information: {
            collected: true,
            purpose: "Reads the RSI authentication cookie to make authenticated requests on your behalf.",
          },
          personal_communications: { collected: false },
          location: { collected: false },
          web_history: { collected: false },
          user_activity: { collected: false },
          website_content: {
            collected: true,
            purpose: "Scrapes pledge, ship, insurance, and buy-back data from RSI hangar pages.",
          },
          technical_and_interaction_data: { collected: false },
        },
      },
    },
  },
});
