module github.com/vedhaai/MCP-Watch/go/mcpgo

// Its own module for the same reason as ./mcpsdk: mark3labs/mcp-go declares go 1.25.5 and
// brings its own dependency tree, and neither should reach a server that only wants the
// core guard. It also means this adapter can move to mcp-go v2 on its own schedule without
// forcing a version bump on anybody else.
go 1.25.5

require github.com/mark3labs/mcp-go v1.5.0

require (
	github.com/google/jsonschema-go v0.4.2 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.2 // indirect
	github.com/spf13/cast v1.7.1 // indirect
	github.com/vedhaai/MCP-Watch/go v0.1.0
	github.com/yosida95/uritemplate/v3 v3.0.2 // indirect
	golang.org/x/text v0.14.0 // indirect
)
