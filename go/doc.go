// Package mcpwatch is a security guard for MCP servers written in Go.
//
// It checks every JSON-RPC message between any MCP client and your server, in both
// directions, for prompt injection, tool poisoning, path traversal, command injection, SSRF,
// leaked secrets and rug pulls.
//
// # Which way in
//
//	What you have                              What to use
//	-----------------------------------------  -------------------------------------------
//	An HTTP server (net/http, chi, gorilla...)  nethttp.Middleware
//	The official Go SDK                         the mcpsdk module
//	mark3labs/mcp-go                            the mcpgo module
//	A server you cannot change                  the mcpwatch-proxy binary
//
// # Getting started
//
//	watch := mcpwatch.Start(ctx, "my-tools", mcpwatch.Options{})
//	defer watch.Close()
//
//	mux.Handle("/mcp", nethttp.Middleware(watch.Verdicts())(mcpHandler))
//
// # How it works
//
// This module re-implements no rules. The checks run in the MCPWatch engine, a Node 20+
// process started as a child, so a Go server gets exactly the verdicts a Node, Python, Java,
// Rust or .NET one would. This module moves messages, keeps them in order per direction, and
// decides nothing itself.
//
// The core module depends on nothing outside the standard library. The two SDK adapters live
// in their own modules so that their dependencies - and their newer minimum Go version -
// never reach a server that only wants the net/http middleware.
//
// # Logging
//
// Nothing here ever writes to os.Stdout. On a stdio MCP server stdout is the protocol
// stream, and a single stray line there disconnects the client with a parse error that
// points nowhere. Set Options.Logger if you want the warnings somewhere else, but never give
// it os.Stdout.
package mcpwatch
