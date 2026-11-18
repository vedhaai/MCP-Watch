module github.com/vedhaai/MCP-Watch/go/mcpsdk

// Its own module, not a package of the core one. Go has no equivalent of Cargo's optional
// features: a require here would land in every consumer's module graph and, worse, raise the
// minimum Go for somebody who only wanted the net/http middleware. The official SDK declares
// go 1.25.0 and pulls in eight direct dependencies; none of that should reach a stdlib-only
// server.
go 1.25.0

require github.com/modelcontextprotocol/go-sdk v1.8.0
