# Third-party data and attribution

**Powered by [IPDENY.COM](https://www.ipdeny.com) IP database in the default configuration.**

The default GeoIP country zone files are fetched from IPDeny’s public dataset at `https://www.ipdeny.com/ipblocks/data/countries/<cc>.zone` (see [`internal/gen/geo.go`](../internal/gen/geo.go)).

Further reading from IPDeny:

- [Copyright notice](https://www.ipdeny.com/copyright.php)
- [Link back / examples](https://www.ipdeny.com/linkback.php)
- [Usage limits](https://www.ipdeny.com/usagelimits.php)

`evuproxy` downloads zones **one at a time** (no parallel connections) and pauses **750ms** between successive requests to follow IPDeny’s suggested spacing. Together with the default **`evuproxy-geo.timer`** (about once per 24h) and typical `geo.countries` lists, usage stays well under their **5000 zone downloads per day per IP** guideline; see [usage limits](https://www.ipdeny.com/usagelimits.php) for the full policy. Downloads originate from your **server’s egress IP**; respect IPDeny’s terms and attribution when using their data.

If you **copy or redistribute** downloaded `.zone` files, keep IPDeny’s **`Copyrights.txt`** with them as described in their [copyright notice](https://www.ipdeny.com/copyright.php). **Backups** of `/etc/evuproxy` may include downloaded zones and **`Copyrights.txt`** — preserve attribution when moving archives off-host.

For IPDeny’s licensing, privacy, and acceptable use, see their site: [copyright](https://www.ipdeny.com/copyright.php), [usage limits](https://www.ipdeny.com/usagelimits.php), and the links above.

## Optional: MaxMind GeoLite2 for log flags

If you set **`EVUPROXY_GEOLITE_MMDB`** to the path of a [MaxMind GeoLite2 Country](https://dev.maxmind.com/geoip/docs/databases/city-and-country) **`.mmdb`** file (no runtime HTTP API), the admin **Logs** table shows a flag emoji next to SRC/DST derived from that database. Follow MaxMind’s license and attribution for GeoLite2.
