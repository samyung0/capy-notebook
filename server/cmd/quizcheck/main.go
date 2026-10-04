// Command quizcheck validates quiz questions the way the app's create_material
// does, for the lab playground's local writes. It reads a JSON array of
// questions on stdin and prints nothing on success, or the refusal and exit 1.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/questions"
)

func main() {
	raw, err := io.ReadAll(os.Stdin)
	if err == nil {
		_, err = materialdoc.QuizDocument(raw, nil)
	}
	if err == nil {
		var qs []map[string]any
		if err = json.Unmarshal(raw, &qs); err == nil {
			err = questions.QuizBounds(qs)
		}
	}
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
