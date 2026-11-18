// Command mcpwatch-proxy guards an MCP server you cannot change.
//
// It sits between the client and the server on stdio: the client runs the proxy, the proxy
// runs the real server, and every message in both directions is checked.
//
//	mcpwatch-proxy --name my-tools -- node ./some-server.js
//
// This does not remove the Node dependency - the checks still run in the MCPWatch engine.
// What it buys is a guard for a server whose code you do not own.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	mcpwatch "github.com/vedhaai/MCP-Watch/go"
)

const usage = `mcpwatch-proxy: guard an MCP server you cannot change.

  mcpwatch-proxy [options] -- <command> [args...]

  --name <server>        the name this server reports under (default: the command)
  --mode <mode>          off, observe, protect or enforce
  --max-line-bytes <n>   drop a single message larger than this (default 16777216)
  --help                 this message

Everything else comes from the MCPWATCH_* environment and the dashboard. A project key is
read from MCPWATCH_PROJECT_KEY or MCPWATCH_PROJECT_KEY_FILE; do not pass one on a command
line, where it is visible to every user on the machine.
`

func main() {
	os.Exit(run())
}

func run() int {
	fs := flag.NewFlagSet("mcpwatch-proxy", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	name := fs.String("name", "", "the name this server reports under")
	mode := fs.String("mode", "", "off, observe, protect or enforce")
	maxLine := fs.Int("max-line-bytes", mcpwatch.DefaultMaxMessageBytes, "largest single message")
	help := fs.Bool("help", false, "print usage")

	if err := fs.Parse(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(os.Stdout, usage)
			return 0
		}
		fmt.Fprintf(os.Stderr, "mcpwatch-proxy: %v\n\n%s", err, usage)
		return 2
	}
	if *help {
		fmt.Fprint(os.Stdout, usage)
		return 0
	}
	command := fs.Args()
	if len(command) == 0 {
		fmt.Fprintf(os.Stderr, "mcpwatch-proxy: no server command. Put it after --\n\n%s", usage)
		return 2
	}

	opts := mcpwatch.Options{MaxMessageBytes: *maxLine}
	if *mode != "" {
		m, ok := mcpwatch.ParseMode(*mode)
		if !ok {
			fmt.Fprintf(os.Stderr, "mcpwatch-proxy: unknown mode %q\n", *mode)
			return 2
		}
		opts.Mode = m
	}
	serverName := *name
	if serverName == "" {
		serverName = command[0]
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	watch := mcpwatch.Start(ctx, serverName, opts)
	defer watch.Close()

	// The guard sits on our own stdio: the client reads and writes here.
	session := fmt.Sprintf("proxy-%d", os.Getpid())
	stream := mcpwatch.GuardIO(ctx, watch.Verdicts(), session, os.Stdin, os.Stdout, *maxLine)
	defer stream.Close()

	child := exec.Command(command[0], command[1:]...)
	child.Stderr = os.Stderr // the server's own logs pass through; stdout is the protocol
	childIn, err := child.StdinPipe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "mcpwatch-proxy: %v\n", err)
		return 2
	}
	childOut, err := child.StdoutPipe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "mcpwatch-proxy: %v\n", err)
		return 2
	}
	child.WaitDelay = 5 * time.Second
	if err := child.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "mcpwatch-proxy: could not start %q: %v\n", command[0], err)
		return 2
	}

	// Checked client messages go to the server; the server's messages come back for checking.
	go func() {
		defer childIn.Close()
		_, _ = io.Copy(childIn, stream.Reader())
	}()
	go func() {
		defer stream.Writer().Close()
		_, _ = io.Copy(stream.Writer(), childOut)
	}()

	err = child.Wait()
	// Give the server's last words time through the guard before shutting it down; without
	// this, a server that answers and exits immediately loses its final message.
	time.Sleep(200 * time.Millisecond)

	code := 0
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		code = exitErr.ExitCode()
	} else if err != nil {
		code = 1
	}
	// Close the guard before exiting: that is what makes the engine flush the events it has
	// queued for the dashboard. Exiting straight away loses the batch with no error anywhere.
	_ = stream.Close()
	_ = watch.Close()
	return code
}
