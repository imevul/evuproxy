package api

import (
	"sync"
	"time"
)

// slidingLimiter enforces per-key and global counts in a sliding time window.
type slidingLimiter struct {
	mu     sync.Mutex
	perKey map[string][]time.Time
	all    []time.Time
}

func newSlidingLimiter() *slidingLimiter {
	return &slidingLimiter{perKey: map[string][]time.Time{}}
}

func pruneOld(ts *[]time.Time, cut time.Time) {
	i := 0
	for i < len(*ts) && (*ts)[i].Before(cut) {
		i++
	}
	*ts = (*ts)[i:]
}

// allow returns false if perKeyMax would be exceeded in window d.
// If globalMax > 0, the sum of all keys in the window must stay below globalMax as well.
func (s *slidingLimiter) allow(key string, perKeyMax, globalMax int, d time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	cut := now.Add(-d)
	if globalMax > 0 {
		pruneOld(&s.all, cut)
	}
	for k, v := range s.perKey {
		pruneOld(&v, cut)
		if len(v) == 0 {
			delete(s.perKey, k)
		} else {
			s.perKey[k] = v
		}
	}
	kt := s.perKey[key]
	pruneOld(&kt, cut)
	if len(kt) >= perKeyMax {
		return false
	}
	if globalMax > 0 && len(s.all) >= globalMax {
		return false
	}
	kt = append(kt, now)
	s.perKey[key] = kt
	if globalMax > 0 {
		s.all = append(s.all, now)
	}
	return true
}
