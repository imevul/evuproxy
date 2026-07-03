package state

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/imevul/evuproxy/internal/atomicio"
)

const applyMetricsFile = "apply-metrics.json"

// ApplyMetrics persisted apply/reload counters (shared across CLI and serve).
type ApplyMetrics struct {
	SuccessTotal uint64 `json:"success_total"`
	FailureTotal uint64 `json:"failure_total"`
}

func applyMetricsPath(cfgPath string) string {
	return filepath.Join(filepath.Dir(cfgPath), applyMetricsFile)
}

// ReadApplyMetrics reads apply-metrics.json if present.
func ReadApplyMetrics(cfgPath string) ApplyMetrics {
	path := applyMetricsPath(cfgPath)
	b, err := os.ReadFile(path)
	if err != nil {
		return ApplyMetrics{}
	}
	var m ApplyMetrics
	if json.Unmarshal(b, &m) != nil {
		return ApplyMetrics{}
	}
	return m
}

func writeApplyMetrics(cfgPath string, m ApplyMetrics) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return atomicio.WriteFile(applyMetricsPath(cfgPath), b, 0o644)
}

// RecordApplySuccess increments persisted successful apply counter.
func RecordApplySuccess(cfgPath string) error {
	m := ReadApplyMetrics(cfgPath)
	m.SuccessTotal++
	return writeApplyMetrics(cfgPath, m)
}

// RecordApplyFailure increments persisted failed apply counter.
func RecordApplyFailure(cfgPath string) error {
	m := ReadApplyMetrics(cfgPath)
	m.FailureTotal++
	return writeApplyMetrics(cfgPath, m)
}

// ApplySuccessTotal returns persisted success count for Prometheus.
func ApplySuccessTotal(cfgPath string) uint64 {
	return ReadApplyMetrics(cfgPath).SuccessTotal
}

// ApplyFailureTotal returns persisted failure count for Prometheus.
func ApplyFailureTotal(cfgPath string) uint64 {
	return ReadApplyMetrics(cfgPath).FailureTotal
}
