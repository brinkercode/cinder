package verify

import (
	"cmp"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
)

// JobUser runs a job's own code (a check, a flow step) when cinder-verify runs as root, as in the pool images, so that
// code can't read the runner's environment or write root's HOME, the tool cache or /usr/local/bin.
const JobUser = "cinder-job"

// jobIDs is JobUser's uid and gid when cinder runs as root; ok is false otherwise and job code runs as the current user.
func jobIDs() (uid, gid int, ok bool, err error) {
	if os.Geteuid() != 0 {
		return 0, 0, false, nil
	}
	u, err := user.Lookup(JobUser)
	if err != nil {
		return 0, 0, false, fmt.Errorf("cinder-verify runs as root, so job code needs the %s user: %w", JobUser, err)
	}
	uid, _ = strconv.Atoi(u.Uid)
	gid, _ = strconv.Atoi(u.Gid)
	return uid, gid, true, nil
}

// AsJob makes cmd run as JobUser when cinder runs as root.
func AsJob(cmd *exec.Cmd) error {
	uid, gid, ok, err := jobIDs()
	if !ok {
		return err
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Credential = &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}
	return nil
}

// GiveToJob hands the tree at dir to JobUser when cinder runs as root, so job code can write it.
func GiveToJob(dir string) error {
	uid, gid, ok, err := jobIDs()
	if !ok {
		return err
	}
	return filepath.WalkDir(dir, func(p string, _ fs.DirEntry, err error) error {
		return cmp.Or(err, os.Lchown(p, uid, gid))
	})
}

// Workspace hands dir to the job and makes it a fresh home, its HOME and TMPDIR, which the caller removes.
func Workspace(dir string) (home string, err error) {
	if home, err = os.MkdirTemp("", "cinder-home-"); err != nil {
		return "", err
	}
	if err := cmp.Or(GiveToJob(dir), GiveToJob(home)); err != nil {
		os.RemoveAll(home)
		return "", err
	}
	return home, nil
}

// asJobOutput is cmd.Output as JobUser: git in a tree the check could change would run its config (core.fsmonitor,
// core.sshCommand on a blob fetch), so as root it would run the check's code as root.
func asJobOutput(cmd *exec.Cmd) ([]byte, error) {
	if err := AsJob(cmd); err != nil {
		return nil, err
	}
	return cmd.Output()
}
