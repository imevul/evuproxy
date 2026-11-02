package apply

import (
	"fmt"
	"reflect"

	"gopkg.in/yaml.v3"
)

// configChangeCount says how many things differ between two config files, for
// confirmations like "Discard 3 changes". Each list row added, removed or edited
// counts once, as does each other value. Comments and key order do not count.
// Zero means nothing to report, which includes either file failing to parse.
func configChangeCount(a, b []byte) int {
	var av, bv any
	if yaml.Unmarshal(a, &av) != nil || yaml.Unmarshal(b, &bv) != nil {
		return 0
	}
	return countValueChanges(av, bv)
}

func countValueChanges(a, b any) int {
	if am, ok := a.(map[string]any); ok {
		if bm, ok := b.(map[string]any); ok {
			return countMapChanges(am, bm)
		}
	}
	al, aIsList := a.([]any)
	bl, bIsList := b.([]any)
	switch {
	case aIsList && (bIsList || b == nil):
		return countListChanges(al, bl)
	case bIsList && a == nil:
		return len(bl)
	case reflect.DeepEqual(a, b):
		return 0
	}
	return 1
}

func countMapChanges(a, b map[string]any) int {
	n := 0
	for k, av := range a {
		n += countValueChanges(av, b[k])
	}
	for k, bv := range b {
		if _, seen := a[k]; !seen {
			n += countValueChanges(nil, bv)
		}
	}
	return n
}

// countListChanges compares rows regardless of position. An edited row is one row
// gone and one row new, so the larger side is the number of rows touched.
func countListChanges(a, b []any) int {
	seen := make(map[string]int, len(a))
	for _, row := range a {
		seen[fmt.Sprintf("%v", row)]++
	}
	onlyB := 0
	for _, row := range b {
		key := fmt.Sprintf("%v", row)
		if seen[key] > 0 {
			seen[key]--
		} else {
			onlyB++
		}
	}
	onlyA := 0
	for _, left := range seen {
		onlyA += left
	}
	return max(onlyA, onlyB)
}
