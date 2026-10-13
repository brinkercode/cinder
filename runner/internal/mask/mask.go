// Package mask hides secret values in a byte stream before it leaves the runner.
package mask

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"net/url"
)

var hidden = []byte("***")

// Writer replaces every registered value, and its base64 and URL-encoded forms, with
// "***", even when a value is split across writes. Close flushes the held-back tail.
type Writer struct {
	w     io.Writer
	forms [][]byte
	tail  []byte
	keep  int // max(len(form))-1: bytes held back in case a form continues in the next write
}

// New returns a Writer that writes the masked stream to w.
func New(w io.Writer) *Writer { return &Writer{w: w} }

// Add registers v. Values under 8 characters are refused: masking them would mangle ordinary output.
func (m *Writer) Add(v string) error {
	if len(v) < 8 {
		return fmt.Errorf("mask: secret shorter than 8 characters")
	}
	// Unpadded base64 matches both padded and unpadded encodings at offset 0.
	for _, f := range []string{v, base64.RawStdEncoding.EncodeToString([]byte(v)),
		base64.RawURLEncoding.EncodeToString([]byte(v)), url.QueryEscape(v)} {
		m.forms = append(m.forms, []byte(f))
		m.keep = max(m.keep, len(f)-1)
	}
	return nil
}

func (m *Writer) Write(p []byte) (int, error) {
	m.tail = append(m.tail, p...)
	for _, f := range m.forms {
		m.tail = bytes.ReplaceAll(m.tail, f, hidden)
	}
	if n := len(m.tail) - m.keep; n > 0 {
		if _, err := m.w.Write(m.tail[:n]); err != nil {
			return 0, err
		}
		m.tail = append(m.tail[:0], m.tail[n:]...)
	}
	return len(p), nil
}

// Close writes out the held-back tail; it is already masked.
func (m *Writer) Close() error {
	_, err := m.w.Write(m.tail)
	m.tail = nil
	return err
}
