package export

import (
	"flag"
	"fmt"
	"os"
	"testing"

	"texdesk/internal/sandbox"
)

// Tests run the external tools under the same Landlock sandbox as
// production; the test binary doubles as the sandbox helper.
func TestMain(m *testing.M) {
	if sandbox.IsHelper(os.Args) {
		sandbox.HelperMain(os.Args)
	}
	flag.Parse()
	if !testing.Short() {
		_, status := sandbox.Init(nil)
		fmt.Fprintln(os.Stderr, "export tests:", status)
	}
	os.Exit(m.Run())
}
