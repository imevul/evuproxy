package apply

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

const geoLastSuccessFile = "geo-last-success.json"

// GeoLastSuccess is persisted next to config when geo nft loader applies successfully.
type GeoLastSuccess struct {
	UTC    string `json:"utc"`
	Source string `json:"source"` // "reload" or "update-geo"
}

// WriteGeoLastSuccess writes geo-last-success.json atomically under the config directory.
func WriteGeoLastSuccess(cfgPath, source string) error {
	base := filepath.Dir(cfgPath)
	rec := GeoLastSuccess{
		UTC:    time.Now().UTC().Format(time.RFC3339),
		Source: source,
	}
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	path := filepath.Join(base, geoLastSuccessFile)
	return writeAtomic(path, b, 0o644)
}

// ReadGeoLastSuccess reads geo-last-success.json if present; zero value if missing or invalid.
func ReadGeoLastSuccess(cfgPath string) GeoLastSuccess {
	path := filepath.Join(filepath.Dir(cfgPath), geoLastSuccessFile)
	b, err := os.ReadFile(path)
	if err != nil {
		return GeoLastSuccess{}
	}
	var g GeoLastSuccess
	if json.Unmarshal(b, &g) != nil {
		return GeoLastSuccess{}
	}
	return g
}
