package egress

import (
	"bufio"
	"net"
	"net/http"
	"slices"
	"strings"
	"testing"
)

// echoServer accepts one connection on loopback and echoes a line back.
func echoServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		line, _ := bufio.NewReader(c).ReadString('\n')
		c.Write([]byte("echo " + line))
	}()
	return ln.Addr().String()
}

// connect sends CONNECT target through p and returns the proxy's status and, when tunnelled, the echoed line.
func connect(t *testing.T, p *Proxy, target string) (int, string) {
	t.Helper()
	c, err := net.Dial("tcp", strings.TrimPrefix(p.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, ""
	}
	if _, err := c.Write([]byte("hi\n")); err != nil {
		t.Fatal(err)
	}
	line, _ := br.ReadString('\n')
	return resp.StatusCode, line
}

func start(t *testing.T, egress []string, provider, artifacts string) *Proxy {
	t.Helper()
	p, err := Start(egress, false, provider, artifacts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	return p
}

func TestProxy_ConnectToAllowedHost_IsTunnelled(t *testing.T) {
	_, port, _ := net.SplitHostPort(echoServer(t))
	p := start(t, []string{"*.example", "local*"}, "provider.example", "artifacts.example")
	if code, line := connect(t, p, "localhost:"+port); code != http.StatusOK || line != "echo hi\n" {
		t.Fatalf("got %d %q, want 200 and the echoed line", code, line)
	}
	if b := p.Blocked(); len(b) != 0 {
		t.Fatalf("blocked = %v, want none", b)
	}
}

func TestProxy_ConnectOutsideList_IsRefusedAndRecorded(t *testing.T) {
	_, port, _ := net.SplitHostPort(echoServer(t))
	p := start(t, []string{"*.github.com"}, "provider.example", "artifacts.example")
	for range 2 {
		if code, _ := connect(t, p, "localhost:"+port); code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", code)
		}
	}
	if code, _ := connect(t, p, "evil.example:443"); code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", code)
	}
	if b := p.Blocked(); !slices.Equal(b, []string{"localhost", "evil.example"}) {
		t.Fatalf("blocked = %v, want [localhost evil.example] once each", b)
	}
}

func TestProxy_AuditMode_LetsUnlistedHostThroughAndReportsWouldDeny(t *testing.T) {
	_, port, _ := net.SplitHostPort(echoServer(t))
	p, err := Start([]string{"*.github.com"}, true, "provider.example", "artifacts.example")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	if code, line := connect(t, p, "localhost:"+port); code != http.StatusOK || line != "echo hi\n" {
		t.Fatalf("got %d %q, want 200 and the echoed line", code, line)
	}
	allowed, denied := p.Counts()
	if w := p.WouldDeny(); w["localhost"] != 1 || len(allowed) != 0 || len(denied) != 0 || len(p.Blocked()) != 0 {
		t.Fatalf("would_deny = %v, allowed = %v, denied = %v, blocked = %v; want only would_deny localhost: 1", w, allowed, denied, p.Blocked())
	}
}

func TestProxy_ProviderAndArtifactsHosts_AlwaysAllowed(t *testing.T) {
	for _, tc := range []struct{ name, provider, artifacts string }{
		{"provider", "localhost", "artifacts.example"},
		{"artifacts", "provider.example", "localhost"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, port, _ := net.SplitHostPort(echoServer(t))
			p := start(t, nil, tc.provider, tc.artifacts)
			if code, line := connect(t, p, "localhost:"+port); code != http.StatusOK || line != "echo hi\n" {
				t.Fatalf("got %d %q, want the %s host tunnelled with no egress list", code, line, tc.name)
			}
		})
	}
}

func TestAgentEnv_ModelGatewayBypassesTheConnectOnlyProxy(t *testing.T) {
	t.Setenv("CINDER_AI_GATEWAY", "http://models.internal")
	p, err := Start(nil, false, "models.internal", "artifacts.example")
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	env := strings.Join(p.AgentEnv(), "\n")
	for _, want := range []string{"HTTPS_PROXY=" + p.URL, "HTTP_PROXY=" + p.URL, "NO_PROXY=models.internal"} {
		if !strings.Contains(env, want) {
			t.Fatalf("AgentEnv() = %q, want %q", env, want)
		}
	}
}
