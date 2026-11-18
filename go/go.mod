module github.com/vedhaai/MCP-Watch/go

// The minimum Go a consumer needs, not what we build with. This package is injected into
// someone else's server, so the floor stays low and the dependency list stays empty: the
// core module uses nothing outside the standard library. The two MCP SDK adapters live in
// nested modules (./mcpsdk, ./mcpgo) precisely so their Go 1.25 floor and their dependency
// trees never reach anyone who only wants the net/http middleware.
go 1.23.0
