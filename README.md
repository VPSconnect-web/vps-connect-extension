# 🚀 VPS Connect

Chrome extension for easy one-click connection to your VPS server with JWT authentication.

## ✨ Features

- 🔐 JWT Authentication
- 🚀 One-click server connection
- 🎯 Selective routing (all sites or selected sites only)
- 📋 Whitelist management with wildcard support
- 🔔 Visual status indicator

## 📦 Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/PocketVPS/vps-connect-extension.git
   cd vps-connect-extension
   ```
   OR
   Download the latest release from [Releases](https://github.com/PocketVPS/vps-connect-extension/releases)

2. 🤌🤌🤌 **Install in browser**
   - ⚠️ Open your browser and go to `browser://extensions`
   - Enable **Developer mode** (toggle in top right corner)
   - Click **Load unpacked**
   - Select the `vps-connect-extension` folder

3. **Configure VPS server**
   - Edit `background/proxy-config.js`
   - Update `host` and `port` to match your VPS server

## 🚀 Usage

1. Click the VPS Connect icon in your browser toolbar
2. Register or login with your credentials
3. Click "Подключиться" (Connect) to activate
4. Choose connection mode:
   - **Все сайты** (All Sites) - route all traffic through your server
   - **Выбранные сайты** (Selected Sites) - route only selected URLs
5. Add URLs to your list as needed (e.g., `youtube.com`, `*.google.com`)

## 💵 Price
The price for 1 month is about $1 - $2

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

## Privacy Policy Publishing

To keep this repository private and still publish a public privacy policy page, use a second public GitHub repository for GitHub Pages.

1. Create a public repository that will host the static page.
   Example: `vpsconnect-web/vps-connect-extension`
2. In that public repository, enable GitHub Pages from the `main` branch root.
3. In this private repository, add:
   - repository variable `PUBLIC_PAGES_REPOSITORY` with the value `vpsconnect-web/vps-connect-extension`
   - optional repository variable `PUBLIC_PAGES_BRANCH` if the public repo uses a branch other than `main`
   - repository secret `PUBLIC_PAGES_TOKEN` with a fine-grained personal access token that has `Contents: Read and write` access to the public repository
4. Push changes to `main` or run the `Deploy Privacy Policy` workflow manually.

The workflow publishes only `docs/privacy-policy.html` into the public repository, so the rest of this private repository remains private.
