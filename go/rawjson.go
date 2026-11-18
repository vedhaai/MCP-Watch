package mcpwatch

import (
	"bytes"
	"encoding/json"
	"io"
)

// A JSON-RPC message, carried as the exact bytes that arrived.
//
// Messages are never decoded into map[string]any anywhere in this package. encoding/json
// turns every JSON number into a float64 under an interface, which silently rewrites a large
// integer id, and re-marshalling reorders keys - which matters because MW038 pins server
// identity by comparing strings.
type Message = json.RawMessage

// envelope is the only part of a message this package ever decodes. The id stays raw.
type envelope struct {
	ID     json.RawMessage `json:"id"`
	Method *string         `json:"method"`
}

func peek(msg json.RawMessage) envelope {
	var e envelope
	_ = json.Unmarshal(msg, &e)
	return e
}

// IsRequest reports whether a message is something that can be answered: it has an id that
// is not null, and a method.
//
// This is exactly the test fail-closed turns on. A notification has a method but no id and a
// response has an id but no method; neither has anywhere to put a refusal, so both are passed
// through even when the engine is unreachable.
func IsRequest(msg json.RawMessage) bool {
	e := peek(msg)
	return e.Method != nil && len(e.ID) > 0 && !bytes.Equal(e.ID, nullLiteral)
}

var nullLiteral = []byte("null")

// IDOf returns a message's id as the bytes it arrived as, or "null".
func IDOf(msg json.RawMessage) json.RawMessage {
	if e := peek(msg); len(e.ID) > 0 {
		return e.ID
	}
	return json.RawMessage(nullLiteral)
}

// WithID returns msg with its "id" member replaced by the given raw bytes.
//
// The engine rewrites a message's content - a poisoned tool removed from a listing, a secret
// redacted - but never its id. Node cannot represent an id above 2^53, so when a rewrite does
// come back, the original id is spliced in rather than trusted from the answer.
func WithID(msg json.RawMessage, id json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(msg, &fields); err != nil {
		return msg
	}
	if _, ok := fields["id"]; !ok {
		return msg
	}
	fields["id"] = id
	out, err := json.Marshal(fields)
	if err != nil {
		return msg
	}
	return out
}

// Equal reports whether two JSON documents carry the same value.
//
// It is not bytes.Equal: the engine re-serialises everything through JSON.stringify, so an
// unmodified message can come back with different whitespace and still be the same message.
// Numbers are compared as the literal text they arrived as (json.Decoder.UseNumber), never as
// float64, so two ids that differ beyond float64's precision compare unequal rather than
// collapsing onto each other.
func Equal(a, b json.RawMessage) bool {
	if bytes.Equal(a, b) {
		return true
	}
	av, aerr := decodeCanonical(a)
	bv, berr := decodeCanonical(b)
	if aerr != nil || berr != nil {
		return false
	}
	return sameValue(av, bv)
}

func decodeCanonical(raw json.RawMessage) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	// Trailing content means this was not one document.
	if _, err := dec.Token(); err != io.EOF {
		return nil, errTrailing
	}
	return v, nil
}

var errTrailing = errTrailingType{}

type errTrailingType struct{}

func (errTrailingType) Error() string { return "mcpwatch: trailing JSON content" }

func sameValue(a, b any) bool {
	switch av := a.(type) {
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for k, v := range av {
			other, ok := bv[k]
			if !ok || !sameValue(v, other) {
				return false
			}
		}
		return true
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !sameValue(av[i], bv[i]) {
				return false
			}
		}
		return true
	case json.Number:
		bv, ok := b.(json.Number)
		if !ok {
			return false
		}
		if av.String() == bv.String() {
			return true
		}
		// The engine runs on Node, which holds every JSON number as a float64 and writes it
		// back out from that. So an unchanged message can return with 9007199254740993
		// spelled 9007199254740992, and comparing the text would call that a rewrite and
		// forward the mangled copy - the exact corruption this comparison exists to prevent.
		// Two numbers that are the same float64 are the same number as far as the engine can
		// express it, which is what "did the engine change this" has to mean here.
		af, aerr := av.Float64()
		bf, berr := bv.Float64()
		return aerr == nil && berr == nil && af == bf
	case nil:
		return b == nil
	default:
		return a == b
	}
}
