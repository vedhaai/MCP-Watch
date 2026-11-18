module github.com/vedhaai/MCP-Watch/go/mcpgo

// Its own module for the same reason as ./mcpsdk: mark3labs/mcp-go declares go 1.25.5 and
// brings its own dependency tree, and neither should reach a server that only wants the
// core guard. It also means this adapter can move to mcp-go v2 on its own schedule without
// forcing a version bump on anybody else.
go 1.25.5

require github.com/mark3labs/mcp-go v1.5.0
