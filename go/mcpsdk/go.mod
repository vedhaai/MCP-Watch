module github.com/vedhaai/MCP-Watch/go/mcpsdk

// Its own module, not a package of the core one. Go has no equivalent of Cargo's optional
// features: a require here would land in every consumer's module graph and, worse, raise the
// minimum Go for somebody who only wanted the net/http middleware. The official SDK declares
// go 1.25.0 and pulls in eight direct dependencies; none of that should reach a stdlib-only
// server.
go 1.25.0

require github.com/modelcontextprotocol/go-sdk v1.8.0

require (
	github.com/google/jsonschema-go v0.4.3 // indirect
	github.com/segmentio/asm v1.1.3 // indirect
	github.com/segmentio/encoding v0.5.4 // indirect
	github.com/vedhaai/MCP-Watch/go v0.1.0
	github.com/yosida95/uritemplate/v3 v3.0.2 // indirect
	golang.org/x/oauth2 v0.35.0 // indirect
	golang.org/x/sync v0.20.0 // indirect
	golang.org/x/sys v0.41.0 // indirect
	golang.org/x/time v0.15.0 // indirect
)
