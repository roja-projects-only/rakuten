# Rakuten Manager

A Go-based CLI tool for managing the Rakuten distributed credential checking system.

## Features

- **Cross-platform**: Single binary for Windows, Mac, Linux
- **Parallel operations**: Update/restart all instances simultaneously
- **Interactive TUI**: Clean terminal interface
- **CLI mode**: Direct commands for scripting
- **SSH integration**: Native Go SSH (no external dependencies)

## Installation

### Build from source

```bash
cd tools/rakuten-manager
go mod tidy
go build -o rakuten-manager.exe .   # Windows
go build -o rakuten-manager .        # Mac/Linux
```

### Cross-compile

```bash
# Windows
GOOS=windows GOARCH=amd64 go build -o rakuten-manager.exe .

# Mac (Intel)
GOOS=darwin GOARCH=amd64 go build -o rakuten-manager-mac .

# Mac (Apple Silicon)
GOOS=darwin GOARCH=arm64 go build -o rakuten-manager-mac-arm .

# Linux
GOOS=linux GOARCH=amd64 go build -o rakuten-manager-linux .
```

## Usage

### Interactive Mode

```bash
./rakuten-manager
```

This opens an interactive menu where you can:
- View logs from any instance
- Open SSH shells
- Restart/stop containers
- Update instances
- Check status of all instances

### CLI Mode

```bash
# Check status of all instances
./rakuten-manager -c status -all

# Check single instance
./rakuten-manager -c status -i worker-1

# Restart all containers
./rakuten-manager -c restart -all

# Restart single container
./rakuten-manager -c restart -i coordinator

# Update all instances (parallel)
./rakuten-manager -c update -all

# Update single instance
./rakuten-manager -c update -i worker-3

# View logs
./rakuten-manager -c logs -i coordinator

# Stop all
./rakuten-manager -c stop -all

# Docker cleanup
./rakuten-manager -c cleanup -all
```

### Configuration

Edit `config.yaml` to customize instances:

```yaml
instances:
  - name: worker-1
    host: 52.197.138.132
    user: ubuntu
    key: rakuten.pem
    type: worker
    container: rakuten-worker

  - name: coordinator
    host: 43.207.4.202
    user: ubuntu
    key: rakuten.pem
    type: coordinator
    container: rakuten-coordinator

defaults:
  workdir: /home/ubuntu/rakuten
  connectTimeout: 10s
  commandTimeout: 300s
```

### SSH Keys

Place SSH keys (`rakuten.pem`, `rakuten2.pem`) in the same directory as the config file or specify absolute paths.

## Commands

| Command | Description |
|---------|-------------|
| `status` | Show container status |
| `restart` | Restart container(s) |
| `stop` | Stop container(s) |
| `update` | Run quick-update.sh script |
| `logs` | View recent container logs |
| `cleanup` | Docker system prune |

## Flags

| Flag | Description |
|------|-------------|
| `-c` | Command to run |
| `-i` | Instance name |
| `-all` | Apply to all instances |
| `-config` | Path to config file |

## Menu Shortcuts

| Key | Action |
|-----|--------|
| `1-8` | Select instance |
| `L` | View logs |
| `S` | SSH shell |
| `R` | Restart container |
| `T` | Stop container |
| `I` | Instance info |
| `A` | Check all status |
| `B` | Restart all |
| `C` | Stop all |
| `D` | Docker cleanup all |
| `U` | Update instance |
| `V` | Update all |
| `Q` | Quit |

## Comparison with ssh-logs.bat

| Feature | ssh-logs.bat | rakuten-manager |
|---------|-------------|-----------------|
| Platform | Windows only | Windows, Mac, Linux |
| Dependencies | External SSH | None (built-in) |
| Parallel ops | CMD windows | Native goroutines |
| Error handling | Basic | Comprehensive |
| Progress | Manual check | Real-time feedback |
| Scripting | Limited | Full CLI support |
