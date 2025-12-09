# 🚀 Quick Start Guide

## Prerequisites

- Node.js 16+ installed
- Telegram account
- Telegram Bot Token from [@BotFather](https://t.me/botfather)

## Setup (5 minutes)

### 1. Install Dependencies

```powershell
npm install
```

### 2. Configure Environment

Copy the example file:
```powershell
Copy-Item .env.example .env
```

Edit `.env` and add your bot token:
```env
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
```

### 3. Start the Bot

```powershell
npm start
```

You should see:
```
✓ Environment variables validated.
✓ Telegram bot initialized.
✓ Polling for messages...
```

## Usage

### 1. Start the Bot

In Telegram, send to your bot:
```
/start
```

You'll get a welcome message with instructions.

### 2. Check Credentials

Send this format:
```
.chk username:password
```

**Example:**
```
.chk john@example.com:mypassword123
```

### 3. Watch Live Updates

The bot will edit its message with status updates:
```
⏳ CHECKING CREDENTIALS
🔄 Launching browser...

⏳ CHECKING CREDENTIALS
🌐 Navigating to login page...

✅ VALID CREDENTIALS
👤 Account: joh***om
📝 Login successful - Valid credentials
📸 Screenshot attached
```

### 4. Get Screenshot Evidence

For non-valid results, you'll automatically receive a screenshot showing the exact error.

## Features

### ✨ Rich Formatting
- **Markdown enabled** - Bold, italic, code blocks
- **Status emojis** - Visual status indicators
- **Masked credentials** - Privacy protection
- **Live updates** - Message editing in real-time

### 🎮 Interactive Buttons
After valid checks:
- `✅ Save to File` - Save valid accounts
- `📋 Copy Account` - Quick copy hint
- `🔄 Check Another` - Start new check

### 📸 Evidence Collection
- Screenshots saved to `screenshots/` folder
- Sent to Telegram automatically
- Timestamped filenames

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message & guide |
| `/help` | Show help & status codes |
| `.chk user:pass` | Check credentials |

## Status Indicators

| Emoji | Status | Meaning |
|-------|--------|---------|
| ✅ | VALID | Credentials are correct |
| ❌ | INVALID | Wrong username/password |
| 🔒 | BLOCKED | Account locked or captcha |
| ⚠️ | ERROR | Technical error occurred |

## Troubleshooting

### Bot doesn't respond
1. Check bot is running (`npm start`)
2. Verify `TELEGRAM_BOT_TOKEN` in `.env`
3. Make sure you sent `/start` first

### "Invalid format" error
- Format must be: `.chk username:password`
- Space after `.chk`
- Colon `:` between username and password
- Max 200 characters

### Timeout errors
- Increase `TIMEOUT_MS` in `.env`
- Check internet connection
- Try again later

## Advanced Configuration

### Custom Timeout
```env
TIMEOUT_MS=120000  # 2 minutes
```

### Enable Screenshots for All Checks
```env
SCREENSHOT_ON=true
```

### Use Proxy
```env
PROXY_SERVER=http://proxy.example.com:8080
```

## Example Session

```
You: /start
Bot: 🎯 RAKUTEN CREDENTIAL CHECKER
     How to use: .chk username:password

You: .chk test@example.com:wrongpass
Bot: ⏳ CHECKING CREDENTIALS
     🔄 Launching browser...
     
Bot: [edits message]
     ⏳ CHECKING CREDENTIALS
     🌐 Navigating to login page...
     
Bot: [edits message]
     ❌ INVALID CREDENTIALS
     👤 Account: tes***om
     📝 Invalid credentials - Username and/or password are incorrect
     📸 Screenshot attached
     
Bot: [sends screenshot]

You: .chk valid@user.com:correctpass
Bot: ✅ VALID CREDENTIALS
     👤 Account: val***om
     📝 Login successful - Valid credentials
     
Bot: 💡 Quick Actions
     [✅ Save to File] [📋 Copy Account]
     [🔄 Check Another]
```

## Need Help?

- Check logs in terminal
- Review error messages
- Contact bot administrator

---

**🎉 You're all set! Start checking credentials now!**
