package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSHClient wraps SSH connection functionality
type SSHClient struct {
	config   *Config
	instance *Instance
	client   *ssh.Client
}

// NewSSHClient creates a new SSH client for an instance
func NewSSHClient(config *Config, instance *Instance) *SSHClient {
	return &SSHClient{
		config:   config,
		instance: instance,
	}
}

// Connect establishes SSH connection
func (s *SSHClient) Connect() error {
	keyPath := s.config.GetKeyPath(s.instance)
	key, err := os.ReadFile(keyPath)
	if err != nil {
		return fmt.Errorf("failed to read SSH key %s: %w", keyPath, err)
	}

	signer, err := ssh.ParsePrivateKey(key)
	if err != nil {
		return fmt.Errorf("failed to parse SSH key: %w", err)
	}

	sshConfig := &ssh.ClientConfig{
		User: s.instance.User,
		Auth: []ssh.AuthMethod{
			ssh.PublicKeys(signer),
		},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         s.config.Defaults.ConnectTimeout,
	}

	addr := fmt.Sprintf("%s:22", s.instance.Host)
	client, err := ssh.Dial("tcp", addr, sshConfig)
	if err != nil {
		return fmt.Errorf("failed to connect to %s: %w", s.instance.Name, err)
	}

	s.client = client
	return nil
}

// Close closes the SSH connection
func (s *SSHClient) Close() error {
	if s.client != nil {
		return s.client.Close()
	}
	return nil
}

// Run executes a command and returns output
func (s *SSHClient) Run(cmd string) (string, error) {
	if s.client == nil {
		return "", fmt.Errorf("not connected")
	}

	session, err := s.client.NewSession()
	if err != nil {
		return "", fmt.Errorf("failed to create session: %w", err)
	}
	defer session.Close()

	output, err := session.CombinedOutput(cmd)
	if err != nil {
		return string(output), fmt.Errorf("command failed: %w - output: %s", err, string(output))
	}

	return string(output), nil
}

// RunWithTimeout executes a command with a timeout
func (s *SSHClient) RunWithTimeout(ctx context.Context, cmd string) (string, error) {
	if s.client == nil {
		return "", fmt.Errorf("not connected")
	}

	session, err := s.client.NewSession()
	if err != nil {
		return "", fmt.Errorf("failed to create session: %w", err)
	}
	defer session.Close()

	// Create a channel to receive the result
	resultCh := make(chan struct {
		output string
		err    error
	}, 1)

	go func() {
		output, err := session.CombinedOutput(cmd)
		resultCh <- struct {
			output string
			err    error
		}{string(output), err}
	}()

	select {
	case <-ctx.Done():
		session.Signal(ssh.SIGTERM)
		return "", ctx.Err()
	case result := <-resultCh:
		return result.output, result.err
	}
}

// StreamLogs streams container logs to a writer
func (s *SSHClient) StreamLogs(ctx context.Context, container string, tail int, w io.Writer) error {
	if s.client == nil {
		return fmt.Errorf("not connected")
	}

	session, err := s.client.NewSession()
	if err != nil {
		return fmt.Errorf("failed to create session: %w", err)
	}

	stdout, err := session.StdoutPipe()
	if err != nil {
		session.Close()
		return fmt.Errorf("failed to get stdout pipe: %w", err)
	}

	stderr, err := session.StderrPipe()
	if err != nil {
		session.Close()
		return fmt.Errorf("failed to get stderr pipe: %w", err)
	}

	cmd := fmt.Sprintf("docker logs -f --tail=%d %s", tail, container)
	if err := session.Start(cmd); err != nil {
		session.Close()
		return fmt.Errorf("failed to start command: %w", err)
	}

	// Stream output
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			select {
			case <-ctx.Done():
				return
			default:
				fmt.Fprintln(w, scanner.Text())
			}
		}
	}()

	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			select {
			case <-ctx.Done():
				return
			default:
				fmt.Fprintln(w, scanner.Text())
			}
		}
	}()

	// Wait for context cancellation
	<-ctx.Done()
	session.Signal(ssh.SIGTERM)
	session.Close()
	wg.Wait()

	return nil
}

// RunInteractive opens an interactive SSH session
func (s *SSHClient) RunInteractive() error {
	if s.client == nil {
		return fmt.Errorf("not connected")
	}

	session, err := s.client.NewSession()
	if err != nil {
		return fmt.Errorf("failed to create session: %w", err)
	}
	defer session.Close()

	// Set up terminal modes
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}

	if err := session.RequestPty("xterm-256color", 80, 40, modes); err != nil {
		return fmt.Errorf("failed to request PTY: %w", err)
	}

	session.Stdin = os.Stdin
	session.Stdout = os.Stdout
	session.Stderr = os.Stderr

	if err := session.Shell(); err != nil {
		return fmt.Errorf("failed to start shell: %w", err)
	}

	return session.Wait()
}

// TestConnection tests if SSH connection works
func (s *SSHClient) TestConnection() (time.Duration, error) {
	start := time.Now()
	
	if err := s.Connect(); err != nil {
		return 0, err
	}
	defer s.Close()

	_, err := s.Run("echo ok")
	if err != nil {
		return 0, err
	}

	return time.Since(start), nil
}

// Result holds operation result for an instance
type Result struct {
	Instance *Instance
	Output   string
	Error    error
	Duration time.Duration
}

// RunParallel executes a command on multiple instances in parallel
func RunParallel(config *Config, instances []Instance, cmdFn func(*Instance) string) []Result {
	return RunParallelWithProgress(config, instances, cmdFn, nil)
}

// RunParallelWithProgress executes commands in parallel with progress callback
func RunParallelWithProgress(config *Config, instances []Instance, cmdFn func(*Instance) string, onProgress func(Result)) []Result {
	results := make([]Result, len(instances))
	var wg sync.WaitGroup
	var mu sync.Mutex

	for i := range instances {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			inst := &instances[idx]
			start := time.Now()

			client := NewSSHClient(config, inst)
			if err := client.Connect(); err != nil {
				result := Result{Instance: inst, Error: err, Duration: time.Since(start)}
				mu.Lock()
				results[idx] = result
				mu.Unlock()
				if onProgress != nil {
					onProgress(result)
				}
				return
			}
			defer client.Close()

			cmd := cmdFn(inst)
			output, err := client.Run(cmd)
			result := Result{
				Instance: inst,
				Output:   strings.TrimSpace(output),
				Error:    err,
				Duration: time.Since(start),
			}
			mu.Lock()
			results[idx] = result
			mu.Unlock()
			if onProgress != nil {
				onProgress(result)
			}
		}(i)
	}

	wg.Wait()
	return results
}

// DialWithTimeout is a helper for connection timeout
func DialWithTimeout(network, addr string, config *ssh.ClientConfig, timeout time.Duration) (*ssh.Client, error) {
	conn, err := net.DialTimeout(network, addr, timeout)
	if err != nil {
		return nil, err
	}

	c, chans, reqs, err := ssh.NewClientConn(conn, addr, config)
	if err != nil {
		conn.Close()
		return nil, err
	}

	return ssh.NewClient(c, chans, reqs), nil
}
