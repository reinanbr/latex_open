//go:build linux

package sandbox

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

// Landlock syscalls share these numbers on every Linux architecture.
const (
	sysCreateRuleset = 444
	sysAddRule       = 445
	sysRestrictSelf  = 446

	createRulesetVersion = 1 << 0
	rulePathBeneath      = 1
	prSetNoNewPrivs      = 38
	oPath                = 0x200000 // O_PATH (amd64, arm64, 386, arm, riscv64)
)

// Filesystem access rights (linux/landlock.h).
const (
	accExecute    = 1 << 0
	accWriteFile  = 1 << 1
	accReadFile   = 1 << 2
	accReadDir    = 1 << 3
	accRemoveDir  = 1 << 4
	accRemoveFile = 1 << 5
	accMakeChar   = 1 << 6
	accMakeDir    = 1 << 7
	accMakeReg    = 1 << 8
	accMakeSock   = 1 << 9
	accMakeFifo   = 1 << 10
	accMakeBlock  = 1 << 11
	accMakeSym    = 1 << 12
	accRefer      = 1 << 13 // ABI 2
	accTruncate   = 1 << 14 // ABI 3
	accIoctlDev   = 1 << 15 // ABI 5
)

// Rights that make sense on a regular file (not a directory).
const fileRights = accExecute | accWriteFile | accReadFile | accTruncate | accIoctlDev

func landlockABI() (int, error) {
	v, _, e := syscall.Syscall(sysCreateRuleset, 0, 0, createRulesetVersion)
	if e != 0 {
		switch e {
		case syscall.ENOSYS:
			return 0, errors.New("kernel sem suporte a Landlock")
		case syscall.EOPNOTSUPP:
			return 0, errors.New("Landlock desabilitado no kernel (parâmetro lsm=)")
		case syscall.EPERM:
			return 0, errors.New("bloqueado pelo seccomp do contêiner")
		}
		return 0, e
	}
	return int(v), nil
}

func handledFor(abi int) uint64 {
	h := uint64(accMakeSym<<1 - 1) // ABI 1: bits 0..12
	if abi >= 2 {
		h |= accRefer
	}
	if abi >= 3 {
		h |= accTruncate
	}
	if abi >= 5 {
		h |= accIoctlDev
	}
	return h
}

// HelperMain is the entry point of the helper mode; it never returns.
// args are os.Args.
func HelperMain(args []string) {
	if err := helper(args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, "texdesk sandbox:", err)
		os.Exit(126)
	}
}

func helper(args []string) error {
	var ro, rw []string
	i := 0
	for ; i < len(args); i++ {
		switch args[i] {
		case "--ro", "--rw":
			if i+1 >= len(args) {
				return errors.New("argumento sem caminho")
			}
			if args[i] == "--ro" {
				ro = append(ro, args[i+1])
			} else {
				rw = append(rw, args[i+1])
			}
			i++
			continue
		case "--":
			i++
		default:
			return fmt.Errorf("argumento inesperado %q", args[i])
		}
		break
	}
	if i >= len(args) {
		return errors.New("nenhum comando")
	}
	argv := args[i:]

	// prctl and restrict_self act on the calling thread; exec from that same
	// thread so the new program inherits the restrictions.
	runtime.LockOSThread()
	if err := restrict(ro, rw); err != nil {
		return err
	}
	return syscall.Exec(argv[0], argv, os.Environ())
}

func restrict(ro, rw []string) error {
	abi, err := landlockABI()
	if err != nil {
		return err
	}
	handled := handledFor(abi)
	attr := make([]byte, 8)
	binary.NativeEndian.PutUint64(attr, handled)
	fd, _, e := syscall.Syscall(sysCreateRuleset, uintptr(unsafe.Pointer(&attr[0])), uintptr(len(attr)), 0)
	runtime.KeepAlive(attr)
	if e != 0 {
		return fmt.Errorf("landlock_create_ruleset: %w", e)
	}
	defer syscall.Close(int(fd))

	add := func(path string, access uint64) error {
		pfd, err := syscall.Open(path, oPath|syscall.O_CLOEXEC, 0)
		if err != nil {
			if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.EACCES) {
				return nil // optional path not present
			}
			return fmt.Errorf("%s: %w", path, err)
		}
		defer syscall.Close(pfd)
		var st syscall.Stat_t
		if err := syscall.Fstat(pfd, &st); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		if st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
			access &= fileRights
		}
		access &= handled
		// struct landlock_path_beneath_attr { u64 allowed_access; s32 parent_fd; } __packed
		rule := make([]byte, 12)
		binary.NativeEndian.PutUint64(rule[0:8], access)
		binary.NativeEndian.PutUint32(rule[8:12], uint32(int32(pfd)))
		_, _, e := syscall.Syscall6(sysAddRule, fd, rulePathBeneath, uintptr(unsafe.Pointer(&rule[0])), 0, 0, 0)
		runtime.KeepAlive(rule)
		if e != 0 {
			return fmt.Errorf("landlock_add_rule %s: %w", path, e)
		}
		return nil
	}
	for _, p := range ro {
		if err := add(p, accExecute|accReadFile|accReadDir); err != nil {
			return err
		}
	}
	for _, p := range rw {
		if err := add(p, handled); err != nil {
			return err
		}
	}
	if _, _, e := syscall.RawSyscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0); e != 0 {
		return fmt.Errorf("prctl(NO_NEW_PRIVS): %w", e)
	}
	if _, _, e := syscall.RawSyscall(sysRestrictSelf, fd, 0, 0); e != 0 {
		return fmt.Errorf("landlock_restrict_self: %w", e)
	}
	return nil
}
