// Package mcpsdk guards a server built with the official Go SDK,
// github.com/modelcontextprotocol/go-sdk.
//
// It is a separate module from the core guard on purpose. Go has no equivalent of Cargo's
// optional features, so a dependency declared here would land in the module graph - and
// raise the minimum Go - of everyone who only wanted the net/http middleware.
//
// # Which seam to use
//
// [GuardStdio] and [GuardIO] interpose on the byte stream and are the supported way in. They
// see the exact JSON-RPC bytes, so nothing is lost in translation, and they leave the SDK's
// own connection in place.
//
//	watch := mcpwatch.Start(ctx, "my-tools", mcpwatch.Options{})
//	defer watch.Close()
//
//	transport, done := mcpsdk.GuardStdio(ctx, watch)   // the only line changed
//	defer done()
//	session, err := server.Connect(ctx, transport, nil)
//
// Wrapping mcp.Connection directly would be the obvious alternative and is a trap: the SDK
// type-asserts its connections for optional interfaces whose methods are unexported, which
// no package outside the SDK can implement. A wrapper compiles, works, and silently stops
// tracking the negotiated protocol version.
//
// The SDK's own AddReceivingMiddleware and AddSendingMiddleware hooks are deliberately not
// used. They operate on decoded Request and Result values rather than on the wire, so the
// JSON-RPC id has already been through Go's decoder by the time a guard sees it, and the
// bytes handed to the engine are a re-serialisation rather than what the peer actually sent.
// Both matter here: the engine compares its answer against the exact submitted bytes.
//
// For a Streamable HTTP server, prefer the core module's nethttp.Middleware. It is the only
// adapter that also sees GET and DELETE, the request headers and the SSE body, which is
// where the whole MW030-MW037 transport family lives.
package mcpsdk
