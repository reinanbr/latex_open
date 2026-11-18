package ulid

import (
	"sort"
	"testing"
	"time"
)

func TestFormatAndOrder(t *testing.T) {
	seen := map[string]bool{}
	var ids []string
	base := time.Now()
	for i := 0; i < 1000; i++ {
		id := NewAt(base.Add(time.Duration(i) * time.Millisecond))
		if !Valid(id) {
			t.Fatalf("invalid ulid %q", id)
		}
		if seen[id] {
			t.Fatalf("duplicate %q", id)
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if !sort.StringsAreSorted(ids) {
		t.Error("ULIDs are not lexicographically sorted by time")
	}
	// Many IDs in the same millisecond stay strictly increasing.
	same := time.Now().Add(time.Hour)
	prev := ""
	for i := 0; i < 1000; i++ {
		id := NewAt(same)
		if id <= prev {
			t.Fatalf("not monotonic: %s <= %s", id, prev)
		}
		prev = id
	}
	for _, bad := range []string{"", "..", "01ARZ3NDEKTSV4RRFFQ69G5FAU", "01arz3ndektsv4rrffq69g5fav", "01ARZ3NDEKTSV4RRFFQ69G5FA"} {
		if Valid(bad) {
			t.Errorf("Valid(%q) = true", bad)
		}
	}
}
