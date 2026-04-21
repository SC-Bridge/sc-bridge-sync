# SC Bridge Sync

Browser extension that syncs your Star Citizen hangar data from RSI to [SC Bridge](https://scbridge.app).

## Install

### Chrome / Brave / Arc

[![Chrome Web Store](https://img.shields.io/badge/Install-Chrome%20Web%20Store-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/sc-bridge-sync/gcokkoamjodagagbojhkimfbjjpdfefi)

Recommended path — one-click install, auto-updates.

<details>
<summary>Manual install (ZIP)</summary>

[![Download ZIP for Chrome](https://img.shields.io/badge/Download%20ZIP-Chrome%20%2F%20Brave%20%2F%20Arc-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://github.com/SC-Bridge/sc-bridge-sync/releases/latest/download/sc-bridge-sync-chrome.zip)

1. Download the ZIP using the button above
2. Unzip the file
3. Open Chrome and navigate to `chrome://extensions`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked** and select the unzipped folder
</details>

### Firefox

[![Firefox Add-ons](https://img.shields.io/badge/Install-Firefox%20Add--ons-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/sc-bridge-sync/)

Recommended path — one-click install, auto-updates.

<details>
<summary>Manual install (ZIP)</summary>

[![Download ZIP for Firefox](https://img.shields.io/badge/Download%20ZIP-Firefox-FF7139?style=flat-square&logo=firefoxbrowser&logoColor=white)](https://github.com/SC-Bridge/sc-bridge-sync/releases/latest/download/sc-bridge-sync-firefox.zip)

1. Download the ZIP using the button above
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Select the downloaded ZIP file (no need to unzip)

> Note: temporary add-ons in Firefox are removed when the browser closes. For permanent install use the Firefox Add-ons store link above.
</details>

### Microsoft Edge

[![Edge Add-ons](https://img.shields.io/badge/Install-Edge%20Add--ons-0078D7?style=for-the-badge&logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/sc-bridge-sync/edndedmmbdbofdphimpcofdccbpbgjib)

Recommended path — one-click install, auto-updates.

<details>
<summary>Manual install (ZIP)</summary>

[![Download ZIP for Edge](https://img.shields.io/badge/Download%20ZIP-Edge-0078D7?style=flat-square&logo=microsoftedge&logoColor=white)](https://github.com/SC-Bridge/sc-bridge-sync/releases/latest/download/sc-bridge-sync-edge.zip)

1. Download the ZIP using the button above
2. Unzip the file
3. Open Edge and navigate to `edge://extensions`
4. Enable **Developer mode** (bottom left)
5. Click **Load unpacked** and select the unzipped folder
</details>

### Opera

Opera doesn't have an SC Bridge Sync store listing — manual sideload is the official path.

[![Download ZIP for Opera](https://img.shields.io/badge/Download%20ZIP-Opera-FF1B2D?style=for-the-badge&logo=opera&logoColor=white)](https://github.com/SC-Bridge/sc-bridge-sync/releases/latest/download/sc-bridge-sync-opera.zip)

1. Download the ZIP using the button above
2. Unzip the file
3. Open Opera and navigate to `opera://extensions`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked** and select the unzipped folder

## Usage

1. Log in to [robertsspaceindustries.com](https://robertsspaceindustries.com)
2. Log in to [scbridge.app](https://scbridge.app)
3. Open your hangar tab at [robertsspaceindustries.com/account/pledges](https://robertsspaceindustries.com/account/pledges) — the extension scrapes this page directly, so it must be open during sync
4. Click the SC Bridge Sync extension icon and select **Open Sync & Import** to jump to SC Bridge
5. Follow the on-screen instructions to sync your hangar

## Features

- Filter pledges by type (Ships, CCUs, Flair, Weapons, Armour) and status (LTI, Warbond, Giftable, etc.)
- Search across all pledges
- View total pledge value
- Export to JSON or CSV
- Sync to SC Bridge for fleet tracking, insurance tracking, and analysis
- Privacy modes (Off / Hidden / Stealth) to anonymise pledge values during streaming / screenshots

## License

[MIT](LICENSE)
