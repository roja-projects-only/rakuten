package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"
)

// Instance represents a remote server instance
type Instance struct {
	Name      string `yaml:"name"`
	Host      string `yaml:"host"`
	User      string `yaml:"user"`
	Key       string `yaml:"key"`
	Type      string `yaml:"type"` // worker, pow, coordinator
	Container string `yaml:"container"`
}

// Defaults for SSH operations
type Defaults struct {
	Workdir        string        `yaml:"workdir"`
	ConnectTimeout time.Duration `yaml:"connectTimeout"`
	CommandTimeout time.Duration `yaml:"commandTimeout"`
}

// Config holds all configuration
type Config struct {
	Instances []Instance `yaml:"instances"`
	Defaults  Defaults   `yaml:"defaults"`
	configDir string     // directory where config file is located
}

// LoadConfig loads configuration from a YAML file
func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	var config Config
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config file: %w", err)
	}

	// Store config directory for resolving relative paths
	config.configDir = filepath.Dir(path)

	// Set defaults
	if config.Defaults.Workdir == "" {
		config.Defaults.Workdir = "/home/ubuntu/rakuten"
	}
	if config.Defaults.ConnectTimeout == 0 {
		config.Defaults.ConnectTimeout = 10 * time.Second
	}
	if config.Defaults.CommandTimeout == 0 {
		config.Defaults.CommandTimeout = 5 * time.Minute
	}

	return &config, nil
}

// GetKeyPath returns the absolute path to the SSH key
func (c *Config) GetKeyPath(instance *Instance) string {
	keyPath := instance.Key
	if !filepath.IsAbs(keyPath) {
		// Try relative to config directory first
		configRelative := filepath.Join(c.configDir, keyPath)
		// Clean the path to resolve .. properly
		configRelative = filepath.Clean(configRelative)
		if _, err := os.Stat(configRelative); err == nil {
			// Return absolute path
			if abs, err := filepath.Abs(configRelative); err == nil {
				return abs
			}
			return configRelative
		}
		// Try relative to parent directories (go up to rakuten root)
		for dir := c.configDir; dir != filepath.Dir(dir); dir = filepath.Dir(dir) {
			candidate := filepath.Clean(filepath.Join(dir, keyPath))
			if _, err := os.Stat(candidate); err == nil {
				if abs, err := filepath.Abs(candidate); err == nil {
					return abs
				}
				return candidate
			}
		}
	}
	return keyPath
}

// GetInstancesByType returns instances filtered by type
func (c *Config) GetInstancesByType(instanceType string) []Instance {
	var result []Instance
	for _, inst := range c.Instances {
		if inst.Type == instanceType {
			result = append(result, inst)
		}
	}
	return result
}

// GetWorkers returns all worker instances
func (c *Config) GetWorkers() []Instance {
	return c.GetInstancesByType("worker")
}

// GetInstance returns an instance by name
func (c *Config) GetInstance(name string) *Instance {
	for i := range c.Instances {
		if c.Instances[i].Name == name {
			return &c.Instances[i]
		}
	}
	return nil
}
