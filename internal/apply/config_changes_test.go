package apply

import "testing"

func TestConfigChangeCount(t *testing.T) {
	const base = `
peers:
  - {name: laptop, public_key: a}
  - {name: phone, public_key: b}
forwarding:
  maintenance_mode: false
  routes:
    - {target_ip: 10.0.0.2, disabled: false}
`
	tests := []struct {
		name string
		next string
		want int
	}{
		{"identical", base, 0},
		{"comments and key order do not count", `
# a comment
forwarding:
  routes:
    - {target_ip: 10.0.0.2, disabled: false}
  maintenance_mode: false
peers:
  - {name: laptop, public_key: a}
  - {name: phone, public_key: b}
`, 0},
		{"reordered rows do not count", `
peers:
  - {name: phone, public_key: b}
  - {name: laptop, public_key: a}
forwarding:
  maintenance_mode: false
  routes:
    - {target_ip: 10.0.0.2, disabled: false}
`, 0},
		{"removed peer and its disabled route", `
peers:
  - {name: phone, public_key: b}
forwarding:
  maintenance_mode: false
  routes:
    - {target_ip: 10.0.0.2, disabled: true}
`, 2},
		{"edited row counts once", `
peers:
  - {name: laptop2, public_key: a}
  - {name: phone, public_key: b}
forwarding:
  maintenance_mode: false
  routes:
    - {target_ip: 10.0.0.2, disabled: false}
`, 1},
		{"scalar change", `
peers:
  - {name: laptop, public_key: a}
  - {name: phone, public_key: b}
forwarding:
  maintenance_mode: true
  routes:
    - {target_ip: 10.0.0.2, disabled: false}
`, 1},
		{"section dropped counts its rows", `
forwarding:
  maintenance_mode: false
  routes:
    - {target_ip: 10.0.0.2, disabled: false}
`, 2},
		{"unparsable reports nothing", "peers: [", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := configChangeCount([]byte(base), []byte(tt.next)); got != tt.want {
				t.Errorf("configChangeCount = %d, want %d", got, tt.want)
			}
		})
	}
}
