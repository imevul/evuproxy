# Optional CrowdSec integration

EvuProxy can reference a CrowdSec nftables block set when `crowdsec.enabled: true` in config. This is **off by default** and is **not** installed by `scripts/install.sh`.

## Install order

1. Install and configure EvuProxy (`evuproxy reload` at least once).
2. Install [CrowdSec](https://doc.crowdsec.net/) and the [nftables bouncer](https://doc.crowdsec.net/docs/bouncers/nftables).
3. Configure the bouncer to manage set **`crowdsec_block_v4`** in table **`inet evuproxy`** (same table EvuProxy generates).
4. Set `crowdsec.enabled: true` in `/etc/evuproxy/config.yaml` and run `evuproxy reload`.

## Rule placement

Banned sources are dropped on published ports **after** break-glass CIDRs and **before** rate limits and geo rules on **INPUT** and **inet forward** (`iifname public oifname wireguard`). CrowdSec is **not** applied in the **`ip` prerouting** table — configure the bouncer for **`inet evuproxy`** only.

## Reload behavior

Every `evuproxy reload` **deletes and recreates** the `inet evuproxy` table, which **clears** `crowdsec_block_v4` until the bouncer repopulates it. Expect a short window where bans are not enforced. Run the bouncer with a fast resync, or restart it after reload during an incident.

## Docker Compose (lab)

Example stack (adjust paths and API keys):

```yaml
services:
  crowdsec:
    image: crowdsecurity/crowdsec:latest
    volumes:
      - ./acquis.yaml:/etc/crowdsec/acquis.yaml:ro
      - crowdsec-data:/var/lib/crowdsec/data
  crowdsec-firewall-bouncer:
    image: crowdsecurity/cs-firewall-bouncer-nftables:latest
    depends_on: [crowdsec]
    environment:
      # Point bouncer at EvuProxy table/set — see bouncer docs for exact env vars.
      NFTABLES_TABLE: inet:evuproxy
      NFTABLES_SET: crowdsec_block_v4
volumes:
  crowdsec-data:
```

Run CrowdSec on the **same host** as EvuProxy so the bouncer can update kernel nftables.

## Without a bouncer

`evuproxy reload` still succeeds: EvuProxy creates an **empty** `crowdsec_block_v4` set. A warning is logged reminding you to run the bouncer.
