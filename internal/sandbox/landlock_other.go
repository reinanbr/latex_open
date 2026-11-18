//go:build !linux

package sandbox

import (
	"errors"
	"fmt"
	"os"
)

func landlockABI() (int, error) { return 0, errors.New("Landlock só existe no Linux") }

// HelperMain is never used off Linux (Wrap does not rewrite commands there).
func HelperMain(args []string) {
	fmt.Fprintln(os.Stderr, "texdesk sandbox: indisponível neste sistema")
	os.Exit(126)
}
