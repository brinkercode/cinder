// Package guard scans pushed content for secrets and injected instructions.
package guard

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Finding is one secret match. It never holds the raw secret.
type Finding struct {
	Rule        string `json:"rule"`
	Path        string `json:"path"`
	Line        int    `json:"line"` // 1-based
	Masked      string `json:"masked"`
	Fingerprint string `json:"fingerprint"`
}

type rule struct {
	name string
	re   *regexp.Regexp
}

// Fixed-prefix patterns favour precision over recall.
var rules = []rule{
	{"aws_access_key_id", regexp.MustCompile(`\b(AKIA|ASIA)[0-9A-Z]{16}\b`)},
	{"github_pat", regexp.MustCompile(`\bghp_[0-9A-Za-z]{36}\b`)},
	{"github_oauth", regexp.MustCompile(`\bgho_[0-9A-Za-z]{36}\b`)},
	{"github_server_token", regexp.MustCompile(`\b(ghs_|ghr_)[0-9A-Za-z]{36}\b`)},
	{"github_fine_grained_pat", regexp.MustCompile(`\bgithub_pat_[0-9A-Za-z_]{82}\b`)},
	{"gitlab_pat", regexp.MustCompile(`\bglpat-[0-9A-Za-z\-_]{20}\b`)},
	{"slack_token", regexp.MustCompile(`\bxox[baprs]-[0-9A-Za-z-]{10,48}\b`)},
	{"slack_webhook", regexp.MustCompile(`https://hooks\.slack\.com/services/[A-Za-z0-9_/]+`)},
	{"stripe_secret_key", regexp.MustCompile(`\b(sk|rk)_live_[0-9A-Za-z]{24,}\b`)},
	{"google_api_key", regexp.MustCompile(`\bAIza[0-9A-Za-z\-_]{35}\b`)},
	{"sendgrid_api_key", regexp.MustCompile(`\bSG\.[0-9A-Za-z\-_]{22}\.[0-9A-Za-z\-_]{43}\b`)},
	{"npm_token", regexp.MustCompile(`\bnpm_[0-9A-Za-z]{36}\b`)},
	{"private_key", regexp.MustCompile(`-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----`)},
	{"anthropic_api_key", regexp.MustCompile(`\bsk-ant-[0-9A-Za-z\-_]{32,}`)},
	{"openai_project_key", regexp.MustCompile(`\bsk-proj-[0-9A-Za-z\-_]{32,}`)},
	// No hyphen or underscore in the body, so sk-ant-/sk-proj- keys don't match twice.
	{"openai_api_key", regexp.MustCompile(`\bsk-[0-9A-Za-z]{32,}\b`)},
	{"cloudflare_api_token", regexp.MustCompile(`\bcf[au]t_[0-9A-Za-z\-_]{32,}`)},
	{"artifacts_token", regexp.MustCompile(`\bart_v1_[0-9A-Za-z\-_]{20,}`)},
}

// Injection rules flag text hidden from a reviewer or aimed at an agent. A prose rule only fires in a doc file or
// on a line with a comment marker. Their rule names are the labels the worker quarantines on.
var injections = []struct {
	name  string
	re    *regexp.Regexp
	prose bool
}{
	{"injection.tag_chars", regexp.MustCompile(`[\x{E0000}-\x{E007F}]+`), false},
	{"injection.bidi", regexp.MustCompile(`[\x{202A}-\x{202E}\x{2066}-\x{2069}]`), false},
	// A run of two or more: a lone ZWJ is ordinary in emoji sequences.
	{"injection.zero_width", regexp.MustCompile(`[\x{200B}-\x{200D}\x{2060}\x{FEFF}]{2,}`), false},
	{"injection.instruction", regexp.MustCompile(`(?i)\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)\b|\byou\s+are\s+now\s+(an?\s+)?(ai|assistant|agent)\b|\bnew\s+system\s+prompt\b`), true},
}

var commentMarker = regexp.MustCompile(`//|/\*|<!--|^\s*(#|\*|--|;)`)

// Scan returns one Finding per rule match in content, which came from path.
func Scan(path, content string) []Finding {
	var out []Finding
	doc := strings.HasPrefix(strings.ToUpper(filepath.Base(path)), "README")
	switch strings.ToLower(filepath.Ext(path)) {
	case ".md", ".txt", ".rst", ".adoc":
		doc = true
	}
	for i, line := range strings.Split(content, "\n") {
		for _, r := range injections {
			if r.prose && !doc && !commentMarker.MatchString(line) {
				continue
			}
			for _, m := range r.re.FindAllString(line, -1) {
				// Quoted so hidden characters show; capped since a tag run has no length limit.
				q := strconv.QuoteToASCII(m)
				out = append(out, Finding{Rule: r.name, Path: path, Line: i + 1, Masked: q[:min(len(q), 80)], Fingerprint: Fingerprint(r.name, path, m)})
			}
		}
		for _, r := range rules {
			for _, m := range r.re.FindAllString(line, -1) {
				out = append(out, Finding{
					Rule:        r.name,
					Path:        path,
					Line:        i + 1,
					Masked:      Mask(m),
					Fingerprint: Fingerprint(r.name, path, m),
				})
			}
		}
	}
	return out
}

// Fingerprint identifies a secret independent of its line, so a moved
// secret stays the same finding.
func Fingerprint(rule, path, match string) string {
	sum := sha256.Sum256([]byte(rule + "|" + path + "|" + match))
	return hex.EncodeToString(sum[:])
}

// Mask keeps 4 characters at each end and stars the middle (capped at 24).
// Secrets of 12 characters or fewer are fully starred.
func Mask(s string) string {
	const keep = 4
	if len(s) <= 2*keep+4 {
		return strings.Repeat("*", len(s))
	}
	mid := min(len(s)-2*keep, 24)
	return s[:keep] + strings.Repeat("*", mid) + s[len(s)-keep:]
}

// LooksBinary reports a NUL byte in the first 8KB.
func LooksBinary(content string) bool {
	return strings.IndexByte(content[:min(len(content), 8192)], 0) >= 0
}
