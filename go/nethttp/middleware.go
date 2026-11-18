// Package nethttp guards an MCP server that speaks Streamable HTTP.
//
// It is one net/http middleware, so it fits anything that accepts a
// func(http.Handler) http.Handler: the standard library's own ServeMux, chi, gorilla/mux,
// echo and the rest. Where the Rust adapter needs a separate tower layer and actix-web
// middleware, Go's single handler interface covers them all.
//
// Register it as the innermost middleware, inside any compression handler. Outside one, it
// would be handed gzip bytes and would find nothing in them.
package nethttp

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"strconv"

	mcpwatch "github.com/vedhaai/MCP-Watch/go"
	"github.com/vedhaai/MCP-Watch/go/httpguard"
)

type config struct {
	paths        []string
	maxBodyBytes int
	encrypted    *bool
	reportRemote bool
	logf         func(string, ...any)
}

// An Option configures the middleware.
type Option func(*config)

// Paths limits the guard to these path prefixes. "/mcp" guards /mcp and anything under it,
// but not /mcpx. With no Paths, every request is guarded.
func Paths(paths ...string) Option { return func(c *config) { c.paths = append(c.paths, paths...) } }

// MaxBodyBytes caps the request body. Default 10 MB; a larger body is refused with 413.
func MaxBodyBytes(n int) Option { return func(c *config) { c.maxBodyBytes = n } }

// Encrypted states whether the client reached this server over TLS.
//
// By default it is taken from the listener: r.TLS != nil means yes, and nothing is claimed
// when it is nil. Behind a TLS-terminating proxy the listener sees plain HTTP although the
// client did not, so say so explicitly rather than letting MW034 draw the wrong conclusion.
func Encrypted(yes bool) Option { return func(c *config) { c.encrypted = &yes } }

// ReportRemoteAddress controls whether the peer address is sent to the engine. It is on by
// default for this middleware, which is the one adapter that also relays SSE and can
// therefore report the event ids MW037 needs to match a resumption against.
func ReportRemoteAddress(yes bool) Option {
	return func(c *config) { c.reportRemote = yes }
}

// Logger receives one-line operational warnings. Never give it os.Stdout on a stdio server.
func Logger(logf func(string, ...any)) Option { return func(c *config) { c.logf = logf } }

type ctxKey struct{}

// Middleware returns the guard.
func Middleware(v mcpwatch.Verdicts, opts ...Option) func(http.Handler) http.Handler {
	cfg := config{maxBodyBytes: httpguard.DefaultMaxBodyBytes, reportRemote: true, logf: func(string, ...any) {}}
	for _, opt := range opts {
		opt(&cfg)
	}
	// The guard is built here, where every option has already been applied, and there is no
	// exported handle a caller could reconfigure afterwards. The Rust adapter shipped a
	// version whose path list was read before the builder ran, so it silently guarded
	// everything; a security setting that quietly does nothing is the worst kind of wrong.
	guard := httpguard.New(v, httpguard.Config{Paths: cfg.paths, MaxBodyBytes: cfg.maxBodyBytes})

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !guard.Matches(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			if r.Context().Value(ctxKey{}) != nil {
				next.ServeHTTP(w, r) // already guarded further out; do not judge twice
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), ctxKey{}, struct{}{}))
			serve(guard, &cfg, next, w, r)
		})
	}
}

func serve(guard *httpguard.Guard, cfg *config, next http.Handler, w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	info := infoFromRequest(r, cfg)

	var body []byte
	if r.Method == http.MethodPost && r.Body != nil {
		limited := http.MaxBytesReader(w, r.Body, int64(guard.MaxBodyBytes()))
		read, err := io.ReadAll(limited)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if ok := asMaxBytes(err, &tooLarge); ok {
				http.Error(w, "Request too large for MCPWatch", http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(w, "MCPWatch could not read the request body", http.StatusBadRequest)
			return
		}
		body = read
	}

	check := guard.CheckRequest(ctx, r.Method, info, body)
	defer guard.Finished(check)

	switch check.Decision.Action {
	case httpguard.Refuse:
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, httpguard.RefusedBody)
		return
	case httpguard.Reply:
		// A JSON-RPC error travels in a 200: the HTTP exchange succeeded, and it is the
		// body that says the call was refused.
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", strconv.Itoa(len(check.Decision.Body)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(check.Decision.Body)
		return
	}

	if r.Method == http.MethodPost {
		send := body
		if check.Decision.Rewritten != nil {
			send = check.Decision.Rewritten
		}
		// A rewritten body with the old Content-Length is a hang, not an error.
		r.Body = io.NopCloser(bytes.NewReader(send))
		r.ContentLength = int64(len(send))
		r.Header.Set("Content-Length", strconv.Itoa(len(send)))
		r.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(send)), nil
		}
	}

	gw := &guardedWriter{rw: w, guard: guard, check: check, ctx: ctx, logf: cfg.logf}
	defer gw.finish()
	next.ServeHTTP(gw, r)
}

// infoFromRequest builds what the engine is told about this request.
func infoFromRequest(r *http.Request, cfg *config) *mcpwatch.HTTPInfo {
	headers := mcpwatch.HeadersFrom(r.Header)
	// net/http moves the Host header out of r.Header onto r.Host, so a straight copy loses
	// it - and MW030, MW034 and MW035 all read it. This is a Go-only trap: the Rust, Java and
	// Python adapters get Host with everything else.
	if r.Host != "" {
		headers["host"] = r.Host
	}
	info := &mcpwatch.HTTPInfo{Headers: headers}

	if cfg.reportRemote && r.RemoteAddr != "" {
		addr := r.RemoteAddr
		if host, _, err := net.SplitHostPort(addr); err == nil {
			addr = host
		}
		info.RemoteAddress = mcpwatch.String(addr)
	}
	switch {
	case cfg.encrypted != nil:
		info.Encrypted = mcpwatch.Bool(*cfg.encrypted)
	case r.TLS != nil:
		info.Encrypted = mcpwatch.Bool(true)
		// When r.TLS is nil nothing is claimed: the field is left absent rather than set to
		// false, because behind a TLS-terminating proxy false would be a lie that MW034 acts
		// on.
	}
	return info
}

func asMaxBytes(err error, target **http.MaxBytesError) bool {
	var e *http.MaxBytesError
	if ok := errorsAs(err, &e); ok {
		*target = e
		return true
	}
	return false
}
