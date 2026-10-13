package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// watchActivity polls the worktree dir every tick until the returned stop is called. Each time the most recently modified
// tracked or new file is another one, written since the watch began, it posts "editing <path>" for job. A failed post is logged.
func watchActivity(ctx context.Context, dir, job string, tick time.Duration) (stop func()) {
	ctx, stop = context.WithCancel(ctx)
	if client == nil {
		return stop
	}
	go func() {
		start, last := time.Now(), ""
		t := time.NewTicker(tick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			path, at := newestFile(ctx, dir)
			if path == "" || path == last || at.Before(start) {
				continue
			}
			last = path
			if err := client.Activity(ctx, job, "editing "+path, path); err != nil && ctx.Err() == nil {
				fmt.Fprintln(os.Stderr, "cinder-agent: activity:", err)
			}
		}
	}()
	return stop
}

// newestFile is the tracked or untracked (not ignored) file of dir modified last, "" when there is none.
// lazy: stats every file each tick; watch file events instead past ~10k files.
func newestFile(ctx context.Context, dir string) (string, time.Time) {
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard").Output()
	if err != nil {
		return "", time.Time{}
	}
	var path string
	var at time.Time
	for _, f := range strings.Split(string(out), "\x00") {
		info, err := os.Stat(filepath.Join(dir, f))
		if f == "" || err != nil || !info.ModTime().After(at) {
			continue
		}
		path, at = f, info.ModTime()
	}
	return path, at
}
