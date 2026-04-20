package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/charmbracelet/lipgloss"
)

var (
	// Styles
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("205")).
			Background(lipgloss.Color("235")).
			Padding(0, 1)

	menuStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("252"))

	selectedStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("229"))

	successStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("82"))

	errorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("196"))

	dimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("240"))

	headerStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("117"))
)

func main() {
	// Parse flags
	configPath := flag.String("config", "", "Path to config file")
	command := flag.String("c", "", "Direct command: status, restart, stop, update, logs, cleanup")
	instance := flag.String("i", "", "Instance name (for direct commands)")
	all := flag.Bool("all", false, "Apply to all instances")
	parallel := flag.Bool("parallel", true, "Run operations in parallel")
	flag.Parse()

	// Find config file
	configFile := *configPath
	if configFile == "" {
		// Try default locations
		candidates := []string{
			"config.yaml",
			filepath.Join("tools", "rakuten-manager", "config.yaml"),
			filepath.Join(os.Getenv("HOME"), ".rakuten-manager", "config.yaml"),
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				configFile = c
				break
			}
		}
	}

	if configFile == "" {
		fmt.Println(errorStyle.Render("Error: config.yaml not found"))
		fmt.Println("Create config.yaml or specify with -config flag")
		os.Exit(1)
	}

	config, err := LoadConfig(configFile)
	if err != nil {
		fmt.Println(errorStyle.Render(fmt.Sprintf("Error loading config: %v", err)))
		os.Exit(1)
	}

	ops := NewOperations(config)
	_ = parallel // Will use for future optimization

	// Handle direct command mode
	if *command != "" {
		runDirectCommand(ops, config, *command, *instance, *all)
		return
	}

	// Interactive menu mode
	runInteractiveMenu(ops, config)
}

func runDirectCommand(ops *Operations, config *Config, command, instanceName string, all bool) {
	switch command {
	case "status":
		if all {
			printAllStatus(ops)
		} else if instanceName != "" {
			inst := config.GetInstance(instanceName)
			if inst == nil {
				fmt.Println(errorStyle.Render(fmt.Sprintf("Instance not found: %s", instanceName)))
				return
			}
			result, err := ops.GetStatus(inst)
			if err != nil {
				fmt.Println(errorStyle.Render(err.Error()))
				return
			}
			fmt.Println(result.Output)
		} else {
			printAllStatus(ops)
		}

	case "restart":
		if all {
			fmt.Println("Restarting all containers...")
			results := ops.RestartAll()
			printResults(results)
		} else if instanceName != "" {
			inst := config.GetInstance(instanceName)
			if inst == nil {
				fmt.Println(errorStyle.Render(fmt.Sprintf("Instance not found: %s", instanceName)))
				return
			}
			fmt.Printf("Restarting %s...\n", inst.Name)
			result, err := ops.RestartContainer(inst)
			if err != nil {
				fmt.Println(errorStyle.Render(err.Error()))
				return
			}
			fmt.Println(successStyle.Render(fmt.Sprintf("✓ %s restarted (%s)", inst.Name, result.Duration)))
		}

	case "stop":
		if all {
			fmt.Println("Stopping all containers...")
			results := ops.StopAll()
			printResults(results)
		} else if instanceName != "" {
			inst := config.GetInstance(instanceName)
			if inst == nil {
				fmt.Println(errorStyle.Render(fmt.Sprintf("Instance not found: %s", instanceName)))
				return
			}
			fmt.Printf("Stopping %s...\n", inst.Name)
			result, err := ops.StopContainer(inst)
			if err != nil {
				fmt.Println(errorStyle.Render(err.Error()))
				return
			}
			fmt.Println(successStyle.Render(fmt.Sprintf("✓ %s stopped (%s)", inst.Name, result.Duration)))
		}

	case "update":
		if all {
			fmt.Println("Updating all instances (this may take several minutes)...")
			results := ops.UpdateAll()
			printResults(results)
		} else if instanceName == "workers" {
			fmt.Printf("Updating all %d workers...\n", len(config.GetWorkers()))
			results := ops.UpdateAllWorkers()
			printResults(results)
		} else if instanceName != "" {
			inst := config.GetInstance(instanceName)
			if inst == nil {
				fmt.Println(errorStyle.Render(fmt.Sprintf("Instance not found: %s", instanceName)))
				return
			}
			fmt.Printf("Updating %s...\n", inst.Name)
			result, err := ops.UpdateInstance(inst)
			if err != nil {
				fmt.Println(errorStyle.Render(err.Error()))
				return
			}
			fmt.Println(result.Output)
			fmt.Println(successStyle.Render(fmt.Sprintf("✓ %s updated (%s)", inst.Name, result.Duration)))
		}

	case "logs":
		if instanceName == "" {
			fmt.Println(errorStyle.Render("Please specify instance with -i flag"))
			return
		}
		inst := config.GetInstance(instanceName)
		if inst == nil {
			fmt.Println(errorStyle.Render(fmt.Sprintf("Instance not found: %s", instanceName)))
			return
		}
		result, err := ops.GetLogs(inst, 50)
		if err != nil {
			fmt.Println(errorStyle.Render(err.Error()))
			return
		}
		fmt.Println(result.Output)

	case "cleanup":
		if all {
			fmt.Println("Cleaning up Docker on all instances...")
			results := ops.CleanupAll()
			printResults(results)
		} else if instanceName != "" {
			inst := config.GetInstance(instanceName)
			if inst == nil {
				fmt.Println(errorStyle.Render(fmt.Sprintf("Instance not found: %s", instanceName)))
				return
			}
			fmt.Printf("Cleaning up Docker on %s...\n", inst.Name)
			result, err := ops.DockerCleanup(inst)
			if err != nil {
				fmt.Println(errorStyle.Render(err.Error()))
				return
			}
			fmt.Println(successStyle.Render(fmt.Sprintf("✓ %s cleaned (%s)", inst.Name, result.Duration)))
		}

	default:
		fmt.Println(errorStyle.Render(fmt.Sprintf("Unknown command: %s", command)))
		fmt.Println("Available commands: status, restart, stop, update, logs, cleanup")
	}
}

func runInteractiveMenu(ops *Operations, config *Config) {
	for {
		clearScreen()
		printHeader()
		printInstances(config)
		printMenu()

		choice := readInput("Enter your choice: ")
		handleMenuChoice(ops, config, choice)
	}
}

func printHeader() {
	fmt.Println()
	fmt.Println(titleStyle.Render(" RAKUTEN DISTRIBUTED SYSTEM MANAGER "))
	fmt.Println()
}

func printInstances(config *Config) {
	fmt.Println(headerStyle.Render("INSTANCES:"))
	for i, inst := range config.Instances {
		typeIcon := "👷"
		if inst.Type == "coordinator" {
			typeIcon = "🎯"
		} else if inst.Type == "pow" {
			typeIcon = "⚡"
		}
		fmt.Printf("  [%d] %s %-14s (%s)\n", i+1, typeIcon, inst.Name, inst.Host)
	}
	fmt.Println()
}

func printMenu() {
	fmt.Println(headerStyle.Render("ACTIONS:"))
	fmt.Println("  [L] View Logs          - Stream logs from instance")
	fmt.Println("  [S] SSH Shell          - Open interactive shell")
	fmt.Println("  [R] Restart Container  - Restart docker container")
	fmt.Println("  [T] Stop Container     - Stop docker container")
	fmt.Println("  [I] Instance Info      - Show status and recent logs")
	fmt.Println()
	fmt.Println(headerStyle.Render("BULK OPERATIONS:"))
	fmt.Println("  [A] Check All Status   - Show status of all instances")
	fmt.Println("  [B] Restart All        - Restart all containers")
	fmt.Println("  [C] Stop All           - Stop all containers")
	fmt.Println("  [D] Docker Cleanup     - Clean all Docker data")
	fmt.Println()
	fmt.Println(headerStyle.Render("LOGS (popup windows):"))
	fmt.Println("  [P] Pop All Logs       - Open log windows for all instances")
	fmt.Println("  [O] Pop Worker Logs    - Open log windows for workers only")
	fmt.Println()
	fmt.Println(headerStyle.Render("UPDATES:"))
	fmt.Println("  [U] Update Instance    - Run quick-update.sh on one")
	fmt.Println("  [W] Update All Workers - Update workers only (faster)")
	fmt.Println("  [V] Update All         - Run quick-update.sh on all")
	fmt.Println()
	fmt.Println("  [Q] Quit")
	fmt.Println()
}

func handleMenuChoice(ops *Operations, config *Config, choice string) {
	choice = strings.ToUpper(strings.TrimSpace(choice))

	switch choice {
	case "Q", "0":
		fmt.Println("Goodbye!")
		os.Exit(0)

	case "A":
		fmt.Println("\nChecking all instances...")
		printAllStatus(ops)
		waitForKey()

	case "B":
		fmt.Print("\nRestart all containers? (y/N): ")
		if confirm := readInput(""); strings.ToLower(confirm) == "y" {
			fmt.Println("Restarting all containers...")
			results := ops.RestartAll()
			printResults(results)
		}
		waitForKey()

	case "C":
		fmt.Print("\nStop all containers? (y/N): ")
		if confirm := readInput(""); strings.ToLower(confirm) == "y" {
			fmt.Println("Stopping all containers...")
			results := ops.StopAll()
			printResults(results)
		}
		waitForKey()

	case "D":
		fmt.Print("\nClean Docker on all instances? This will remove ALL data. (y/N): ")
		if confirm := readInput(""); strings.ToLower(confirm) == "y" {
			fmt.Println("Cleaning Docker on all instances...")
			results := ops.CleanupAll()
			printResults(results)
		}
		waitForKey()

	case "P":
		fmt.Printf("\nOpening %d log windows...\n", len(config.Instances))
		openLogWindows(config, config.Instances)
		fmt.Println(successStyle.Render("Log windows opened!"))
		waitForKey()

	case "O":
		workers := config.GetWorkers()
		fmt.Printf("\nOpening %d worker log windows...\n", len(workers))
		openLogWindows(config, workers)
		fmt.Println(successStyle.Render("Worker log windows opened!"))
		waitForKey()

	case "W":
		workers := config.GetWorkers()
		fmt.Printf("\nUpdate all %d workers? This may take 3-5 minutes. (y/N): ", len(workers))
		if confirm := readInput(""); strings.ToLower(confirm) == "y" {
			fmt.Printf("Updating %d workers in parallel...\n\n", len(workers))
			var completed int
			results := ops.UpdateAllWorkersWithProgress(func(r Result) {
				completed++
				if r.Error != nil {
					fmt.Printf("  [%d/%d] %-14s %s\n", completed, len(workers), r.Instance.Name, errorStyle.Render("✗ "+r.Error.Error()))
				} else {
					fmt.Printf("  [%d/%d] %-14s %s\n", completed, len(workers), r.Instance.Name, successStyle.Render(fmt.Sprintf("✓ done (%s)", r.Duration.Round(time.Millisecond))))
				}
			})
			fmt.Println()
			printResultsSummary(results)
		}
		waitForKey()

	case "V":
		fmt.Print("\nUpdate all instances? This may take 5-10 minutes. (y/N): ")
		if confirm := readInput(""); strings.ToLower(confirm) == "y" {
			total := len(config.Instances)
			fmt.Printf("Updating %d instances in parallel...\n\n", total)
			var completed int
			results := ops.UpdateAllWithProgress(func(r Result) {
				completed++
				if r.Error != nil {
					fmt.Printf("  [%d/%d] %-14s %s\n", completed, total, r.Instance.Name, errorStyle.Render("✗ "+r.Error.Error()))
				} else {
					fmt.Printf("  [%d/%d] %-14s %s\n", completed, total, r.Instance.Name, successStyle.Render(fmt.Sprintf("✓ done (%s)", r.Duration.Round(time.Millisecond))))
				}
			})
			fmt.Println()
			printResultsSummary(results)
		}
		waitForKey()

	case "L", "S", "R", "T", "I", "U":
		// Need to select instance
		fmt.Printf("\nSelect instance (1-%d): ", len(config.Instances))
		instNum := readInput("")
		idx, err := strconv.Atoi(instNum)
		if err != nil || idx < 1 || idx > len(config.Instances) {
			fmt.Println(errorStyle.Render("Invalid instance number"))
			waitForKey()
			return
		}
		inst := &config.Instances[idx-1]

		switch choice {
		case "L":
			streamLogs(ops, config, inst)
		case "S":
			openSSH(config, inst)
		case "R":
			fmt.Printf("Restarting %s...\n", inst.Name)
			result, err := ops.RestartContainer(inst)
			if err != nil {
				fmt.Println(errorStyle.Render(err.Error()))
			} else {
				fmt.Println(successStyle.Render(fmt.Sprintf("✓ Restarted (%s)", result.Duration)))
			}
			waitForKey()
		case "T":
			fmt.Printf("Stopping %s...\n", inst.Name)
			result, err := ops.StopContainer(inst)
			if err != nil {
				fmt.Println(errorStyle.Render(err.Error()))
			} else {
				fmt.Println(successStyle.Render(fmt.Sprintf("✓ Stopped (%s)", result.Duration)))
			}
			waitForKey()
		case "I":
			showInstanceInfo(ops, inst)
			waitForKey()
		case "U":
			fmt.Printf("Updating %s...\n", inst.Name)
			result, err := ops.UpdateInstance(inst)
			if err != nil {
				fmt.Println(errorStyle.Render(err.Error()))
			} else {
				fmt.Println(result.Output)
				fmt.Println(successStyle.Render(fmt.Sprintf("\n✓ Updated (%s)", result.Duration)))
			}
			waitForKey()
		}

	default:
		// Check if it's a number (direct instance selection)
		idx, err := strconv.Atoi(choice)
		if err == nil && idx >= 1 && idx <= len(config.Instances) {
			inst := &config.Instances[idx-1]
			showInstanceInfo(ops, inst)
			waitForKey()
		}
	}
}

func streamLogs(ops *Operations, config *Config, inst *Instance) {
	fmt.Printf("\nStreaming logs from %s (Ctrl+C to stop)...\n\n", inst.Name)

	client := NewSSHClient(config, inst)
	if err := client.Connect(); err != nil {
		fmt.Println(errorStyle.Render(err.Error()))
		waitForKey()
		return
	}
	defer client.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handle Ctrl+C
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		cancel()
	}()

	client.StreamLogs(ctx, inst.Container, 100, os.Stdout)
}

func openSSH(config *Config, inst *Instance) {
	fmt.Printf("\nConnecting to %s...\n", inst.Name)

	client := NewSSHClient(config, inst)
	if err := client.Connect(); err != nil {
		fmt.Println(errorStyle.Render(err.Error()))
		waitForKey()
		return
	}
	defer client.Close()

	if err := client.RunInteractive(); err != nil {
		fmt.Println(errorStyle.Render(err.Error()))
	}
}

func showInstanceInfo(ops *Operations, inst *Instance) {
	fmt.Printf("\n%s %s (%s)\n", headerStyle.Render("INSTANCE:"), inst.Name, inst.Host)
	fmt.Println(strings.Repeat("─", 50))

	// Get status
	result, err := ops.GetStatus(inst)
	if err != nil {
		fmt.Println(errorStyle.Render(fmt.Sprintf("Status: %v", err)))
	} else {
		fmt.Println(result.Output)
	}

	// Get recent logs
	fmt.Println("\n" + headerStyle.Render("Recent Logs (last 20 lines):"))
	logsResult, err := ops.GetLogs(inst, 20)
	if err != nil {
		fmt.Println(errorStyle.Render(err.Error()))
	} else {
		fmt.Println(dimStyle.Render(logsResult.Output))
	}
}

func printAllStatus(ops *Operations) {
	results := ops.GetAllStatus()
	fmt.Println()
	fmt.Println(headerStyle.Render("INSTANCE STATUS:"))
	fmt.Println(strings.Repeat("─", 60))

	for _, r := range results {
		status := "?"
		style := dimStyle
		if r.Error != nil {
			status = "✗ " + r.Error.Error()
			style = errorStyle
		} else if strings.Contains(r.Output, "Up") {
			status = "✓ " + r.Output
			style = successStyle
		} else if r.Output != "" {
			status = "○ " + r.Output
			style = dimStyle
		}

		fmt.Printf("  %-14s %s\n", r.Instance.Name, style.Render(status))
	}
}

func printResults(results []Result) {
	fmt.Println()
	for _, r := range results {
		if r.Error != nil {
			fmt.Printf("  %-14s %s\n", r.Instance.Name, errorStyle.Render("✗ "+r.Error.Error()))
		} else {
			fmt.Printf("  %-14s %s\n", r.Instance.Name, successStyle.Render(fmt.Sprintf("✓ done (%s)", r.Duration.Round(time.Millisecond))))
		}
	}
}

func printResultsSummary(results []Result) {
	var succeeded, failed int
	for _, r := range results {
		if r.Error != nil {
			failed++
		} else {
			succeeded++
		}
	}
	if failed == 0 {
		fmt.Println(successStyle.Render(fmt.Sprintf("All %d instances updated successfully!", succeeded)))
	} else {
		fmt.Printf("%s, %s\n",
			successStyle.Render(fmt.Sprintf("%d succeeded", succeeded)),
			errorStyle.Render(fmt.Sprintf("%d failed", failed)))
	}
}

// openLogWindows opens separate terminal windows for each instance showing docker logs
func openLogWindows(config *Config, instances []Instance) {
	for _, inst := range instances {
		keyPath := config.GetKeyPath(&inst)
		
		// Convert to absolute path
		absKeyPath, err := filepath.Abs(keyPath)
		if err == nil {
			keyPath = absKeyPath
		}

		var cmd *exec.Cmd
		switch runtime.GOOS {
		case "windows":
			// Windows: use PowerShell Start-Process to spawn new window
			sshArgs := fmt.Sprintf(`-i "%s" -o StrictHostKeyChecking=no %s@%s "docker logs -f --tail=100 %s"`,
				keyPath, inst.User, inst.Host, inst.Container)
			// PowerShell command to start SSH in new window with title
			psCmd := fmt.Sprintf(`$host.UI.RawUI.WindowTitle='%s'; ssh %s; Read-Host 'Press Enter to close'`,
				inst.Name, sshArgs)
			cmd = exec.Command("powershell", "-Command", 
				fmt.Sprintf(`Start-Process powershell -ArgumentList '-NoExit','-Command','%s'`, 
					strings.ReplaceAll(psCmd, "'", "''")))
		case "darwin":
			// macOS: use osascript to open Terminal
			keyPath = strings.ReplaceAll(keyPath, "\\", "/")
			sshCmd := fmt.Sprintf(`ssh -i "%s" -o StrictHostKeyChecking=no %s@%s "docker logs -f --tail=100 %s"`,
				keyPath, inst.User, inst.Host, inst.Container)
			script := fmt.Sprintf(`tell application "Terminal" to do script "%s"`, strings.ReplaceAll(sshCmd, `"`, `\"`))
			cmd = exec.Command("osascript", "-e", script)
		default:
			// Linux: try common terminal emulators
			keyPath = strings.ReplaceAll(keyPath, "\\", "/")
			sshCmd := fmt.Sprintf(`ssh -i "%s" -o StrictHostKeyChecking=no %s@%s "docker logs -f --tail=100 %s"`,
				keyPath, inst.User, inst.Host, inst.Container)
			cmd = exec.Command("gnome-terminal", "--", "bash", "-c", sshCmd+"; read -p 'Press Enter to close'")
		}

		if err := cmd.Start(); err != nil {
			fmt.Printf("  %s: %s\n", inst.Name, errorStyle.Render(err.Error()))
		} else {
			fmt.Printf("  %s: %s\n", inst.Name, successStyle.Render("window opened"))
		}
		
		// Small delay between window spawns to avoid overwhelming the system
		time.Sleep(200 * time.Millisecond)
	}
}

func clearScreen() {
	fmt.Print("\033[H\033[2J")
}

func readInput(prompt string) string {
	if prompt != "" {
		fmt.Print(prompt)
	}
	var input string
	fmt.Scanln(&input)
	return input
}

func waitForKey() {
	fmt.Print("\nPress Enter to continue...")
	readInput("")
}
