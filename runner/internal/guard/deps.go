package guard

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// Dep is a dependency a change adds. Class is ClassifyLicense(License).
type Dep struct {
	Ecosystem string `json:"ecosystem"`
	Name      string `json:"name"`
	Version   string `json:"version"`
	License   string `json:"license"`
	Class     string `json:"class"`
	Direct    bool   `json:"direct"`
}

// AddedDeps lists the dependencies in the head lockfile at path whose name the base lockfile lacks. An empty base (a
// new lockfile) adds every dependency. Supported: package-lock.json (lockfileVersion 2 and 3), pnpm-lock.yaml
// (lockfileVersion 6+), yarn.lock v1, go.mod, Cargo.lock, poetry.lock, requirements.txt and package.json.
func AddedDeps(path string, base, head []byte) ([]Dep, error) {
	parse := map[string]func([]byte) ([]Dep, error){"package-lock.json": parseNpmLock, "go.mod": parseGoMod,
		"pnpm-lock.yaml": parsePnpmLock, "yarn.lock": parseYarnLock,
		"Cargo.lock": parseCargoLock, "poetry.lock": parsePoetryLock, "requirements.txt": parseRequirements,
		"package.json": parsePackageJSON}[filepath.Base(path)]
	if parse == nil {
		return nil, fmt.Errorf("deps: unsupported lockfile %s", path)
	}
	was, err := parse(base)
	if err != nil {
		return nil, err
	}
	now, err := parse(head)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, d := range was {
		seen[d.Name] = true
	}
	var out []Dep
	for _, d := range now {
		// Keyed by name and version, so two versions of one new package are both listed, and a package nested at
		// several paths once.
		if key := d.Name + "@" + d.Version; !seen[d.Name] && !seen[key] {
			seen[key] = true
			d.Class = ClassifyLicense(d.License)
			out = append(out, d)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name+"@"+out[i].Version < out[j].Name+"@"+out[j].Version })
	return out, nil
}

func parseNpmLock(data []byte) ([]Dep, error) {
	if len(data) == 0 {
		return nil, nil
	}
	var lock struct {
		Packages map[string]struct {
			Version string `json:"version"`
			License string `json:"license"`
			Link    bool   `json:"link"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		return nil, fmt.Errorf("deps: package-lock.json: %w", err)
	}
	// lockfileVersion 1 has no packages map; failing beats reporting that nothing was added.
	if lock.Packages == nil {
		return nil, fmt.Errorf("deps: package-lock.json has no packages map (lockfileVersion 1 is unsupported)")
	}
	var out []Dep
	for key, p := range lock.Packages {
		i := strings.LastIndex(key, "node_modules/")
		// "" is the root package; keys without node_modules/ and links are workspace packages, not dependencies.
		if i < 0 || p.Link {
			continue
		}
		out = append(out, Dep{Ecosystem: "npm", Name: key[i+len("node_modules/"):], Version: p.Version, License: p.License})
	}
	return out, nil
}

// parsePnpmLock reads the packages section, one Dep per name@version. Direct deps are the versions the importers
// (or, for a single project in v6, the top-level dependency sections) resolve to. pnpm stores no license.
func parsePnpmLock(data []byte) ([]Dep, error) {
	direct := map[string]bool{}
	var out []Dep
	top, depIndent, name := "", -1, ""
	for _, l := range strings.Split(string(data), "\n") {
		t := strings.TrimSpace(l)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		ind := len(l) - len(strings.TrimLeft(l, " "))
		key, val, _ := strings.Cut(t, ":")
		key, val = strings.Trim(key, `'"`), strings.Trim(strings.TrimSpace(val), `'"`)
		if depIndent >= 0 && ind <= depIndent {
			depIndent = -1
		}
		isDeps := key == "dependencies" || key == "devDependencies" || key == "optionalDependencies"
		switch {
		case ind == 0:
			top = key
			if key == "lockfileVersion" && (val == "" || val[0] < '6' && len(strings.Split(val, ".")[0]) == 1) {
				return nil, fmt.Errorf("deps: pnpm-lock.yaml lockfileVersion %q is unsupported (need 6+)", val)
			}
			if isDeps {
				depIndent = 0
			}
		case top == "packages" && ind == 2:
			// v6 keys are "/name@version(peers)", v9 keys "name@version"; a scoped name starts with "@".
			k := strings.TrimPrefix(strings.Trim(strings.TrimSuffix(t, ":"), `'"`), "/")
			if i := strings.Index(k, "("); i >= 0 {
				k = k[:i]
			}
			if i := strings.LastIndex(k, "@"); i > 0 {
				out = append(out, Dep{Ecosystem: "npm", Name: k[:i], Version: k[i+1:]})
			}
		case top == "importers" && ind == 4 && isDeps:
			depIndent = ind
		case depIndent >= 0 && ind == depIndent+2:
			name = key
		case depIndent >= 0 && ind == depIndent+4 && key == "version":
			if i := strings.Index(val, "("); i >= 0 {
				val = val[:i]
			}
			direct[name+"@"+val] = true
		}
	}
	for i, d := range out {
		out[i].Direct = direct[d.Name+"@"+d.Version]
	}
	return out, nil
}

// parseYarnLock reads a yarn v1 lockfile, one Dep per entry. yarn.lock does not record which deps are direct (that
// needs package.json), so Direct stays false. yarn.lock carries no license.
func parseYarnLock(data []byte) ([]Dep, error) {
	if len(data) == 0 {
		return nil, nil
	}
	// yarn 2+ writes YAML with a different key format; failing beats reporting that nothing was added.
	if !strings.Contains(string(data), "# yarn lockfile v1") {
		return nil, fmt.Errorf("deps: yarn.lock is not a v1 lockfile")
	}
	var out []Dep
	name := ""
	for _, l := range strings.Split(string(data), "\n") {
		if l == "" || l[0] == '#' {
			continue
		}
		if l[0] != ' ' {
			// `"@scope/a@^1.0.0", "@scope/a@^1.1.0":`: every spec in a header names the same package.
			spec := strings.Trim(strings.TrimSpace(strings.Split(strings.TrimSuffix(l, ":"), ",")[0]), `"`)
			name = ""
			if i := strings.LastIndex(spec, "@"); i > 0 {
				name = spec[:i]
			}
			continue
		}
		if f := strings.Fields(l); name != "" && len(f) == 2 && f[0] == "version" && strings.HasPrefix(l, "  v") {
			out = append(out, Dep{Ecosystem: "npm", Name: name, Version: strings.Trim(f[1], `"`)})
		}
	}
	return out, nil
}

// parseGoMod reads require directives, single-line and block. go.mod carries no license, so Go modules are unknown.
func parseGoMod(data []byte) ([]Dep, error) {
	var out []Dep
	block := false
	for _, l := range strings.Split(string(data), "\n") {
		if i := strings.Index(l, "//"); i >= 0 {
			l = l[:i]
		}
		f := strings.Fields(l)
		switch {
		case len(f) == 0:
		case block && f[0] == ")":
			block = false
		case f[0] == "require" && len(f) == 2 && f[1] == "(":
			block = true
		case f[0] == "require" && len(f) == 3:
			out = append(out, Dep{Ecosystem: "go", Name: f[1], Version: f[2]})
		case block && len(f) == 2:
			out = append(out, Dep{Ecosystem: "go", Name: f[0], Version: f[1]})
		}
	}
	return out, nil
}

func parseCargoLock(data []byte) ([]Dep, error) { return parseTomlPackages(data, "cargo") }

func parsePoetryLock(data []byte) ([]Dep, error) { return parseTomlPackages(data, "pypi") }

// parseTomlPackages reads the name and version of each [[package]] table. Cargo lists the workspace's own crates
// without a source; those are skipped like npm's root package. Neither lockfile carries a license.
func parseTomlPackages(data []byte, eco string) ([]Dep, error) {
	var out []Dep
	for _, block := range strings.Split(string(data), "[[package]]")[1:] {
		d, local := Dep{Ecosystem: eco}, eco == "cargo"
		for _, l := range strings.Split(block, "\n") {
			if strings.HasPrefix(l, "[") { // [package.dependencies], [metadata] and the like end the table
				break
			}
			k, v, _ := strings.Cut(l, "=")
			v = strings.Trim(strings.TrimSpace(v), `"`)
			switch strings.TrimSpace(k) {
			case "name":
				d.Name = v
			case "version":
				d.Version = v
			case "source":
				local = false
			}
		}
		if d.Name != "" && !local {
			out = append(out, d)
		}
	}
	return out, nil
}

// parseRequirements reads one requirement per line. Only `name==version` is pinned; anything else (a range, a bare
// name, a URL) is listed with version "unknown" rather than skipped. Option lines (-r, -e, --hash) are ignored.
func parseRequirements(data []byte) ([]Dep, error) {
	var out []Dep
	for _, l := range strings.Split(string(data), "\n") {
		if i := strings.Index(l, "#"); i >= 0 {
			l = l[:i]
		}
		if i := strings.Index(l, ";"); i >= 0 { // environment marker
			l = l[:i]
		}
		l = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(l), "\\"))
		if l == "" || l[0] == '-' {
			continue
		}
		name, version := l, "unknown"
		if n, v, ok := strings.Cut(l, "=="); ok && !strings.ContainsAny(v, ",<>!~*") {
			name, version = n, strings.TrimSpace(strings.TrimPrefix(v, "="))
		}
		if i := strings.IndexAny(name, "[<>=!~ @"); i >= 0 {
			name = name[:i]
		}
		out = append(out, Dep{Ecosystem: "pypi", Name: name, Version: version})
	}
	return out, nil
}

// parsePackageJSON reads a manifest's dependencies and devDependencies, all direct. A range has no resolved version,
// so its lowest allowed one stands in: "^1.2.3" lists 1.2.3.
func parsePackageJSON(data []byte) ([]Dep, error) {
	if len(data) == 0 {
		return nil, nil
	}
	var m struct {
		Dependencies    map[string]string `json:"dependencies"`
		DevDependencies map[string]string `json:"devDependencies"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("deps: package.json: %w", err)
	}
	var out []Dep
	for _, deps := range []map[string]string{m.Dependencies, m.DevDependencies} {
		for name, spec := range deps {
			out = append(out, Dep{Ecosystem: "npm", Name: name, Version: strings.TrimLeft(spec, "^~=v"), Direct: true})
		}
	}
	return out, nil
}

var permissive = map[string]bool{
	"MIT": true, "ISC": true, "0BSD": true, "BSD-2-CLAUSE": true, "BSD-3-CLAUSE": true, "APACHE-2.0": true,
	"UNLICENSE": true, "CC0-1.0": true, "ZLIB": true, "BLUEOAK-1.0.0": true, "PYTHON-2.0": true,
}

var copyleft = []string{"GPL-", "AGPL-", "LGPL-", "MPL-", "EPL-", "EUPL-", "CDDL-", "CC-BY-SA-", "OSL-"}

// ClassifyLicense sorts an SPDX expression into "permissive", "copyleft" or "unknown". Conservative: any copyleft
// id makes the whole expression copyleft (even "MIT OR GPL-3.0"), and any unrecognised id makes it unknown.
func ClassifyLicense(spdx string) string {
	ids := strings.Fields(strings.NewReplacer("(", " ", ")", " ").Replace(strings.ToUpper(spdx)))
	class := ""
	for _, id := range ids {
		if id == "AND" || id == "OR" || id == "WITH" {
			continue
		}
		for _, c := range copyleft {
			if strings.HasPrefix(id, c) {
				return "copyleft"
			}
		}
		if !permissive[strings.TrimSuffix(id, "+")] {
			class = "unknown"
		} else if class == "" {
			class = "permissive"
		}
	}
	if class == "" {
		return "unknown"
	}
	return class
}
