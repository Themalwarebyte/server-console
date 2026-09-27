package main

import (
	"encoding/json"
	"io"
)

// decodeJSON streams a Docker stats payload into the subset of fields used.
// Stats are read as a stream rather than buffered whole.
func decodeJSON(r io.Reader) (statsDoc, error) {
	var d statsDoc
	err := json.NewDecoder(r).Decode(&d)
	return d, err
}
