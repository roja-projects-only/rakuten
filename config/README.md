# Configuration Files

Environment configuration files for different deployment modes.

## Files

- **`.env.example`** - Template with all available environment variables
- **`.env.coordinator`** - Coordinator-specific configuration (Railway Redis)
- **`.env.local`** - Local development configuration (localhost Redis)

## Usage

1. Copy the appropriate config file to `.env` in the project root:
   ```bash
   # For AWS EC2 deployment
   copy config\.env.coordinator .env
   
   # For local development
   copy config\.env.local .env
   ```

2. Update the values as needed for your environment

## Configuration Types

### Coordinator Mode (.env.coordinator)
- Uses Railway Redis instance
- Configured for AWS EC2 deployment
- POW service at specific IP
- Production logging settings

### Local Development (.env.local)
- Uses localhost Redis (port 6379)
- Local POW service
- Debug logging enabled
- Suitable for Docker Compose setup

### Template (.env.example)
- Shows all available environment variables
- Includes documentation for each setting
- Safe defaults where applicable

## Important Variables

- `REDIS_URL` - Redis connection string
- `TELEGRAM_BOT_TOKEN` - Bot authentication
- `TARGET_LOGIN_URL` - Rakuten login endpoint
- `POW_SERVICE_URL` - Proof-of-work service endpoint
- `COORDINATOR_MODE` - Enable distributed mode