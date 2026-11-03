package apply

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/state"
)

const (
	seCIDR = "192.0.2.0/24"
	noCIDR = "198.51.100.0/24"
)

// geoEnv is a host with se applied and a fake zone download that records its countries.
type geoEnv struct {
	*confirmEnv
	downloaded [][]string
}

func newGeoEnv(t *testing.T, confirm bool) *geoEnv {
	t.Helper()
	e := &geoEnv{confirmEnv: newBootEnv(t, confirm)}
	prev := downloadGeoZones
	downloadGeoZones = func(_ context.Context, c *config.Config) error {
		e.downloaded = append(e.downloaded, c.Geo.Countries)
		return nil
	}
	t.Cleanup(func() { downloadGeoZones = prev })

	zoneDir := filepath.Join(filepath.Dir(e.cfgPath), "geo-zones")
	if err := os.MkdirAll(zoneDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for cc, cidr := range map[string]string{"se": seCIDR, "no": noCIDR} {
		if err := os.WriteFile(filepath.Join(zoneDir, cc+".zone"), []byte(cidr+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	geo := "geo:\n  enabled: true\n  countries: [se]\n  zone_dir: " + zoneDir + "\n"
	e.baseline = []byte(strings.Replace(string(e.baseline), "geo:\n  enabled: false\n", geo, 1))
	if err := os.WriteFile(e.cfgPath, e.baseline, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Reload(context.Background(), e.cfgPath); err != nil {
		t.Fatalf("geo baseline reload: %v", err)
	}
	e.f.calls = nil
	return e
}

// saveCountries saves a change to geo.countries without applying it. replace changes more
// of the config on top.
func (e *geoEnv) saveCountries(replace ...string) []byte {
	e.t.Helper()
	body := strings.Replace(string(e.baseline), "countries: [se]", "countries: [no]", 1)
	body = strings.NewReplacer(replace...).Replace(body)
	if err := os.WriteFile(e.cfgPath, []byte(body), 0o644); err != nil {
		e.t.Fatal(err)
	}
	return []byte(body)
}

// wantLiveSets checks what the geo update validated and loaded, as a real nft would read it.
func (e *geoEnv) wantLiveSets(cidr string, countries ...string) {
	e.t.Helper()
	loader := filepath.Join(filepath.Dir(e.cfgPath), GeneratedDir, "geo-loader.nft")
	if e.f.callIndex("nft -f "+loader) < 0 {
		e.t.Fatalf("the geo sets should be loaded: %v", e.f.calls)
	}
	b, err := os.ReadFile(loader)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, want := range []string{"add element inet evuproxy geo_v4 { " + cidr + " }", "add element ip evuproxy geo_v4 { " + cidr + " }"} {
		if !strings.Contains(string(b), want) {
			e.t.Fatalf("geo-loader.nft missing %q:\n%s", want, b)
		}
	}
	if len(e.downloaded) == 0 || !slices.Equal(e.downloaded[0], countries) {
		e.t.Fatalf("downloaded %v, want %v first", e.downloaded, countries)
	}
}

func (e *geoEnv) wantNothingLoaded() {
	e.t.Helper()
	if e.f.callIndex("nft -f") >= 0 || e.f.callIndex("nft -c -f") >= 0 {
		e.t.Fatalf("nothing should reach nft: %v", e.f.calls)
	}
	if len(e.downloaded) != 0 {
		e.t.Fatalf("nothing should be downloaded: %v", e.downloaded)
	}
}

func TestUpdateGeo_confirmOnHoldsBackUnappliedCountries(t *testing.T) {
	e := newGeoEnv(t, true)
	edited := e.saveCountries()
	heldBack, err := UpdateGeo(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if !heldBack {
		t.Fatal("the update should report the countries it left out")
	}
	e.wantLiveSets(seCIDR, "se")
	e.wantFile(e.cfgPath, edited)
	e.wantFile(state.ConfigYAMLBackupPath(e.cfgPath), e.baseline)
	e.wantAppliedHashOf(e.baseline)
	if src := state.ReadGeoLastSuccess(e.cfgPath); src.Source != "update-geo" {
		t.Fatalf("last success: %+v", src)
	}
	// Only written to disk, for the Apply: wantLiveSets has checked it wasn't loaded.
	if len(e.downloaded) != 2 || !slices.Equal(e.downloaded[1], []string{"no"}) {
		t.Fatalf("downloaded %v, want se then only the held-back no", e.downloaded)
	}
}

func TestUpdateGeo_heldBackZoneFailureDoesNotFailTheRefresh(t *testing.T) {
	e := newGeoEnv(t, true)
	e.saveCountries()
	recordOnly := downloadGeoZones
	downloadGeoZones = func(ctx context.Context, c *config.Config) error {
		if err := recordOnly(ctx, c); err != nil {
			return err
		}
		if slices.Contains(c.Geo.Countries, "no") {
			return errors.New("no such country")
		}
		return nil
	}
	heldBack, err := UpdateGeo(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if !heldBack {
		t.Fatal("the update should still report the countries it left out")
	}
	e.wantLiveSets(seCIDR, "se")
}

func TestUpdateGeo_noNewCountryDownloadsNothingExtra(t *testing.T) {
	e := newGeoEnv(t, true)
	e.saveCountries("countries: [no]", "countries: [se, se]")
	if _, err := UpdateGeo(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	if len(e.downloaded) != 1 {
		t.Fatalf("downloaded %v, want only the applied countries", e.downloaded)
	}
}

func TestUpdateGeo_confirmOnNothingUnapplied(t *testing.T) {
	e := newGeoEnv(t, true)
	heldBack, err := UpdateGeo(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if heldBack {
		t.Fatal("nothing was left out")
	}
	e.wantLiveSets(seCIDR, "se")
}

func TestUpdateGeo_confirmOnOtherEditsAreNoNotice(t *testing.T) {
	e := newGeoEnv(t, true)
	e.editPort("")
	heldBack, err := UpdateGeo(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if heldBack {
		t.Fatal("the edit doesn't touch the geo sets")
	}
	e.wantLiveSets(seCIDR, "se")
}

func TestUpdateGeo_editTurningConfirmOffIsStillHeldBack(t *testing.T) {
	e := newGeoEnv(t, true)
	e.saveCountries("confirm: true", "confirm: false")
	heldBack, err := UpdateGeo(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if !heldBack {
		t.Fatal("the update should report the countries it left out")
	}
	e.wantLiveSets(seCIDR, "se")
}

func TestUpdateGeo_confirmOffLoadsConfig(t *testing.T) {
	e := newGeoEnv(t, false)
	e.saveCountries()
	heldBack, err := UpdateGeo(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if heldBack {
		t.Fatal("nothing is held back with confirm off")
	}
	e.wantLiveSets(noCIDR, "no")
}

func TestUpdateGeo_noUsableBaselineLoadsConfig(t *testing.T) {
	e := newGeoEnv(t, true)
	e.saveCountries()
	if err := os.Remove(state.ConfigYAMLBackupPath(e.cfgPath)); err != nil {
		t.Fatal(err)
	}
	heldBack, err := UpdateGeo(context.Background(), e.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if heldBack {
		t.Fatal("there was nothing to hold it back with")
	}
	e.wantLiveSets(noCIDR, "no")
}

// A hand edit config.yaml can't load doesn't stop the applied sets being refreshed.
func TestUpdateGeo_invalidEditStillRefreshes(t *testing.T) {
	e := newGeoEnv(t, true)
	edited := []byte("wireguard: [not, a, config\n")
	if err := os.WriteFile(e.cfgPath, edited, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := UpdateGeo(context.Background(), e.cfgPath); err != nil {
		t.Fatal(err)
	}
	e.wantLiveSets(seCIDR, "se")
	e.wantFile(e.cfgPath, edited)
}

func TestUpdateGeo_editEnablingGeoIsNotLoaded(t *testing.T) {
	e := newBootEnv(t, true)
	prev := downloadGeoZones
	downloadGeoZones = func(context.Context, *config.Config) error {
		t.Fatal("nothing should be downloaded")
		return nil
	}
	t.Cleanup(func() { downloadGeoZones = prev })
	geo := "geo:\n  enabled: true\n  countries: [se]\n  zone_dir: /nonexistent\n"
	body := strings.Replace(string(e.baseline), "geo:\n  enabled: false\n", geo, 1)
	if err := os.WriteFile(e.cfgPath, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	e.f.calls = nil
	_, err := UpdateGeo(context.Background(), e.cfgPath)
	if err == nil || !strings.Contains(err.Error(), "last applied config") {
		t.Fatalf("got %v", err)
	}
	if e.f.callIndex("nft") >= 0 {
		t.Fatalf("nothing should reach nft: %v", e.f.calls)
	}
}

func TestUpdateGeo_refusedDuringSession(t *testing.T) {
	for _, phase := range []string{ConfirmPhaseActive, ConfirmPhaseFailed} {
		t.Run(phase, func(t *testing.T) {
			e := newGeoEnv(t, true)
			e.saveCountries()
			e.apply()
			s := e.session()
			s.Phase = phase
			if err := writeConfirmSession(e.cfgPath, s); err != nil {
				t.Fatal(err)
			}
			e.f.calls = nil
			failures := state.ApplyFailureTotal(e.cfgPath)

			_, err := UpdateGeo(context.Background(), e.cfgPath)
			if !errors.Is(err, ErrConfirmSessionActive) {
				t.Fatalf("got %v", err)
			}
			e.wantNothingLoaded()
			if got := state.ApplyFailureTotal(e.cfgPath); got != failures {
				t.Fatalf("a refusal counted as a failed apply: %d -> %d", failures, got)
			}
			if got := e.session(); got == nil || got.Phase != phase {
				t.Fatalf("the session should be left alone: %+v", got)
			}
		})
	}
}

func TestUpdateGeo_zoneDownloadFailureLoadsNothing(t *testing.T) {
	e := newGeoEnv(t, true)
	downloadGeoZones = func(context.Context, *config.Config) error { return errors.New("no network") }
	failures := state.ApplyFailureTotal(e.cfgPath)
	if _, err := UpdateGeo(context.Background(), e.cfgPath); err == nil {
		t.Fatal("expected the download error")
	}
	e.wantNothingLoaded()
	if got := state.ApplyFailureTotal(e.cfgPath); got != failures+1 {
		t.Fatalf("failures %d -> %d", failures, got)
	}
}
