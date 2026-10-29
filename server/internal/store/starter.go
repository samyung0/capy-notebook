package store

import (
	"context"
	"encoding/json"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// StarterCopy is the starter workspace's sample content in one locale: a
// chapter holding a blank Word file and a welcome note with two embedded quiz
// questions and two flashcards (Epo 2026-10-29).
type StarterCopy struct {
	Chapter  string
	Document string
	note     starterNote
}

type starterNote struct {
	title, intro, holdsHeading            string
	holds                                 [3][]map[string]any
	tryIt, quizHeading, cardsHeading, end string
	mcqPrompt, mcqSolution                string
	mcqOptions                            [4]string
	mcqCorrect                            int
	tfPrompt, tfSolution                  string
	cards                                 [][2]string
}

func leaf(text string) map[string]any { return map[string]any{"text": text} }

func marked(text, mark string) map[string]any { return map[string]any{"text": text, mark: true} }

var starterCopies = map[string]StarterCopy{
	"en": {
		Chapter:  "Getting started",
		Document: "My first document",
		note: starterNote{
			title:        "Welcome to Capy Notebook",
			intro:        "This is a note: write in it like any document, and add study blocks that turn what you read into practice.",
			holdsHeading: "What a note can hold",
			holds: [3][]map[string]any{
				{leaf("Text, lists, tables, equations and diagrams from the "), marked("+", "kbd"), leaf(" menu")},
				{leaf("Quizzes and flashcards from the "), marked("Study", "bold"), leaf(" button in the toolbar")},
				{leaf("Comments for your study group, right next to the text")},
			},
			tryIt:        "Try it: answer the quiz below, then flip the cards.",
			quizHeading:  "Try a quiz",
			mcqPrompt:    "Which way of revising helps you remember the most a week later?",
			mcqOptions:   [4]string{"Rereading your notes", "Highlighting key sentences", "Testing yourself without looking", "Copying the summary out again"},
			mcqCorrect:   2,
			mcqSolution:  "Recalling an answer from memory (retrieval practice) strengthens it far more than reading it again.",
			tfPrompt:     "Spreading reviews over several days works better than one long session the night before.",
			tfSolution:   "True. This is the spacing effect: each review after a gap makes the memory last longer.",
			cardsHeading: "Flip some cards",
			cards: [][2]string{
				{"Retrieval practice", "Recalling information from memory instead of rereading it"},
				{"Spaced repetition", "Reviewing over spaced-out days so each memory lasts longer"},
			},
			end: "Next to this note is a blank Word file to write in. Add your own files from the Files panel, and they show up on the Study page.",
		},
	},
	"zh": {
		Chapter:  "入门",
		Document: "我的第一份文档",
		note: starterNote{
			title:        "欢迎使用 Capy Notebook",
			intro:        "这是一篇笔记：像普通文档一样书写，并添加学习模块，把读到的内容变成练习。",
			holdsHeading: "笔记可以包含什么",
			holds: [3][]map[string]any{
				{leaf("从 "), marked("+", "kbd"), leaf(" 菜单添加文字、列表、表格、公式和图表")},
				{leaf("从工具栏的"), marked("学习", "bold"), leaf("按钮添加测验和抽认卡")},
				{leaf("在文字旁边给学习小组留言评论")},
			},
			tryIt:        "试一试：先回答下面的测验，再翻看抽认卡。",
			quizHeading:  "做个小测验",
			mcqPrompt:    "哪种复习方式能让你一周后记得最多？",
			mcqOptions:   [4]string{"重读笔记", "划出重点句子", "不看资料自我测试", "再抄一遍总结"},
			mcqCorrect:   2,
			mcqSolution:  "凭记忆回想答案（提取练习）比再读一遍更能巩固记忆。",
			tfPrompt:     "把复习分散到几天进行，比考前一晚集中复习效果更好。",
			tfSolution:   "正确。这就是间隔效应：每隔一段时间复习一次，记忆会保持得更久。",
			cardsHeading: "翻看抽认卡",
			cards: [][2]string{
				{"提取练习", "凭记忆回想信息，而不是重读"},
				{"间隔重复", "把复习分散到不同的日子，让每段记忆保持得更久"},
			},
			end: "这篇笔记旁边有一份空白的 Word 文件，可以直接在里面书写。从“文件”面板添加你自己的文件，它们会出现在学习页面上。",
		},
	},
}

// StarterCopyFor is the sample content in the account's locale, English for
// any other.
func StarterCopyFor(locale string) StarterCopy {
	if c, ok := starterCopies[locale]; ok {
		return c
	}
	return starterCopies["en"]
}

// CreateStarterNote adds the welcome note, with its quiz and flashcards, to
// the starter workspace's chapter. The account pays for it, as for any note.
func (s *Store) CreateStarterNote(ctx context.Context, userID string, ws StarterWorkspace, chapterID string) (Material, error) {
	c := StarterCopyFor(ws.Locale).note
	quizID, cardsID := uid("mat"), uid("mat")
	block := func(kind string, children []map[string]any, extra map[string]any) map[string]any {
		node := map[string]any{"type": kind, "id": uid("n"), "children": children}
		for k, v := range extra {
			node[k] = v
		}
		return node
	}
	text := func(s string) []map[string]any { return []map[string]any{leaf(s)} }
	ref := func(id, kind string) map[string]any {
		return block("material_ref", text(""), map[string]any{"materialId": id, "refKind": kind})
	}
	bullet := map[string]any{"indent": 1, "listStyleType": "disc"}
	value := []map[string]any{
		block("h1", text(c.title), nil),
		block("p", text(c.intro), nil),
		block("h2", text(c.holdsHeading), nil),
		block("p", c.holds[0], bullet),
		block("p", c.holds[1], bullet),
		block("p", c.holds[2], bullet),
		block("callout", []map[string]any{block("p", text(c.tryIt), nil)}, map[string]any{"variant": "info"}),
		block("h2", text(c.quizHeading), nil),
		ref(quizID, "quiz"),
		block("h2", text(c.cardsHeading), nil),
		ref(cardsID, "flashcards"),
		block("p", text(c.end), nil),
	}
	content, err := json.Marshal(materialdoc.Envelope{SchemaVersion: materialdoc.SchemaVersion, Value: value})
	if err != nil {
		return Material{}, err
	}
	part := func(id, prompt, solution string, answer map[string]any) map[string]any {
		return map[string]any{
			"id": id, "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []map[string]any{{
				"id": id + ":part", "marks": 1, "answer": answer,
				"blocks":   []map[string]any{{"type": "text", "text": prompt}},
				"solution": []map[string]any{{"type": "text", "text": solution}},
			}},
		}
	}
	questions, err := json.Marshal([]map[string]any{
		part(uid("q"), c.mcqPrompt, c.mcqSolution, map[string]any{
			"type": "mcq", "options": c.mcqOptions[:], "correct": []int{c.mcqCorrect},
		}),
		part(uid("q"), c.tfPrompt, c.tfSolution, map[string]any{"type": "boolean", "correct": true}),
	})
	if err != nil {
		return Material{}, err
	}
	return s.CreateMaterialDraft(ctx, MaterialDraft{
		ActorUserID: userID, WorkspaceID: ws.ID, WorkspaceName: starterWorkspaceName,
		Kind: "note", Title: c.title, Content: string(content), ChapterID: &chapterID,
		Color: "blue",
		Embedded: []EmbeddedDraft{
			{ID: quizID, Kind: "quiz", Questions: questions},
			{ID: cardsID, Kind: "flashcards", Cards: c.cards},
		},
	})
}
