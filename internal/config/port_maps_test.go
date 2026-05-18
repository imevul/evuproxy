package config

import "testing"

func TestValidatePortMaps_rangeWidth(t *testing.T) {
	err := ValidatePortMaps(0, []string{"25565-25567"}, []PortMap{
		{Public: "25565-25567", Internal: "19132-19133"},
	})
	if err == nil {
		t.Fatal("expected range width mismatch")
	}
	ve, ok := err.(*ValidationError)
	if !ok || ve.Code != "port_map_invalid" {
		t.Fatalf("got %v", err)
	}
}

func TestValidatePortMaps_ok(t *testing.T) {
	err := ValidatePortMaps(0, []string{"25565", "25566"}, []PortMap{
		{Public: "25565", Internal: "19132"},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestExpandRoutePublicPortNumbers_withMaps(t *testing.T) {
	r := ForwardRoute{
		Ports:    []string{"25565", "25566"},
		PortMaps: []PortMap{{Public: "25565", Internal: "19132"}},
	}
	ports, err := ExpandRoutePublicPortNumbers(r)
	if err != nil {
		t.Fatal(err)
	}
	if len(ports) != 2 {
		t.Fatalf("want 2 public ports, got %v", ports)
	}
}

func TestValidatePortMaps_rejectsBraceInternal(t *testing.T) {
	err := ValidatePortMaps(0, []string{"25565"}, []PortMap{
		{Public: "25565", Internal: "{19132,19133}"},
	})
	if err == nil {
		t.Fatal("expected brace internal rejection")
	}
	ve, ok := err.(*ValidationError)
	if !ok || ve.Code != "port_map_invalid" {
		t.Fatalf("got %v", err)
	}
}

func TestDNATDestination_mapped(t *testing.T) {
	dest, err := DNATDestination("10.100.0.2", "25565", []PortMap{{Public: "25565", Internal: "19132"}})
	if err != nil {
		t.Fatal(err)
	}
	if dest != "10.100.0.2:19132" {
		t.Fatalf("got %q", dest)
	}
}
