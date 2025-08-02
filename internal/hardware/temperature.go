package hardware

import (
	"fmt"
	"io/ioutil"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// TemperatureMonitor provides CPU temperature monitoring
type TemperatureMonitor interface {
	GetCPUTemperature() (float64, error)
	GetCPUTemperatures() ([]float64, error)
}

// LinuxTemperatureMonitor monitors temperature on Linux systems
type LinuxTemperatureMonitor struct {
	hwmonPath string
}

// NewLinuxTemperatureMonitor creates a Linux temperature monitor
func NewLinuxTemperatureMonitor() *LinuxTemperatureMonitor {
	return &LinuxTemperatureMonitor{
		hwmonPath: "/sys/class/hwmon",
	}
}

// GetCPUTemperature returns average CPU temperature
func (m *LinuxTemperatureMonitor) GetCPUTemperature() (float64, error) {
	temps, err := m.GetCPUTemperatures()
	if err != nil {
		return 0, err
	}

	if len(temps) == 0 {
		return 0, fmt.Errorf("no temperature sensors found")
	}

	// Calculate average
	var sum float64
	for _, temp := range temps {
		sum += temp
	}

	return sum / float64(len(temps)), nil
}

// GetCPUTemperatures returns all CPU core temperatures
func (m *LinuxTemperatureMonitor) GetCPUTemperatures() ([]float64, error) {
	var temperatures []float64

	// Try different temperature sources
	// First try /sys/class/thermal
	thermalPath := "/sys/class/thermal"
	if temps := m.readThermalZones(thermalPath); len(temps) > 0 {
		return temps, nil
	}

	// Try hwmon
	if temps := m.readHwmon(); len(temps) > 0 {
		return temps, nil
	}

	// Try coretemp module
	if temps := m.readCoretemp(); len(temps) > 0 {
		return temps, nil
	}

	return temperatures, fmt.Errorf("no temperature sensors available")
}

// readThermalZones reads temperatures from thermal zones
func (m *LinuxTemperatureMonitor) readThermalZones(path string) []float64 {
	var temperatures []float64

	files, err := ioutil.ReadDir(path)
	if err != nil {
		return temperatures
	}

	for _, file := range files {
		if strings.HasPrefix(file.Name(), "thermal_zone") {
			tempPath := filepath.Join(path, file.Name(), "temp")
			if data, err := ioutil.ReadFile(tempPath); err == nil {
				if temp, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil {
					// Convert from millidegrees to degrees
					temperatures = append(temperatures, float64(temp)/1000.0)
				}
			}
		}
	}

	return temperatures
}

// readHwmon reads temperatures from hwmon
func (m *LinuxTemperatureMonitor) readHwmon() []float64 {
	var temperatures []float64

	dirs, err := ioutil.ReadDir(m.hwmonPath)
	if err != nil {
		return temperatures
	}

	for _, dir := range dirs {
		hwmonDir := filepath.Join(m.hwmonPath, dir.Name())
		
		// Check if this is a CPU temperature sensor
		nameFile := filepath.Join(hwmonDir, "name")
		if data, err := ioutil.ReadFile(nameFile); err == nil {
			name := strings.TrimSpace(string(data))
			if strings.Contains(name, "coretemp") || strings.Contains(name, "k10temp") {
				// Read temperature inputs
				for i := 1; i < 10; i++ {
					tempFile := filepath.Join(hwmonDir, fmt.Sprintf("temp%d_input", i))
					if data, err := ioutil.ReadFile(tempFile); err == nil {
						if temp, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil {
							temperatures = append(temperatures, float64(temp)/1000.0)
						}
					}
				}
			}
		}
	}

	return temperatures
}

// readCoretemp reads temperatures from coretemp module
func (m *LinuxTemperatureMonitor) readCoretemp() []float64 {
	var temperatures []float64

	coretempPath := "/sys/devices/platform/coretemp.0"
	if _, err := os.Stat(coretempPath); os.IsNotExist(err) {
		return temperatures
	}

	// Read hwmon subdirectory
	hwmonDirs, err := filepath.Glob(filepath.Join(coretempPath, "hwmon", "hwmon*"))
	if err != nil || len(hwmonDirs) == 0 {
		return temperatures
	}

	for _, hwmonDir := range hwmonDirs {
		// Read temperature inputs
		for i := 1; i < 10; i++ {
			tempFile := filepath.Join(hwmonDir, fmt.Sprintf("temp%d_input", i))
			if data, err := ioutil.ReadFile(tempFile); err == nil {
				if temp, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil {
					temperatures = append(temperatures, float64(temp)/1000.0)
				}
			}
		}
	}

	return temperatures
}

// WindowsTemperatureMonitor monitors temperature on Windows systems
type WindowsTemperatureMonitor struct{}

// NewWindowsTemperatureMonitor creates a Windows temperature monitor
func NewWindowsTemperatureMonitor() *WindowsTemperatureMonitor {
	return &WindowsTemperatureMonitor{}
}

// GetCPUTemperature returns CPU temperature on Windows
func (m *WindowsTemperatureMonitor) GetCPUTemperature() (float64, error) {
	// Windows temperature monitoring requires WMI or specialized drivers
	// This is a placeholder implementation
	return 0, fmt.Errorf("temperature monitoring not implemented for Windows")
}

// GetCPUTemperatures returns CPU core temperatures on Windows
func (m *WindowsTemperatureMonitor) GetCPUTemperatures() ([]float64, error) {
	return nil, fmt.Errorf("temperature monitoring not implemented for Windows")
}

// DarwinTemperatureMonitor monitors temperature on macOS systems
type DarwinTemperatureMonitor struct{}

// NewDarwinTemperatureMonitor creates a macOS temperature monitor
func NewDarwinTemperatureMonitor() *DarwinTemperatureMonitor {
	return &DarwinTemperatureMonitor{}
}

// GetCPUTemperature returns CPU temperature on macOS
func (m *DarwinTemperatureMonitor) GetCPUTemperature() (float64, error) {
	// macOS temperature monitoring requires specialized tools or SMC access
	// This is a placeholder implementation
	return 0, fmt.Errorf("temperature monitoring not implemented for macOS")
}

// GetCPUTemperatures returns CPU core temperatures on macOS
func (m *DarwinTemperatureMonitor) GetCPUTemperatures() ([]float64, error) {
	return nil, fmt.Errorf("temperature monitoring not implemented for macOS")
}

// NewTemperatureMonitor creates a platform-specific temperature monitor
func NewTemperatureMonitor() TemperatureMonitor {
	switch runtime.GOOS {
	case "linux":
		return NewLinuxTemperatureMonitor()
	case "windows":
		return NewWindowsTemperatureMonitor()
	case "darwin":
		return NewDarwinTemperatureMonitor()
	default:
		return nil
	}
}