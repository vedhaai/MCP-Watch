#!/usr/bin/env bash
# Everything a CI job would check, as one command.
#
# This repository has no CI, and the Go package is not the place to introduce it on its own.
# These are the checks a person will not think to run by hand, though, so they live here
# rather than in somebody's shell history:
#
#   - the minimum Go claim, which is a promise to every consumer and breaks silently
#   - Windows and darwin, where command.go resolves mcpwatch.cmd and proc_windows.go is
#     compiled, neither of which ever happens here
#   - what would actually ship, because a Go module version is immutable in a way no other
#     package here is: there is no unpublish, no edit, and no file-selection step. Everything
#     committed under go/ goes into the zip, for ever.
#
# Unlike rust/check.sh, this file ships inside the module: Go has no `include` list.
#
# If CI is ever added for the whole repo, the workflow is one line: `go/check.sh`.
set -euo pipefail
cd "$(dirname "$0")"

# A go.work would resolve the submodules' cross-module requires from the working tree, which
# hides the single release bug that cannot be fixed after a tag. Every step runs as a
# consumer would.
export GOWORK=off
export GOFLAGS=-mod=readonly

# A non-interactive shell reads neither ~/.bashrc nor ~/.profile, so `go` may not be on PATH
# even though it works in your terminal. Resolve it rather than assume it.
# Each fallback is tested for executability, not emptiness: assigning a path that does not
# exist would otherwise satisfy -n and stop the chain at the first guess.
GO=${GO:-$(command -v go || true)}
[ -x "$GO" ] || GO=/usr/local/go/bin/go
[ -x "$GO" ] || GO="$HOME/sdk/go/bin/go"

MODULES=(.)
[ -d mcpsdk ] && MODULES+=(mcpsdk)
[ -d mcpgo ] && MODULES+=(mcpgo)
MIN_GO=$(awk '/^go /{print $2; exit}' go.mod)

# The SDK adapters require the core module, which does not exist on the proxy until it has
# been tagged. Until then they can only be built through the repository's go.work, so those
# steps run with the workspace and say so. MCPWATCH_RELEASE=1 forbids it: at release time
# every module must resolve exactly as a consumer would, or a broken require ships in a tag
# that cannot be corrected.
WORKSPACE=$(cd .. && pwd)/go.work
submodule_env() {
	if [ "${MCPWATCH_RELEASE:-}" = "1" ] || ! [ -f "$WORKSPACE" ]; then
		echo "GOWORK=off"
	else
		echo "GOWORK=$WORKSPACE"
	fi
}
in_module() { # in_module <dir> <command...>
	local dir=$1; shift
	if [ "$dir" = "." ]; then ( cd "$dir" && GOWORK=off "$@" )
	else ( cd "$dir" && env "$(submodule_env)" GOFLAGS= "$@" ); fi
}

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[1;31m%s\033[0m\n' "$1" >&2; exit 1; }

step "toolchain"
[ -x "$GO" ] || fail "Go is not installed. See go/README.md: the go.dev tarball, not apt (which ships 1.22)."
"$GO" version
"$GO" env GOVERSION GOTOOLCHAIN GOPROXY GOFLAGS CGO_ENABLED | paste -sd' ' -

step "format"
# gofmt -l exits 0 whether or not it lists anything, so the exit code is useless here.
out=$("$GO" run cmd/gofmt -l . 2>/dev/null || gofmt -l .)
[ -z "$out" ] || { echo "$out"; fail "not gofmt'd (run: gofmt -w .)"; }

step "module shape"
( cd . && GOWORK=off "$GO" mod tidy -diff ) || fail "go.mod/go.sum would change (run: go mod tidy)"
( cd . && GOWORK=off "$GO" mod verify >/dev/null )
for m in "${MODULES[@]}"; do
	# A replace in a tagged go.mod is silently ignored by consumers, so the real require line
	# is what they get - and if that names an unpublished version the release is dead on
	# arrival and cannot be edited.
	! grep -qE '^[[:space:]]*replace' "$m/go.mod" || fail "$m/go.mod has a replace; consumers ignore it"
done
if [ "${MCPWATCH_RELEASE:-}" = "1" ]; then
	for m in "${MODULES[@]}"; do
		[ "$m" = "." ] && continue
		# Ask the toolchain rather than grepping the file. `go get` writes a single-line
		# require, `go mod tidy` folds it into a require ( ... ) block, and a text match for
		# one form rejects the other - failing a module that is in fact correct.
		ver=$(cd "$m" && GOWORK=off "$GO" list -m -f '{{.Version}}' github.com/vedhaai/MCP-Watch/go 2>/dev/null || true)
		case "$ver" in
		v[0-9]*) ;;
		*) fail "$m/go.mod must require a published core version before tagging (found: ${ver:-nothing})" ;;
		esac
	done
fi
[ "$("$GO" list -m)" = "github.com/vedhaai/MCP-Watch/go" ] || fail "wrong module path"
# go mod tidy raises the go directive to satisfy a dependency without asking, and the first
# anyone hears of it is a consumer on an older Go reporting a hard error.
grep -qE "^go ${MIN_GO}\$" go.mod || fail "the go directive drifted from $MIN_GO"

step "the core module has no dependencies"
# This is the Go analogue of rust/check.sh's "each feature on its own", and the one thing
# nothing else catches: an SDK import leaking into the core module would put a Go 1.25 floor
# and a dozen transitive modules on everyone who only wanted the net/http middleware.
deps=$("$GO" list -m -f '{{if not .Main}}{{.Path}}{{end}}' all | grep -v '^$' || true)
[ -z "$deps" ] || { echo "$deps"; fail "the core module gained a dependency"; }

step "vet"
# go vet carries the stdversion analyzer, which reports any standard-library symbol newer
# than the go directive. That IS the minimum-Go check, and it needs no second toolchain.
for m in "${MODULES[@]}"; do in_module "$m" "$GO" vet ./...; done

step "tests"
for m in "${MODULES[@]}"; do in_module "$m" "$GO" test ./... -count=1 -timeout 180s; done

step "tests (race)"
if command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1; then
	for m in "${MODULES[@]}"; do in_module "$m" env CGO_ENABLED=1 "$GO" test ./... -race -count=1 -timeout 300s; done
else
	echo "  skipped: -race needs cgo and a C compiler (apt install build-essential)"
fi

step "windows"
# command.go resolves mcpwatch.cmd through PATHEXT and proc_windows.go is a separate file;
# neither is ever compiled on Linux. Go cross-compiles out of the box, so unlike the Rust
# gate there is nothing to install and no reason to skip.
for m in "${MODULES[@]}"; do in_module "$m" env CGO_ENABLED=0 GOOS=windows GOARCH=amd64 "$GO" build ./...; done
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 "$GO" vet ./...

step "darwin and arm64"
for m in "${MODULES[@]}"; do
	in_module "$m" env CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 "$GO" build ./...
	in_module "$m" env CGO_ENABLED=0 GOOS=linux GOARCH=arm64 "$GO" build ./...
done

step "pure Go"
# A cgo dependency would break cross-compilation and produce a dynamically linked
# mcpwatch-proxy that does not run on alpine or distroless. Asserted by building the way a
# release does, since `go list -deps` on a cgo-enabled host reports runtime/cgo through net.
CGO_ENABLED=0 "$GO" build ./... || fail "the core module does not build without cgo"
! git -C .. grep -lE '^import "C"|"C"$' -- 'go/*.go' >/dev/null 2>&1 || fail "the core module imports C"

step "offline build"
# Proves go.sum is complete and that a build reaches the network for nothing.
in_module . env GOPROXY=off "$GO" build ./...

step "minimum Go ($MIN_GO)"
if GOTOOLCHAIN="go${MIN_GO}" "$GO" version >/dev/null 2>&1; then
	GOTOOLCHAIN="go${MIN_GO}" "$GO" build ./...
else
	echo "  skipped: GOTOOLCHAIN=go${MIN_GO} needs a toolchain download"
	echo "  (go vet's stdversion analyzer already checked the standard library against it)"
fi

step "what would ship"
# A published Go module version can never be edited or withdrawn, so this is the last moment
# anything can be kept out of it.
files=$(git -C .. ls-files go/ | grep -vE '^go/(mcpsdk|mcpgo)/' || true)
echo "$files" | sed 's/^/  /'
if echo "$files" | grep -qE '(^|/)(\.env|secret\.key|events\.jsonl|go\.work|vendor/|.*\.test|.*\.exe)$'; then
	fail "a file that must never ship is tracked under go/"
fi
# Nothing key-shaped. A fake secret in a fixture must also not look like a real key, or it
# trips scanners - and here it would be published permanently.
if git -C .. grep -nIE 'sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' -- go/ >/dev/null 2>&1; then
	fail "a key-shaped string is tracked under go/"
fi
# pkg.go.dev hides the documentation of a module whose license it cannot detect.
for m in "${MODULES[@]}"; do [ -f "$m/LICENSE" ] || fail "$m/LICENSE is missing"; done
big=$(find . -type f -size +1M -not -path './.git/*' -print)
[ -z "$big" ] || { echo "$big"; fail "a large file is tracked under go/"; }

printf '\n\033[1mAll checks passed.\033[0m\n'
