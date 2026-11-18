// Package mcpgo guards a server built with github.com/mark3labs/mcp-go.
//
// It is a separate module from the core guard, so that mcp-go's dependency tree and its
// minimum Go version reach only the servers that actually use it - and so this adapter can
// follow mcp-go to v2 without forcing a version bump on anyone else.
//
//	watch := mcpwatch.Start(ctx, "my-tools", mcpwatch.Options{})
//	defer watch.Close()
//
//	if err := mcpgo.ServeStdio(ctx, watch, s); err != nil {   // in place of server.ServeStdio
//	    log.Fatal(err)
//	}
//
// Both entry points interpose on the bytes rather than on mcp-go's typed handlers, so the
// engine sees the exact JSON-RPC that crossed the wire. A tool-handler middleware would be
// easier to write and strictly worse: it cannot see tools/list, notifications or anything
// else that is not a tool call, which is where tool poisoning and prompt injection live.
package mcpgo
