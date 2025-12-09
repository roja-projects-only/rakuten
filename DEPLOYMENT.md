# Rakuten Telegram Credential Checker - Deployment Guide

## Quick Start

### 1. Prerequisites
- Node.js LTS installed
- A Telegram bot token (from BotFather)
- A Windows VPS or local machine to run the service

### 2. Installation

```bash
# Install dependencies
npm install
```

### 3. Configuration

```bash
# Copy and configure the environment file
cp .env.example .env

# Edit .env with your settings:
# - TELEGRAM_BOT_TOKEN: Your bot token from BotFather
# - TARGET_LOGIN_URL: The login page URL to automate
```

### 4. Running Locally

```bash
# Development/testing
npm start
```

The bot will:
- Validate environment variables
- Initialize the Telegram polling listener
- Wait for `.chk username:password` commands

### 5. Deployment on Windows VPS with NSSM

NSSM (Non-Sucking Service Manager) allows running Node.js as a Windows service.

#### Step 1: Install NSSM
```bash
# Download from https://nssm.cc/download
# Extract to a folder, add to PATH, or reference directly
```

#### Step 2: Create Service
```bash
# Using nssm.exe directly (adjust path as needed)
nssm install "RakutenBot" "C:\Program Files\nodejs\node.exe" "C:\path\to\main.js"

# Or if nssm is in PATH:
nssm install "RakutenBot" node "main.js"
```

#### Step 3: Configure Service (optional)
```bash
# Set working directory
nssm set RakutenBot AppDirectory "C:\path\to\rakuten-bot"

# Set environment variables (if needed)
nssm set RakutenBot AppEnvironmentExtra TELEGRAM_BOT_TOKEN=your_token TARGET_LOGIN_URL=https://...

# Set auto-restart on failure
nssm set RakutenBot AppRestartDelay 5000
```

#### Step 4: Start Service
```bash
# Start the service
nssm start RakutenBot

# Stop the service
nssm stop RakutenBot

# Restart the service
nssm restart RakutenBot

# View service status
nssm status RakutenBot

# Remove service (if needed)
nssm remove RakutenBot confirm
```

#### Step 5: Verify
```bash
# Check service logs
nssm edit RakutenBot  # Opens GUI to configure logging

# Or check Application Event Viewer for errors
```

### 6. Using PM2 (Alternative to NSSM)

```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
pm2 start main.js --name "rakuten-bot"

# Save PM2 configuration
pm2 save

# Enable auto-start on system reboot
pm2 startup

# Monitor
pm2 logs rakuten-bot
pm2 status
```

## Usage

Once the bot is running, users can interact with it on Telegram:

```
/start           - Display welcome message and usage instructions

.chk username:password    - Check credentials
                           Example: .chk john@example.com:securepass123
```

### Response Formats

- **✅ VALID**: Credentials are correct
- **❌ INVALID**: Incorrect username or password
- **🔒 BLOCKED**: Captcha, rate limit, or account lockout detected
- **⚠️ ERROR**: Navigation, timeout, or unexpected error

Screenshots are attached for non-valid or error states.

## Architecture

### puppeteerChecker.js
- Launches headless Chrome with Puppeteer
- Automates login flow (navigate, fill, submit)
- Detects outcomes via HTML content/URL matching
- Captures evidence screenshots
- Returns: `{ status, message, evidence? }`

### telegramHandler.js
- Listens for `.chk user:pass` commands
- Validates and parses input
- Orchestrates credential checks
- Formats results with emojis
- Sends Telegram responses and screenshots

### main.js
- Loads environment variables
- Validates required configuration
- Initializes the bot
- Handles graceful shutdown (SIGINT/SIGTERM)

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| TELEGRAM_BOT_TOKEN | ✓ | - | Bot token from BotFather |
| TARGET_LOGIN_URL | ✓ | - | Login page URL to automate |
| TIMEOUT_MS | | 60000 | Puppeteer timeout (ms) |
| PROXY_SERVER | | - | Proxy URL (optional) |
| SCREENSHOT_ON | | false | Always capture screenshots |

## Troubleshooting

### Bot not responding
1. Check TELEGRAM_BOT_TOKEN is valid
2. Verify internet connectivity
3. Check logs: `nssm edit RakutenBot` or `pm2 logs`

### Credential checks timing out
1. Increase TIMEOUT_MS in .env
2. Verify TARGET_LOGIN_URL is correct and accessible
3. Check for captchas or redirects on the target page

### Screenshots not attaching
1. Ensure screenshots/ directory is writable
2. Check disk space
3. Verify Telegram bot has permissions to send files

### NSSM Service not starting
1. Verify Node.js path: `where node`
2. Check working directory path exists
3. Review Application Event Viewer for errors
4. Run Command Prompt as Administrator

## Security Considerations

- **Never commit `.env` file** — it contains sensitive tokens
- **Restrict access** to the bot (only trusted users)
- **Use strong Telegram bot tokens** (regenerate if leaked)
- **Monitor logs** for suspicious activity
- **Use HTTPS proxy** if routing through a proxy
- **Sanitize inputs** (implemented in `guardInput()`)

## License

ISC

