package mcpwatch

import (
	"bufio"
	"errors"
	"io"
)

// DefaultMaxMessageBytes caps one line on the sidecar pipe.
const DefaultMaxMessageBytes = 16 << 20

// errLineTooLong means one message exceeded the cap. It is deliberately recoverable: a
// single oversized line must not end a working session, and buffering it without a limit is
// how a guard becomes the resource exhaustion it is meant to prevent.
var errLineTooLong = errors.New("mcpwatch: message too large")

// readLine reads one newline-delimited message.
//
// bufio.Scanner is not used here on purpose. Its default token limit is 64 KiB and it stops
// the stream on ErrTooLong, so one large tools/list result would desynchronise the pipe and
// every later answer would be matched to the wrong request. This reads with an explicit cap
// and, when a line is too long, discards the rest of that line so the stream resynchronises
// on the next one.
func readLine(r *bufio.Reader, max int) ([]byte, error) {
	if max <= 0 {
		max = DefaultMaxMessageBytes
	}
	var buf []byte
	tooLong := false
	for {
		chunk, err := r.ReadSlice('\n')
		if len(chunk) > 0 && !tooLong {
			if len(buf)+len(chunk) > max {
				tooLong = true
				buf = nil
			} else {
				buf = append(buf, chunk...)
			}
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			if len(buf) > 0 && err == io.EOF {
				// A final message with no trailing newline is still a message.
				return trimEOL(buf), nil
			}
			return nil, err
		}
		if tooLong {
			return nil, errLineTooLong
		}
		return trimEOL(buf), nil
	}
}

func trimEOL(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}
