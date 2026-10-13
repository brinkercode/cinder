// Package egress is the per-job proxy that limits where a harness can connect.
package egress

import (
	"io"
	"maps"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"slices"
	"strings"
	"sync"
	"time"
)

// Proxy is an HTTPS CONNECT proxy on loopback that tunnels only to allowed hosts and records the rest.
type Proxy struct {
	URL     string // http://127.0.0.1:<port>, for the harness's HTTPS_PROXY and HTTP_PROXY
	allow   []string
	audit   bool // allow every host, recording the ones outside allow as would-deny
	srv     *http.Server
	mu      sync.Mutex
	blocked []string
	allowed map[string]int // CONNECTs per host, never payloads
	denied  map[string]int
	would   map[string]int // audit mode's would_deny: CONNECTs per host it let through outside allow
}

// Start serves a proxy that allows the agent version's egress host patterns (path.Match syntax,
// e.g. "*.github.com") plus the model provider and Artifacts hosts, which are always allowed.
// In audit mode (agent.yml egress_mode: audit) other hosts are let through too and counted in WouldDeny.
func Start(egress []string, audit bool, provider, artifacts string) (*Proxy, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	p := &Proxy{URL: "http://" + ln.Addr().String(), allow: append(slices.Clone(egress), provider, artifacts),
		audit: audit, allowed: map[string]int{}, denied: map[string]int{}, would: map[string]int{}}
	p.srv = &http.Server{Handler: p, ReadHeaderTimeout: 10 * time.Second}
	go p.srv.Serve(ln)
	return p, nil
}

// Close stops accepting connections; open tunnels end when either side closes.
func (p *Proxy) Close() error { return p.srv.Close() }

// AgentEnv is an agent run's proxy environment: every request goes through p, except the model gateway the runner was
// started with (CINDER_AI_GATEWAY, plain http://models.internal on a pool container), which the proxy would refuse because
// it tunnels only CONNECT. That host is the Worker's own handler, which checks the job itself, so it goes direct.
func (p *Proxy) AgentEnv() []string {
	env := []string{"HTTPS_PROXY=" + p.URL, "HTTP_PROXY=" + p.URL}
	if gw, err := url.Parse(os.Getenv("CINDER_AI_GATEWAY")); err == nil && gw.Hostname() != "" {
		env = append(env, "NO_PROXY="+gw.Hostname(), "no_proxy="+gw.Hostname())
	}
	return env
}

// Blocked is every host refused so far, once each, in order.
func (p *Proxy) Blocked() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.blocked)
}

// Counts is how many CONNECTs each host had so far, allowed and denied.
func (p *Proxy) Counts() (allowed, denied map[string]int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return maps.Clone(p.allowed), maps.Clone(p.denied)
}

// WouldDeny is how many CONNECTs each host outside the list had so far that audit mode let through.
func (p *Proxy) WouldDeny() map[string]int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return maps.Clone(p.would)
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Plain HTTP is refused rather than forwarded: only CONNECT tunnels are proxied.
	if r.Method != http.MethodConnect {
		http.Error(w, "only CONNECT is proxied", http.StatusMethodNotAllowed)
		return
	}
	host := strings.ToLower(r.URL.Hostname())
	listed := slices.ContainsFunc(p.allow, func(pat string) bool { ok, _ := path.Match(pat, host); return ok })
	if !listed && !p.audit {
		p.mu.Lock()
		if !slices.Contains(p.blocked, host) {
			p.blocked = append(p.blocked, host)
		}
		p.denied[host]++
		p.mu.Unlock()
		http.Error(w, "egress blocked: "+host, http.StatusForbidden)
		return
	}
	p.mu.Lock()
	if listed {
		p.allowed[host]++
	} else {
		p.would[host]++
	}
	p.mu.Unlock()
	up, err := net.DialTimeout("tcp", r.URL.Host, 10*time.Second)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	conn, brw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		up.Close()
		return
	}
	if _, err := conn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
		up.Close()
		conn.Close()
		return
	}
	go func() { io.Copy(up, brw); up.Close(); conn.Close() }() // either side closing ends the tunnel
	io.Copy(conn, up)
	up.Close()
	conn.Close()
}
