// Command loadgen is the traffic source and sink for the e2e stress scenario. socat forks per
// connection, which is too slow to offer a known rate. It only talks to the addresses it is
// given, and the scenario only gives it addresses inside the test's own namespaces.
//
//	loadgen serve -bind IP -tcp PORT -udp PORT
//	loadgen tcp   -src IP[,IP...] -dst IP:PORT -rate N -seconds N
//	loadgen udp   -src IP[,IP...] -dst IP:PORT -rate N -seconds N
//	loadgen hold  -src IP -dst IP:PORT -conns N -seconds N
//	loadgen holdudp -src IP -dst IP:PORT -conns N
//
// Clients print one line of key=value fields. per_sec counts successes by the second the
// attempt was sent in, so a scenario can see when a drop took effect.
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// A connect that takes longer than this counts as dropped. It is under the kernel's first SYN
// retransmit at one second, so each attempt is one SYN and the offered rate is the real rate.
const connectTimeout = 900 * time.Millisecond

// How long a UDP reply may take to count, after the last datagram has been sent.
const replyGrace = 500 * time.Millisecond

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		log.Fatal("usage: loadgen serve|tcp|udp|hold|holdudp ...")
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	bind := fs.String("bind", "", "serve: address to listen on")
	tcpPort := fs.Int("tcp", 0, "serve: TCP port")
	udpPort := fs.Int("udp", 0, "serve: UDP port")
	src := fs.String("src", "", "source addresses, comma separated")
	dst := fs.String("dst", "", "destination ip:port")
	rate := fs.Int("rate", 0, "attempts per second, spread over the sources")
	seconds := fs.Int("seconds", 0, "how long to run")
	conns := fs.Int("conns", 0, "hold: connections to open")
	if err := fs.Parse(os.Args[2:]); err != nil {
		log.Fatal(err)
	}
	switch os.Args[1] {
	case "serve":
		serve(*bind, *tcpPort, *udpPort)
	case "tcp":
		runTCP(strings.Split(*src, ","), *dst, *rate, *seconds)
	case "udp":
		runUDP(strings.Split(*src, ","), *dst, *rate, *seconds)
	case "hold":
		runHold(*src, *dst, *conns, *seconds)
	case "holdudp":
		runHoldUDP(*src, *dst, *conns)
	default:
		log.Fatalf("unknown command %q", os.Args[1])
	}
}

// serve answers each TCP connection with one line, then echoes until the client closes it, so
// held connections stay counted and can show they still work. It echoes every UDP datagram.
func serve(bind string, tcpPort, udpPort int) {
	ln, err := net.Listen("tcp4", net.JoinHostPort(bind, strconv.Itoa(tcpPort)))
	if err != nil {
		log.Fatal(err)
	}
	pc, err := net.ListenPacket("udp4", net.JoinHostPort(bind, strconv.Itoa(udpPort)))
	if err != nil {
		log.Fatal(err)
	}
	go func() {
		buf := make([]byte, 1500)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				log.Fatal(err)
			}
			_, _ = pc.WriteTo(buf[:n], addr)
		}
	}()
	for {
		c, err := ln.Accept()
		if err != nil {
			log.Fatal(err)
		}
		go func() {
			defer c.Close()
			_, _ = c.Write([]byte("ok\n"))
			_, _ = io.Copy(c, c)
		}()
	}
}

// tally counts successes per send-second.
type tally struct {
	start  time.Time
	sent   atomic.Int64
	perSec []atomic.Int64
}

func newTally(seconds int) *tally {
	return &tally{start: time.Now(), perSec: make([]atomic.Int64, seconds)}
}

func (t *tally) success(sentAt time.Time) {
	i := int(sentAt.Sub(t.start) / time.Second)
	if i >= 0 && i < len(t.perSec) {
		t.perSec[i].Add(1)
	}
}

func (t *tally) print() {
	var ok int64
	parts := make([]string, len(t.perSec))
	for i := range t.perSec {
		n := t.perSec[i].Load()
		ok += n
		parts[i] = strconv.FormatInt(n, 10)
	}
	fmt.Printf("sent=%d ok=%d per_sec=%s\n", t.sent.Load(), ok, strings.Join(parts, ","))
}

// pace calls f(i, sentAt) rate times a second for the whole run, catching up rather than
// drifting if the scheduler falls behind.
func pace(t *tally, rate, seconds int, f func(i int, sentAt time.Time)) {
	total := rate * seconds
	interval := time.Second / time.Duration(rate)
	for i := 0; i < total; i++ {
		due := t.start.Add(time.Duration(i) * interval)
		if d := time.Until(due); d > 0 {
			time.Sleep(d)
		}
		t.sent.Add(1)
		f(i, due)
	}
}

func dialFrom(src, dst string) (net.Conn, error) {
	d := net.Dialer{Timeout: connectTimeout, LocalAddr: &net.TCPAddr{IP: net.ParseIP(src)}}
	return d.Dial("tcp4", dst)
}

// connected reports whether the service answered, which proves the whole round trip.
func connected(c net.Conn) bool {
	_ = c.SetReadDeadline(time.Now().Add(connectTimeout))
	buf := make([]byte, 8)
	n, err := c.Read(buf)
	_ = c.SetReadDeadline(time.Time{})
	return err == nil && n > 0
}

// runTCP opens a new connection for every attempt, so each one is a new SYN.
func runTCP(srcs []string, dst string, rate, seconds int) {
	t := newTally(seconds)
	var wg sync.WaitGroup
	pace(t, rate, seconds, func(i int, sentAt time.Time) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := dialFrom(srcs[i%len(srcs)], dst)
			if err != nil {
				return
			}
			defer c.Close()
			if connected(c) {
				t.success(sentAt)
			}
		}()
	})
	wg.Wait()
	t.print()
}

// runUDP keeps one socket, so one flow, per source. Each datagram carries the second it was
// sent in, so a reply is credited there however late it arrives.
func runUDP(srcs []string, dst string, rate, seconds int) {
	raddr, err := net.ResolveUDPAddr("udp4", dst)
	if err != nil {
		log.Fatal(err)
	}
	socks := make([]*net.UDPConn, len(srcs))
	t := newTally(seconds)
	for i, s := range srcs {
		c, err := net.DialUDP("udp4", &net.UDPAddr{IP: net.ParseIP(s)}, raddr)
		if err != nil {
			log.Fatal(err)
		}
		defer c.Close()
		socks[i] = c
		go func() {
			buf := make([]byte, 64)
			for {
				n, err := c.Read(buf)
				if err != nil {
					// The scenario's own drops never come back as errors. A refused port
					// does, and is not a reason to stop reading.
					if strings.Contains(err.Error(), "use of closed") {
						return
					}
					continue
				}
				if ns, err := strconv.ParseInt(string(buf[:n]), 10, 64); err == nil {
					t.success(time.Unix(0, ns))
				}
			}
		}()
	}
	pace(t, rate, seconds, func(i int, sentAt time.Time) {
		_, _ = socks[i%len(socks)].Write([]byte(strconv.FormatInt(sentAt.UnixNano(), 10)))
	})
	time.Sleep(replyGrace)
	t.print()
}

// runHold opens connections one by one and keeps them. After the hold it checks which ones
// still carry data, because a limit could also cut off connections it let in earlier.
func runHold(src, dst string, conns, seconds int) {
	var open []net.Conn
	for i := 0; i < conns; i++ {
		c, err := dialFrom(src, dst)
		if err != nil {
			continue
		}
		defer c.Close()
		if connected(c) {
			open = append(open, c)
		}
	}
	time.Sleep(time.Duration(seconds) * time.Second)
	alive := 0
	for _, c := range open {
		if _, err := c.Write([]byte("x")); err == nil && connected(c) {
			alive++
		}
	}
	fmt.Printf("opened=%d of=%d alive=%d\n", len(open), conns, alive)
}

// udpRoundTrip reports whether one datagram came back in time.
func udpRoundTrip(c net.Conn) bool {
	if _, err := c.Write([]byte("x")); err != nil {
		return false
	}
	_ = c.SetReadDeadline(time.Now().Add(replyGrace))
	buf := make([]byte, 8)
	_, err := c.Read(buf)
	return err == nil
}

// runHoldUDP opens flows one by one, one socket each. It sends each flow's second datagram right
// away, because conntrack only calls a flow established once it has seen a reply. At the end
// every flow that got through is tried again.
func runHoldUDP(src, dst string, flows int) {
	raddr, err := net.ResolveUDPAddr("udp4", dst)
	if err != nil {
		log.Fatal(err)
	}
	var open []net.Conn
	for i := 0; i < flows; i++ {
		c, err := net.DialUDP("udp4", &net.UDPAddr{IP: net.ParseIP(src)}, raddr)
		if err != nil {
			log.Fatal(err)
		}
		defer c.Close()
		if udpRoundTrip(c) && udpRoundTrip(c) {
			open = append(open, c)
		}
	}
	alive := 0
	for _, c := range open {
		if udpRoundTrip(c) {
			alive++
		}
	}
	fmt.Printf("opened=%d of=%d alive=%d\n", len(open), flows, alive)
}
