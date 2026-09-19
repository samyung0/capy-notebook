// Package copytext holds locale-aware display strings for server-created
// names. Unknown locales use English. Missing keys use the English value.
package copytext

const (
	User          = "user"
	NewFlashcards = "new_flashcards"
	UntitledNote  = "untitled_note"
	UntitledQuiz  = "untitled_quiz"
	// Suffixes of an embedded material's default title: "<note> · Quiz".
	EmbeddedQuiz       = "embedded_quiz"
	EmbeddedFlashcards = "embedded_flashcards"
)

var table = map[string]string{
	"user.en":                "User",
	"user.zh":                "用户",
	"new_flashcards.en":      "New flashcards",
	"new_flashcards.zh":      "新建闪卡",
	"untitled_note.en":       "Untitled note",
	"untitled_note.zh":       "未命名笔记",
	"untitled_quiz.en":       "Untitled quiz",
	"untitled_quiz.zh":       "未命名测验",
	"embedded_quiz.en":       "Quiz",
	"embedded_quiz.zh":       "测验",
	"embedded_flashcards.en": "Flashcards",
	"embedded_flashcards.zh": "闪卡",
}

func Locale(locale string) string {
	if locale == "zh" {
		return "zh"
	}
	return "en"
}

func T(locale, key string) string {
	locale = Locale(locale)
	if value, ok := table[key+"."+locale]; ok {
		return value
	}
	return table[key+".en"]
}
