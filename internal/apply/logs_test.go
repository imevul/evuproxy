package apply

import (
	"errors"
	"testing"
)

func TestFilterDropLines(t *testing.T) {
	in := "noise\nkernel: evuproxy-geo-block: IN=eth0 SRC=1.2.3.4\nkernel: evuproxy-ratelimit: IN=eth0 SRC=5.6.7.8\nkernel: evuproxy-crowdsec: IN=eth0 SRC=9.9.9.9\nother\n"
	got := filterDropLines(in)
	if len(got) != 3 {
		t.Fatalf("unexpected: %#v", got)
	}
}

func TestHeadLimit(t *testing.T) {
	a := []string{"a", "b", "c"}
	if s := headLimit(a, 2); len(s) != 2 || s[0] != "a" || s[1] != "b" {
		t.Fatal(s)
	}
}

func TestPickFirewallLogSource(t *testing.T) {
	jErr := errors.New("no journal")
	dErr := errors.New("no dmesg")
	jLines := []string{"journal-line"}
	dLines := []string{"dmesg-line"}

	cases := []struct {
		name       string
		journal    []string
		journalErr error
		dmesg      []string
		dmesgErr   error
		wantSrc    string
		wantLen    int
		wantErr    bool
	}{
		{name: "prefer journal", journal: jLines, dmesg: dLines, wantSrc: "journalctl", wantLen: 1},
		{name: "empty journal falls back to dmesg", journal: nil, dmesg: dLines, wantSrc: "dmesg", wantLen: 1},
		{name: "journal error falls back to dmesg", journalErr: jErr, dmesg: dLines, wantSrc: "dmesg", wantLen: 1},
		{name: "both empty prefer journal source", wantSrc: "journalctl", wantLen: 0},
		{name: "journal empty dmesg error", dmesgErr: dErr, wantSrc: "journalctl", wantLen: 0},
		{name: "both fail", journalErr: jErr, dmesgErr: dErr, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, src, err := pickFirewallLogSource(tc.journal, tc.journalErr, tc.dmesg, tc.dmesgErr)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if src != tc.wantSrc || len(got) != tc.wantLen {
				t.Fatalf("got src=%q len=%d want src=%q len=%d", src, len(got), tc.wantSrc, tc.wantLen)
			}
		})
	}
}
