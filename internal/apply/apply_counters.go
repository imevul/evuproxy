package apply

import "sync/atomic"

var applySuccessTotal uint64
var applyFailureTotal uint64

// IncApplySuccess increments the apply/reload success counter (Prometheus).
func IncApplySuccess() {
	atomic.AddUint64(&applySuccessTotal, 1)
}

// IncApplyFailure increments the apply/reload failure counter (Prometheus).
func IncApplyFailure() {
	atomic.AddUint64(&applyFailureTotal, 1)
}

// ApplySuccessTotal returns the current success counter.
func ApplySuccessTotal() uint64 {
	return atomic.LoadUint64(&applySuccessTotal)
}

// ApplyFailureTotal returns the current failure counter.
func ApplyFailureTotal() uint64 {
	return atomic.LoadUint64(&applyFailureTotal)
}
