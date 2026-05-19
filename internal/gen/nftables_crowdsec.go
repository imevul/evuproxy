package gen

import (
	"fmt"
	"strings"
)

// setCrowdsecBlock is the IPv4 set CrowdSec's nftables bouncer must populate (see contrib/crowdsec/).
const setCrowdsecBlock = "crowdsec_block_v4"

func writeCrowdsecSet(b *strings.Builder) {
	fmt.Fprintf(b, "    set %s {\n        type ipv4_addr\n        flags interval\n        auto-merge\n    }\n\n", setCrowdsecBlock)
}

func crowdsecSetName(enabled bool) string {
	if enabled {
		return setCrowdsecBlock
	}
	return ""
}

// writePolicyCrowdsecDrop drops WAN sources in the CrowdSec set. Break-glass CIDRs are exempt.
// Placed after global/route deny lists and before rate limits / geo on published ports.
func writePolicyCrowdsecDrop(b *strings.Builder, crowdsecSet, breakGlass, proto, portExpr string) {
	if crowdsecSet == "" || portExpr == "" {
		return
	}
	if breakGlass != "" {
		fmt.Fprintf(b, "        ip saddr @%s ip saddr != @%s %s dport %s drop\n", crowdsecSet, breakGlass, proto, portExpr)
		return
	}
	fmt.Fprintf(b, "        ip saddr @%s %s dport %s drop\n", crowdsecSet, proto, portExpr)
}
