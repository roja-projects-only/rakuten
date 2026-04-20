package main

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Operations provides instance management operations
type Operations struct {
	config *Config
}

// NewOperations creates a new operations manager
func NewOperations(config *Config) *Operations {
	return &Operations{config: config}
}

// GetStatus gets container status for an instance
func (o *Operations) GetStatus(instance *Instance) (*Result, error) {
	client := NewSSHClient(o.config, instance)
	if err := client.Connect(); err != nil {
		return nil, err
	}
	defer client.Close()

	start := time.Now()
	cmd := fmt.Sprintf("docker ps -a --filter name=%s --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'", instance.Container)
	output, err := client.Run(cmd)

	return &Result{
		Instance: instance,
		Output:   strings.TrimSpace(output),
		Error:    err,
		Duration: time.Since(start),
	}, nil
}

// RestartContainer restarts a container
func (o *Operations) RestartContainer(instance *Instance) (*Result, error) {
	client := NewSSHClient(o.config, instance)
	if err := client.Connect(); err != nil {
		return nil, err
	}
	defer client.Close()

	start := time.Now()
	cmd := fmt.Sprintf("docker restart %s", instance.Container)
	output, err := client.Run(cmd)

	return &Result{
		Instance: instance,
		Output:   strings.TrimSpace(output),
		Error:    err,
		Duration: time.Since(start),
	}, nil
}

// StopContainer stops a container
func (o *Operations) StopContainer(instance *Instance) (*Result, error) {
	client := NewSSHClient(o.config, instance)
	if err := client.Connect(); err != nil {
		return nil, err
	}
	defer client.Close()

	start := time.Now()
	cmd := fmt.Sprintf("docker stop %s", instance.Container)
	output, err := client.Run(cmd)

	return &Result{
		Instance: instance,
		Output:   strings.TrimSpace(output),
		Error:    err,
		Duration: time.Since(start),
	}, nil
}

// UpdateInstance runs the update steps directly (no log streaming)
func (o *Operations) UpdateInstance(instance *Instance) (*Result, error) {
	client := NewSSHClient(o.config, instance)
	if err := client.Connect(); err != nil {
		return nil, err
	}
	defer client.Close()

	start := time.Now()
	cmd := buildUpdateCommand(o.config.Defaults.Workdir, instance.Type, instance.Container)

	ctx, cancel := context.WithTimeout(context.Background(), o.config.Defaults.CommandTimeout)
	defer cancel()

	output, err := client.RunWithTimeout(ctx, cmd)

	return &Result{
		Instance: instance,
		Output:   strings.TrimSpace(output),
		Error:    err,
		Duration: time.Since(start),
	}, nil
}

// GetLogs gets recent logs from container
func (o *Operations) GetLogs(instance *Instance, tail int) (*Result, error) {
	client := NewSSHClient(o.config, instance)
	if err := client.Connect(); err != nil {
		return nil, err
	}
	defer client.Close()

	start := time.Now()
	cmd := fmt.Sprintf("docker logs --tail=%d %s 2>&1", tail, instance.Container)
	output, err := client.Run(cmd)

	return &Result{
		Instance: instance,
		Output:   output,
		Error:    err,
		Duration: time.Since(start),
	}, nil
}

// DockerCleanup performs docker system prune
func (o *Operations) DockerCleanup(instance *Instance) (*Result, error) {
	client := NewSSHClient(o.config, instance)
	if err := client.Connect(); err != nil {
		return nil, err
	}
	defer client.Close()

	start := time.Now()
	cmd := "docker stop $(docker ps -aq) 2>/dev/null; docker rm $(docker ps -aq) 2>/dev/null; docker system prune -af --volumes"
	output, err := client.Run(cmd)

	return &Result{
		Instance: instance,
		Output:   strings.TrimSpace(output),
		Error:    err,
		Duration: time.Since(start),
	}, nil
}

// GetAllStatus gets status of all instances in parallel
func (o *Operations) GetAllStatus() []Result {
	return RunParallel(o.config, o.config.Instances, func(inst *Instance) string {
		return fmt.Sprintf("docker ps -a --filter name=%s --format '{{.Status}}'", inst.Container)
	})
}

// RestartAll restarts all containers in parallel
func (o *Operations) RestartAll() []Result {
	return RunParallel(o.config, o.config.Instances, func(inst *Instance) string {
		return fmt.Sprintf("docker restart %s", inst.Container)
	})
}

// StopAll stops all containers in parallel
func (o *Operations) StopAll() []Result {
	return RunParallel(o.config, o.config.Instances, func(inst *Instance) string {
		return fmt.Sprintf("docker stop %s", inst.Container)
	})
}

// UpdateAll updates all instances in parallel
func (o *Operations) UpdateAll() []Result {
	return o.UpdateAllWithProgress(nil)
}

// UpdateAllWithProgress updates all instances with progress callback
func (o *Operations) UpdateAllWithProgress(onProgress func(Result)) []Result {
	workdir := o.config.Defaults.Workdir
	return RunParallelWithProgress(o.config, o.config.Instances, func(inst *Instance) string {
		return buildUpdateCommand(workdir, inst.Type, inst.Container)
	}, onProgress)
}

// UpdateAllWorkers updates only worker instances in parallel
func (o *Operations) UpdateAllWorkers() []Result {
	return o.UpdateAllWorkersWithProgress(nil)
}

// UpdateAllWorkersWithProgress updates workers with progress callback
func (o *Operations) UpdateAllWorkersWithProgress(onProgress func(Result)) []Result {
	workers := o.config.GetWorkers()
	workdir := o.config.Defaults.Workdir
	return RunParallelWithProgress(o.config, workers, func(inst *Instance) string {
		return buildUpdateCommand(workdir, "worker", inst.Container)
	}, onProgress)
}

// buildUpdateCommand creates the update command sequence (mirrors quick-update.sh but without log following)
func buildUpdateCommand(workdir, instType, container string) string {
	// Map instance type to dockerfile, image, env file, and ports
	var dockerfile, image, envFile, ports string

	switch instType {
	case "coordinator":
		dockerfile = "Dockerfile.coordinator"
		image = "rakuten-coordinator"
		envFile = ".env.coordinator"
		ports = "-p 9090:9090"
	case "worker":
		dockerfile = "Dockerfile.worker"
		image = "rakuten-worker"
		envFile = ".env.worker"
		ports = ""
	case "pow":
		dockerfile = "Dockerfile.pow-service"
		image = "rakuten-pow"
		envFile = ".env.pow-service"
		ports = "-p 8080:8080 -p 9090:9090"
	default:
		return fmt.Sprintf("echo 'Unknown instance type: %s'", instType)
	}

	// Build command sequence that mirrors quick-update.sh but without docker logs -f
	cmd := fmt.Sprintf(`cd %s && \
echo "=== GIT PULL ===" && \
git pull && \
echo "=== STOPPING %s ===" && \
docker stop %s 2>/dev/null || echo "(not running)" && \
echo "=== REMOVING %s ===" && \
docker rm -f %s 2>/dev/null || echo "(not found)" && \
echo "=== BUILDING %s ===" && \
docker build -f %s -t %s . && \
echo "=== STARTING %s ===" && \
docker run -d --name %s --restart unless-stopped %s --env-file %s %s && \
echo "=== VERIFYING ===" && \
sleep 2 && \
docker ps --filter name=%s --format "table {{.Names}}\t{{.Status}}" && \
echo "=== UPDATE COMPLETE ==="`,
		workdir,
		container, container,
		container, container,
		image, dockerfile, image,
		container, container, ports, envFile, image,
		container)

	return cmd
}


// RestartAllWorkers restarts only worker containers in parallel
func (o *Operations) RestartAllWorkers() []Result {
	workers := o.config.GetWorkers()
	return RunParallel(o.config, workers, func(inst *Instance) string {
		return fmt.Sprintf("docker restart %s", inst.Container)
	})
}

// CleanupAll performs docker cleanup on all instances
func (o *Operations) CleanupAll() []Result {
	return RunParallel(o.config, o.config.Instances, func(inst *Instance) string {
		return "docker stop $(docker ps -aq) 2>/dev/null; docker rm $(docker ps -aq) 2>/dev/null; docker system prune -af --volumes"
	})
}

// TestAllConnections tests SSH to all instances
func (o *Operations) TestAllConnections() []Result {
	return RunParallel(o.config, o.config.Instances, func(inst *Instance) string {
		return "echo ok"
	})
}
