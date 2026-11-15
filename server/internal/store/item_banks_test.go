package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"
)

func bankQuestion(t *testing.T, id, text string, extra ...map[string]any) map[string]any {
	t.Helper()
	var q map[string]any
	if err := json.Unmarshal([]byte(`{"id":"`+id+`","stem":[],"layout":"paper","labels":"letters",
		"parts":[{"id":"p1","blocks":[{"type":"text","text":"`+text+`"}],
		"answer":{"type":"short","accepted":["osmosis"]},"marks":2,"solution":[]}]}`), &q); err != nil {
		t.Fatal(err)
	}
	for _, block := range extra {
		q["stem"] = append(q["stem"].([]any), block)
	}
	return q
}

// A person's own bank is theirs alone; a class's is its owner's and editors',
// never a viewer's, and a personal workspace has none. Search reads the
// question's words and answers, Tags keeps questions holding any of them.
func TestItemBanksAccessSearchAndTags(t *testing.T) {
	f := newStudyFixture(t, "item-banks")
	ctx := context.Background()
	editor := newBlobTestUser(t, f.s, "item-banks-editor")
	viewer := newBlobTestUser(t, f.s, "item-banks-viewer")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'editor'), ($1,$3,'viewer')`, f.ws.ID, editor, viewer); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.ListItemBankQuestions(ctx, f.user, f.ws.ID, ItemBankFilter{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a personal workspace's bank: err %v", err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='class' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}

	mine, err := f.s.CreateItemBankQuestion(ctx, f.user, PersonalBank, bankQuestion(t, "q1", "Define diffusion"), []string{"cells"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CreateItemBankQuestion(ctx, editor, f.ws.ID, bankQuestion(t, "q2", "Explain turgor"), []string{"osmosis", "plants"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CreateItemBankQuestion(ctx, f.user, f.ws.ID, bankQuestion(t, "q3", "Name the organelle"), []string{"cells"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CreateItemBankQuestion(ctx, viewer, f.ws.ID, bankQuestion(t, "q4", "Mine"), nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a viewer adds to the class bank: err %v", err)
	}
	if _, err := f.s.ListItemBankQuestions(ctx, viewer, f.ws.ID, ItemBankFilter{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a viewer reads the class bank: err %v", err)
	}
	theirs, err := f.s.ListItemBankQuestions(ctx, editor, PersonalBank, ItemBankFilter{})
	if err != nil || theirs.Total != 0 {
		t.Fatalf("the editor's own bank = %+v, err %v", theirs, err)
	}

	ids := func(page ItemBankPage) []string {
		var out []string
		for _, item := range page.Items {
			out = append(out, item.Question["id"].(string))
		}
		return out
	}
	all, err := f.s.ListItemBankQuestions(ctx, editor, f.ws.ID, ItemBankFilter{Limit: 1})
	if err != nil || all.Total != 2 || !slices.Equal(ids(all), []string{"q3"}) || all.NextCursor == "" {
		t.Fatalf("first page = %v (total %d), err %v", ids(all), all.Total, err)
	}
	next, err := f.s.ListItemBankQuestions(ctx, editor, f.ws.ID, ItemBankFilter{Limit: 1, Cursor: all.NextCursor})
	if err != nil || !slices.Equal(ids(next), []string{"q2"}) {
		t.Fatalf("second page = %v, err %v", ids(next), err)
	}
	// An answer is searched too.
	found, err := f.s.ListItemBankQuestions(ctx, f.user, f.ws.ID, ItemBankFilter{Query: "OSMOSIS", Tags: []string{"plants", "none"}})
	if err != nil || found.Total != 1 || !slices.Equal(ids(found), []string{"q2"}) {
		t.Fatalf("search = %v, err %v", ids(found), err)
	}
	tags, err := f.s.ItemBankTags(ctx, f.user, f.ws.ID)
	if err != nil || !slices.Equal(tags, []string{"cells", "osmosis", "plants"}) {
		t.Fatalf("tags = %v, err %v", tags, err)
	}

	banks, err := f.s.ItemBanks(ctx, editor, f.ws.ID)
	if err != nil || len(banks) != 2 || banks[0].ID != f.ws.ID || banks[0].Count != 2 || banks[1].ID != PersonalBank {
		t.Fatalf("the editor's banks = %+v, err %v", banks, err)
	}
	if banks, err := f.s.ItemBanks(ctx, viewer, f.ws.ID); err != nil || len(banks) != 1 || banks[0].Kind != "personal" {
		t.Fatalf("the viewer's banks = %+v, err %v", banks, err)
	}

	edited, err := f.s.UpdateItemBankQuestion(ctx, f.user, PersonalBank, mine.ID, bankQuestion(t, "q1", "Define osmosis"), []string{"water"})
	if err != nil || !slices.Equal(edited.Tags, []string{"water"}) {
		t.Fatalf("edited = %+v, err %v", edited, err)
	}
	if err := f.s.DeleteItemBankQuestion(ctx, f.user, PersonalBank, mine.ID); err != nil {
		t.Fatal(err)
	}

	// A purged account's own bank goes with it; the class keeps what it added.
	if _, err := f.s.CreateItemBankQuestion(ctx, editor, PersonalBank, bankQuestion(t, "q5", "Own"), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.RequestAccountDeletion(ctx, editor, true); err != nil {
		t.Fatal(err)
	}
	if err := f.s.PurgeUser(ctx, editor); err != nil {
		t.Fatal(err)
	}
	var own, class int
	if err := f.s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM item_bank_questions WHERE user_id=$1),
		(SELECT count(*) FROM item_bank_questions WHERE workspace_id=$2)`, editor, f.ws.ID).Scan(&own, &class); err != nil {
		t.Fatal(err)
	}
	if own != 0 || class != 2 {
		t.Fatalf("after the purge: own %d, class %d", own, class)
	}
}

// Search tolerates typos as global search does: hits holding the query come
// first, newest first, then those with typos, and a hit with typos goes once
// searchFewHits closer hits are found. Its pages carry an offset.
func TestItemBankTypoSearch(t *testing.T) {
	f := newStudyFixture(t, "item-bank-typos")
	ctx := context.Background()
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='class' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	add := func(id, text string, age int) {
		t.Helper()
		q, err := f.s.CreateItemBankQuestion(ctx, f.user, f.ws.ID, bankQuestion(t, id, text), nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.s.pool.Exec(ctx, `UPDATE item_bank_questions SET created_at = now() - make_interval(mins => $2) WHERE id=$1`, q.ID, age); err != nil {
			t.Fatal(err)
		}
	}
	search := func(query, cursor string, limit int) ItemBankPage {
		t.Helper()
		page, err := f.s.ListItemBankQuestions(ctx, f.user, f.ws.ID, ItemBankFilter{Query: query, Limit: limit, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		return page
	}
	ids := func(page ItemBankPage) []string {
		var out []string
		for _, item := range page.Items {
			out = append(out, item.Question["id"].(string))
		}
		return out
	}
	add("old", "Define turgor", 30)
	add("typo", "Explain turbor", 10)
	add("new", "Turgor in cells", 20)
	add("other", "Name the organelle", 5)

	first := search("turgor", "", 2)
	if first.Total != 3 || !slices.Equal(ids(first), []string{"new", "old"}) || first.NextCursor == "" {
		t.Fatalf("first page = %v (total %d)", ids(first), first.Total)
	}
	if next := search("turgor", first.NextCursor, 2); !slices.Equal(ids(next), []string{"typo"}) || next.NextCursor != "" {
		t.Fatalf("second page = %v", ids(next))
	}
	if _, err := f.s.ListItemBankQuestions(ctx, f.user, f.ws.ID, ItemBankFilter{Query: "turgor", Cursor: encodeListCursor("x", bankSearchCursor)}); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("a bad search cursor: err %v", err)
	}

	add("third", "Turgor and wilting", 40)
	if page := search("turgor", "", 10); !slices.Equal(ids(page), []string{"new", "old", "third"}) || page.Total != 3 {
		t.Fatalf("with three exact hits = %v (total %d)", ids(page), page.Total)
	}
}

// Add to bank copies the quiz's images for the bank question, charged to who
// added it and readable only by the bank's readers; they go with the question.
func TestItemBankCopiesQuestionImages(t *testing.T) {
	f := newStudyFixture(t, "item-bank-images")
	ctx := context.Background()
	other := newBlobTestUser(t, f.s, "item-bank-images-other")
	quiz, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "Paper", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name,
		Questions: json.RawMessage(`[]`), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	source := readyAsset(t, f.s, quiz.ID, f.user, "image")
	image := map[string]any{"type": "image", "image": map[string]any{"assetId": source}, "width": 10.0, "height": 10.0}

	item, err := f.s.CreateItemBankQuestion(ctx, f.user, PersonalBank, bankQuestion(t, "q1", "Label it", image), nil)
	if err != nil {
		t.Fatal(err)
	}
	copied := item.Question["stem"].([]any)[0].(map[string]any)["image"].(map[string]any)["assetId"].(string)
	asset, err := f.s.GetEditorAsset(ctx, copied)
	if err != nil || copied == source || asset.BankQuestionID != item.ID || asset.UserID != f.user {
		t.Fatalf("copy %s = %+v, err %v", copied, asset, err)
	}
	if ok, err := f.s.EditorAssetReadable(ctx, f.user, asset); err != nil || !ok {
		t.Fatalf("the owner reads the copy: %v, err %v", ok, err)
	}
	if ok, err := f.s.EditorAssetReadable(ctx, other, asset); err != nil || ok {
		t.Fatalf("someone else reads the copy: %v, err %v", ok, err)
	}
	// Saving it again keeps its own copy.
	again, err := f.s.UpdateItemBankQuestion(ctx, f.user, PersonalBank, item.ID, item.Question, []string{"labels"})
	if err != nil || again.Question["stem"].([]any)[0].(map[string]any)["image"].(map[string]any)["assetId"] != copied {
		t.Fatalf("saved again = %+v, err %v", again, err)
	}
	if err := f.s.DeleteItemBankQuestion(ctx, f.user, PersonalBank, item.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.GetEditorAsset(ctx, copied); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the copy outlived its question: err %v", err)
	}
}

// From the bank copies the picked questions, in the order picked, into a new
// quiz with fresh ids; their images become the quiz's own, charged to the
// copier. A bank the caller does not read is not found.
func TestCreateQuizFromBankCopiesQuestionsAndImages(t *testing.T) {
	f := newStudyFixture(t, "item-bank-quiz")
	ctx := context.Background()
	editor := newBlobTestUser(t, f.s, "item-bank-quiz-editor")
	viewer := newBlobTestUser(t, f.s, "item-bank-quiz-viewer")
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='class' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'editor'), ($1,$3,'viewer')`, f.ws.ID, editor, viewer); err != nil {
		t.Fatal(err)
	}
	paper, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "Paper", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name,
		Questions: json.RawMessage(`[]`), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	source := readyAsset(t, f.s, paper.ID, f.user, "image")
	image := map[string]any{"type": "image", "image": map[string]any{"assetId": source}, "width": 10.0, "height": 10.0}
	first, err := f.s.CreateItemBankQuestion(ctx, f.user, f.ws.ID, bankQuestion(t, "q1", "Label it", image), nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.s.CreateItemBankQuestion(ctx, f.user, f.ws.ID, bankQuestion(t, "q1", "Again"), nil)
	if err != nil {
		t.Fatal(err)
	}
	banked := first.Question["stem"].([]any)[0].(map[string]any)["image"].(map[string]any)["assetId"].(string)

	if _, err := f.s.CreateQuizFromBank(ctx, BankQuiz{ActorID: viewer, Bank: f.ws.ID, WorkspaceID: f.ws.ID,
		WorkspaceName: f.ws.Name, QuestionIDs: []string{first.ID}, Title: "Theirs"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a viewer copies from the class bank: err %v", err)
	}
	made, err := f.s.CreateQuizFromBank(ctx, BankQuiz{ActorID: editor, Bank: f.ws.ID, WorkspaceID: f.ws.ID,
		WorkspaceName: f.ws.Name, QuestionIDs: []string{second.ID, first.ID}, Title: "From the bank", GradedPending: true})
	if err != nil {
		t.Fatal(err)
	}
	if !made.Hidden || made.OwnerUserID != editor || made.Kind != "quiz" {
		t.Fatalf("made = %+v", made)
	}
	quiz, err := f.s.GetQuiz(ctx, made.ID)
	if err != nil {
		t.Fatal(err)
	}
	var qs []map[string]any
	if err := json.Unmarshal(quiz.Questions, &qs); err != nil {
		t.Fatal(err)
	}
	// Both bank questions came from "q1": the copies get their own ids.
	if len(qs) != 2 || qs[0]["id"] == qs[1]["id"] || qs[0]["id"] == "q1" ||
		qs[0]["parts"].([]any)[0].(map[string]any)["blocks"].([]any)[0].(map[string]any)["text"] != "Again" {
		t.Fatalf("questions = %v", qs)
	}
	copied := qs[1]["stem"].([]any)[0].(map[string]any)["image"].(map[string]any)["assetId"].(string)
	asset, err := f.s.GetEditorAsset(ctx, copied)
	if err != nil || copied == banked || asset.MaterialID != made.ID || asset.UserID != editor || asset.BankQuestionID != "" {
		t.Fatalf("copy %s = %+v, err %v", copied, asset, err)
	}
	// The bank keeps its own image.
	if _, err := f.s.GetEditorAsset(ctx, banked); err != nil {
		t.Fatal(err)
	}
}

// A class bank's image is listed in its payer's Files (Epo 2026-11-14), as
// unreachable once they are no longer the class's staff; gone with their
// account, a copy into a quiz drops it rather than failing.
func TestBankImagesListAndGoMissing(t *testing.T) {
	f := newStudyFixture(t, "item-bank-payer")
	ctx := context.Background()
	editor := newBlobTestUser(t, f.s, "item-bank-payer-editor")
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='class' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'editor')`, f.ws.ID, editor); err != nil {
		t.Fatal(err)
	}
	paper, err := f.s.CreateQuiz(ctx, Quiz{UserID: editor, Name: "Paper", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name,
		Questions: json.RawMessage(`[]`), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	source := readyAsset(t, f.s, paper.ID, editor, "image")
	image := map[string]any{"type": "image", "image": map[string]any{"assetId": source}, "width": 10.0, "height": 10.0}
	item, err := f.s.CreateItemBankQuestion(ctx, editor, f.ws.ID, bankQuestion(t, "q1", "Label it", image), nil)
	if err != nil {
		t.Fatal(err)
	}
	banked := item.Question["stem"].([]any)[0].(map[string]any)["image"].(map[string]any)["assetId"].(string)
	listed := func() *EditorAssetItem {
		t.Helper()
		page, err := f.s.ListItems(ctx, editor, ItemListFilter{Kinds: []string{"image"}})
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range page.Items {
			if row.Embed != nil && row.Embed.ID == banked {
				return row.Embed
			}
		}
		return nil
	}
	if got := listed(); got == nil || !got.Bank || got.LostAccess || got.WorkspaceID != f.ws.ID || got.MaterialID != "" {
		t.Fatalf("the bank image in Files = %+v", got)
	}
	if _, err := f.s.pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, f.ws.ID, editor); err != nil {
		t.Fatal(err)
	}
	if got := listed(); got == nil || !got.LostAccess || got.WorkspaceID != "" {
		t.Fatalf("the bank image after leaving = %+v", got)
	}

	// Their purge takes the image; the question copies without it.
	if _, err := f.s.pool.Exec(ctx, `DELETE FROM editor_assets WHERE user_id=$1`, editor); err != nil {
		t.Fatal(err)
	}
	made, err := f.s.CreateQuizFromBank(ctx, BankQuiz{ActorID: f.user, Bank: f.ws.ID, WorkspaceID: f.ws.ID,
		WorkspaceName: f.ws.Name, QuestionIDs: []string{item.ID}, Title: "From the bank"})
	if err != nil {
		t.Fatal(err)
	}
	quiz, err := f.s.GetQuiz(ctx, made.ID)
	if err != nil {
		t.Fatal(err)
	}
	var qs []map[string]any
	if err := json.Unmarshal(quiz.Questions, &qs); err != nil {
		t.Fatal(err)
	}
	if len(qs) != 1 || len(qs[0]["stem"].([]any)) != 0 {
		t.Fatalf("questions = %v", qs)
	}
}

// A class bank's question keeps topics of its workspace (Epo 2026-11-15): the
// Topic filter keeps those carrying any picked topic, a deleted topic or any
// in My bank is left out, and a copy keeps them only in that workspace's quiz.
func TestItemBankTopics(t *testing.T) {
	f := newStudyFixture(t, "item-bank-topics")
	ctx := context.Background()
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='class' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	cells, err := f.s.AddTopic(ctx, f.ws.ID, f.user, "Cells", "")
	if err != nil {
		t.Fatal(err)
	}
	genes, err := f.s.AddTopic(ctx, f.ws.ID, f.user, "Genes", "")
	if err != nil {
		t.Fatal(err)
	}
	withTopics := func(id, text string, topicIDs ...any) map[string]any {
		q := bankQuestion(t, id, text)
		q["topicIds"] = topicIDs
		return q
	}
	topicsOf := func(q map[string]any) string { return fmt.Sprint(q["topicIds"]) }
	both := fmt.Sprint([]any{cells.ID, genes.ID})
	onBoth, err := f.s.CreateItemBankQuestion(ctx, f.user, f.ws.ID, withTopics("q1", "Name the organelle", cells.ID, genes.ID), nil)
	if err != nil || topicsOf(onBoth.Question) != both {
		t.Fatalf("onBoth = %+v, err %v", onBoth.Question, err)
	}
	onGenes, err := f.s.CreateItemBankQuestion(ctx, f.user, f.ws.ID, withTopics("q2", "Define an allele", genes.ID), nil)
	if err != nil {
		t.Fatal(err)
	}
	mine, err := f.s.CreateItemBankQuestion(ctx, f.user, PersonalBank, withTopics("q3", "Mine", cells.ID), nil)
	if err != nil || mine.Question["topicIds"] != nil {
		t.Fatalf("My bank's question = %+v, err %v", mine.Question, err)
	}

	filtered := func(topics ...string) []string {
		t.Helper()
		page, err := f.s.ListItemBankQuestions(ctx, f.user, f.ws.ID, ItemBankFilter{Topics: topics})
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, item := range page.Items {
			ids = append(ids, item.ID)
		}
		slices.Sort(ids)
		return ids
	}
	want := []string{onBoth.ID, onGenes.ID}
	slices.Sort(want)
	if got := filtered(cells.ID); !slices.Equal(got, []string{onBoth.ID}) {
		t.Fatalf("Cells filter = %v, want [%s]", got, onBoth.ID)
	}
	if got := filtered(genes.ID); !slices.Equal(got, want) {
		t.Fatalf("Genes filter = %v, want %v", got, want)
	}

	copyTo := func(wsID, name string) map[string]any {
		t.Helper()
		made, err := f.s.CreateQuizFromBank(ctx, BankQuiz{ActorID: f.user, Bank: f.ws.ID, WorkspaceID: wsID,
			WorkspaceName: name, QuestionIDs: []string{onBoth.ID}, Title: "From the bank"})
		if err != nil {
			t.Fatal(err)
		}
		quiz, err := f.s.GetQuiz(ctx, made.ID)
		if err != nil {
			t.Fatal(err)
		}
		var qs []map[string]any
		if err := json.Unmarshal(quiz.Questions, &qs); err != nil {
			t.Fatal(err)
		}
		return qs[0]
	}
	if got := copyTo(f.ws.ID, f.ws.Name); topicsOf(got) != both {
		t.Fatalf("copy into its class = %v", got)
	}
	other, err := f.s.CreateWorkspace(ctx, f.user, WorkspaceCreate{Name: "Other", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if got := copyTo(other.ID, other.Name); got["topicIds"] != nil {
		t.Fatalf("copy elsewhere = %v", got)
	}

	if err := f.s.DeleteTopic(ctx, f.user, cells.ID); err != nil {
		t.Fatal(err)
	}
	page, err := f.s.ListItemBankQuestions(ctx, f.user, f.ws.ID, ItemBankFilter{})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range page.Items {
		if item.ID == onBoth.ID && topicsOf(item.Question) != fmt.Sprint([]any{genes.ID}) {
			t.Fatalf("once Cells is deleted = %v, want Genes alone", item.Question["topicIds"])
		}
	}
}

// The editor's From the bank (Epo 2026-11-15) copies picked questions for an
// existing quiz, in the order picked, with fresh ids: the topic stays in the
// bank's own class workspace and goes elsewhere, and an image becomes the
// quiz's own editor asset. The quiz's content is left to its rooms.
func TestItemBankCopiesIntoQuiz(t *testing.T) {
	f := newStudyFixture(t, "item-bank-into-quiz")
	ctx := context.Background()
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='class' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	cells, err := f.s.AddTopic(ctx, f.ws.ID, f.user, "Cells", "")
	if err != nil {
		t.Fatal(err)
	}
	newQuiz := func(wsID, wsName string) Quiz {
		t.Helper()
		quiz, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "Paper", WorkspaceID: wsID, WorkspaceName: wsName,
			Questions: json.RawMessage(`[]`), Privacy: PrivacyPrivate})
		if err != nil {
			t.Fatal(err)
		}
		return quiz
	}
	paper := newQuiz(f.ws.ID, f.ws.Name)
	source := readyAsset(t, f.s, paper.ID, f.user, "image")
	image := map[string]any{"type": "image", "image": map[string]any{"assetId": source}, "width": 10.0, "height": 10.0}
	pictured := bankQuestion(t, "q1", "Label it", image)
	pictured["topicIds"] = []any{cells.ID}
	first, err := f.s.CreateItemBankQuestion(ctx, f.user, f.ws.ID, pictured, nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.s.CreateItemBankQuestion(ctx, f.user, f.ws.ID, bankQuestion(t, "q1", "Again"), nil)
	if err != nil {
		t.Fatal(err)
	}

	copies, err := f.s.CopyBankQuestionsToQuiz(ctx, f.user, paper.ID, f.ws.ID, []string{second.ID, first.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(copies) != 2 || copies[0]["id"] == copies[1]["id"] || copies[1]["id"] == "q1" ||
		copies[0]["parts"].([]any)[0].(map[string]any)["blocks"].([]any)[0].(map[string]any)["text"] != "Again" ||
		copies[1]["parts"].([]any)[0].(map[string]any)["id"] == "p1" || fmt.Sprint(copies[1]["topicIds"]) != fmt.Sprint([]any{cells.ID}) {
		t.Fatalf("copies = %v", copies)
	}
	copied := copies[1]["stem"].([]any)[0].(map[string]any)["image"].(map[string]any)["assetId"].(string)
	asset, err := f.s.GetEditorAsset(ctx, copied)
	if err != nil || asset.MaterialID != paper.ID || asset.WorkspaceID != f.ws.ID || asset.UserID != f.user || asset.BankQuestionID != "" {
		t.Fatalf("copy %s = %+v, err %v", copied, asset, err)
	}

	other, err := f.s.CreateWorkspace(ctx, f.user, WorkspaceCreate{Name: "Other", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	elsewhere := newQuiz(other.ID, other.Name)
	copies, err = f.s.CopyBankQuestionsToQuiz(ctx, f.user, elsewhere.ID, f.ws.ID, []string{first.ID})
	if err != nil || copies[0]["topicIds"] != nil {
		t.Fatalf("copy elsewhere = %v, err %v", copies, err)
	}
}
