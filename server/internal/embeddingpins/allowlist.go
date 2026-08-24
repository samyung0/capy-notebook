package embeddingpins

import (
	"fmt"

	"github.com/evonotes/server/internal/models"
)

type Spec struct {
	VectorTable string
	Dimensions  int
}

var specs = map[models.Pin]Spec{
	{Key: "qwen-embed", Version: 1}: {
		VectorTable: "rag_chunk_vectors_2560",
		Dimensions:  2560,
	},
}

func Lookup(pin models.Pin) (Spec, bool) {
	spec, ok := specs[pin]
	return spec, ok
}

func VectorTable(pin models.Pin) (string, error) {
	spec, ok := Lookup(pin)
	if !ok {
		return "", fmt.Errorf("no vector table for %s v%d", pin.Key, pin.Version)
	}
	return spec.VectorTable, nil
}
