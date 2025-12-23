# Setup Scripts

Scripts for setting up and configuring the distributed system.

## Files

- **`fix-coordinator.bat`** - Main coordinator setup script (Windows batch)
- **`fix-coordinator-aws.ps1`** - AWS EC2 specific coordinator setup (PowerShell)
- **`fix-coordinator-issue.ps1`** - Original coordinator issue fix (Docker-based)
- **`fix-coordinator-simple.ps1`** - Simplified coordinator setup (PowerShell)
- **`test-coordinator-local.ps1`** - Test coordinator with local Redis
- **`start-redis-only.bat`** - Start only Redis container for local development

## Usage

### For AWS EC2 (Recommended)
```bash
.\scripts\setup\fix-coordinator.bat
```

### For Local Development with Docker
```bash
.\scripts\setup\fix-coordinator-issue.ps1
```

### For Testing
```bash
.\scripts\setup\test-coordinator-local.ps1
```

## Purpose

These scripts automate:
- Environment variable loading
- Redis connection testing
- Problematic data cleanup
- Coordinator startup in distributed mode
- System health verification

## Prerequisites

- Node.js installed
- Redis instance accessible (local or remote)
- Environment variables configured in `.env` files