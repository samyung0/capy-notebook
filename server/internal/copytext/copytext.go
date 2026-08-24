// Package copytext holds locale-aware display strings for server-created
// names. Unknown locales use English. Missing keys use the English value.
package copytext

const (
	User         = "user"
	NewDeck      = "new_deck"
	UntitledNote = "untitled_note"
	UntitledQuiz = "untitled_quiz"
)

var table = map[string]string{
	"user.en":          "User",
	"user.zh":          "用户",
	"new_deck.en":      "New deck",
	"new_deck.zh":      "新建卡组",
	"untitled_note.en": "Untitled note",
	"untitled_note.zh": "未命名笔记",
	"untitled_quiz.en": "Untitled quiz",
	"untitled_quiz.zh": "未命名测验",
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
