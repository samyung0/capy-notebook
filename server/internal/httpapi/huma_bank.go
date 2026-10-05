package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/samyung0/capy-notebook/server/internal/bank"
	"github.com/samyung0/capy-notebook/server/internal/mail"
	"github.com/samyung0/capy-notebook/server/internal/questions"
)

type bankQuestionInput struct {
	ID string `path:"id"`
}
type bankBatchInput struct {
	IDs []string `query:"ids" required:"true" minItems:"1" maxItems:"50" uniqueItems:"true" doc:"Comma-separated question ids, returned in this order"`
}
type bankTopicInput struct {
	TopicID string `path:"topicId"`
}
type bankSyllabusOutput struct{ Body bank.Syllabus }
type bankListBody struct {
	Questions []bank.Row `json:"questions"`
}
type bankListOutput struct{ Body bankListBody }
type bankDetailOutput struct{ Body bank.Detail }
type bankBatchBody struct {
	Questions []bank.Detail `json:"questions"`
}
type bankBatchOutput struct{ Body bankBatchBody }
type bankSaveInput struct {
	ID   string `path:"id"`
	Body struct {
		Question  map[string]any `json:"question"`
		UpdatedAt time.Time      `json:"updatedAt"`
	}
}
type bankReviewInput struct {
	ID   string `path:"id"`
	Body struct {
		Reviewed bool `json:"reviewed"`
	}
}
type bankCommentInput struct {
	ID   string `path:"id"`
	Body struct {
		Text string `json:"text" minLength:"1" maxLength:"2000"`
	}
}
type bankAssetForm struct {
	File huma.FormFile `form:"file" required:"true"`
}
type bankAssetInput struct {
	RawBody huma.MultipartFormFiles[bankAssetForm]
}
type bankAssetOutput struct {
	Body struct {
		URL string `json:"url"`
	}
}

func bankHTTPError(err error) error {
	if err == nil {
		return nil
	}
	status := http.StatusServiceUnavailable
	code := "bank_unavailable"
	switch {
	case errors.Is(err, bank.ErrUnconfigured):
		status = 404
		code = "bank_unconfigured"
	case errors.Is(err, bank.ErrReadOnly):
		status = 404
		code = "bank_read_only"
	case errors.Is(err, bank.ErrNotFound):
		return huma.Error404NotFound("not found")
	case errors.Is(err, bank.ErrConflict):
		status = 409
		code = "bank_conflict"
	}
	return &huma.ErrorModel{Status: status, Title: http.StatusText(status), Detail: code, Errors: []*huma.ErrorDetail{{Message: code}}}
}
func (a *api) bankAccess(ctx context.Context, write bool) (bool, error) {
	if !a.cfg.Bank.Configured() {
		return false, bankHTTPError(bank.ErrUnconfigured)
	}
	if !a.cfg.Bank.Editable() {
		if write {
			return false, bankHTTPError(bank.ErrReadOnly)
		}
		return false, nil
	}
	editor, err := a.s.BankEditor(ctx, userID(ctx))
	if err != nil {
		return false, hErr(err)
	}
	if write && !editor {
		return false, huma.Error404NotFound("not found")
	}
	return editor, nil
}
func (a *api) registerBank(api huma.API) {
	tag := "Question bank"
	reg(api, "GET", "/api/bank/syllabus", "bankSyllabus", tag, "Read the exam syllabus", 200, a.bankSyllabus)
	reg(api, "GET", "/api/bank/topics/{topicId}/questions", "bankQuestions", tag, "List topic questions", 200, a.bankList)
	reg(api, "GET", "/api/bank/questions", "bankQuestionBatch", tag, "Read bank questions by id", 200, a.bankBatch)
	reg(api, "GET", "/api/bank/questions/{id}", "bankQuestion", tag, "Read a bank question", 200, a.bankQuestion)
	regWithMaxBody(api, "PUT", "/api/bank/questions/{id}", "saveBankQuestion", tag, "Edit a bank question", 200, materialRequestMaxBytes, a.bankSave)
	reg(api, "PUT", "/api/bank/questions/{id}/review", "reviewBankQuestion", tag, "Set the review marker", 200, a.bankReview)
	reg(api, "POST", "/api/bank/questions/{id}/comments", "commentBankQuestion", tag, "Email a question comment", 204, a.bankComment)
	a.registerBankProgress(api)
	huma.Register(api, huma.Operation{OperationID: "uploadBankAsset", Method: "POST", Path: "/api/bank/assets", Summary: "Upload a public question figure", Tags: []string{tag}, DefaultStatus: 201,
		Middlewares: huma.Middlewares{func(ctx huma.Context, next func(huma.Context)) {
			if _, err := a.bankAccess(ctx.Context(), true); err != nil {
				writeStatusErr(api, ctx, err)
				return
			}
			r, w := humachi.Unwrap(ctx)
			r.Body = http.MaxBytesReader(w, r.Body, bank.AssetMaxBytes+(64<<10))
			next(ctx)
		}}}, func(ctx context.Context, in *bankAssetInput) (*bankAssetOutput, error) {
		out, err := a.bankAsset(ctx, in)
		return out, reportHandlerError(ctx, err)
	})
}
func (a *api) bankSyllabus(ctx context.Context, _ *struct{}) (*bankSyllabusOutput, error) {
	editor, err := a.bankAccess(ctx, false)
	if err != nil {
		return nil, err
	}
	body, err := a.cfg.Bank.Syllabus(ctx)
	if err != nil {
		return nil, bankHTTPError(err)
	}
	body.Editor = editor
	return &bankSyllabusOutput{Body: body}, nil
}
func (a *api) bankList(ctx context.Context, in *bankTopicInput) (*bankListOutput, error) {
	if _, err := a.bankAccess(ctx, false); err != nil {
		return nil, err
	}
	rows, err := a.cfg.Bank.List(ctx, in.TopicID)
	if err != nil {
		return nil, bankHTTPError(err)
	}
	ids := []string{}
	for _, r := range rows {
		if r.ReviewedBy != "" {
			ids = append(ids, r.ReviewedBy)
		}
	}
	names, err := a.s.BankUserNames(ctx, ids)
	if err != nil {
		return nil, hErr(err)
	}
	for i := range rows {
		rows[i].ReviewerName = names[rows[i].ReviewedBy]
	}
	return &bankListOutput{Body: bankListBody{Questions: rows}}, nil
}
func (a *api) bankDetail(ctx context.Context, id string, editor bool) (*bankDetailOutput, error) {
	body, err := a.cfg.Bank.Get(ctx, id)
	if err != nil {
		return nil, bankHTTPError(err)
	}
	details := []bank.Detail{body}
	if err := a.bankPresent(ctx, details, editor); err != nil {
		return nil, err
	}
	return &bankDetailOutput{Body: details[0]}, nil
}

// bankPresent adds attribution and reviewer names, and hides answers from learners.
func (a *api) bankPresent(ctx context.Context, details []bank.Detail, editor bool) error {
	ids := []string{}
	for i := range details {
		body := &details[i]
		body.Editor = editor
		var err error
		body.Provenance, err = a.cfg.Bank.Provenance(ctx, body.Sources)
		if err != nil {
			return bankHTTPError(err)
		}
		if body.Provenance != nil {
			if _, err := validateStoredProvenance(body.Provenance); err != nil {
				return bankHTTPError(bank.ErrUnavailable)
			}
		}
		if !editor {
			body.Question = questions.LearnerView(body.Question)
		}
		if body.ReviewedBy != "" {
			ids = append(ids, body.ReviewedBy)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	names, err := a.s.BankUserNames(ctx, ids)
	if err != nil {
		return hErr(err)
	}
	for i := range details {
		details[i].ReviewerName = names[details[i].ReviewedBy]
	}
	return nil
}
func (a *api) bankBatch(ctx context.Context, in *bankBatchInput) (*bankBatchOutput, error) {
	editor, err := a.bankAccess(ctx, false)
	if err != nil {
		return nil, err
	}
	details, err := a.cfg.Bank.GetMany(ctx, in.IDs)
	if err != nil {
		return nil, bankHTTPError(err)
	}
	if err := a.bankPresent(ctx, details, editor); err != nil {
		return nil, err
	}
	return &bankBatchOutput{Body: bankBatchBody{Questions: details}}, nil
}
func (a *api) bankQuestion(ctx context.Context, in *bankQuestionInput) (*bankDetailOutput, error) {
	editor, err := a.bankAccess(ctx, false)
	if err != nil {
		return nil, err
	}
	return a.bankDetail(ctx, in.ID, editor)
}
func (a *api) bankSave(ctx context.Context, in *bankSaveInput) (*bankDetailOutput, error) {
	if _, err := a.bankAccess(ctx, true); err != nil {
		return nil, err
	}
	if in.Body.Question["id"] != in.ID {
		return nil, huma.Error422UnprocessableEntity("question id must match the route")
	}
	if err := a.cfg.Bank.Validate(in.Body.Question); err != nil {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	if err := a.cfg.Bank.Save(ctx, in.ID, userID(ctx), in.Body.Question, in.Body.UpdatedAt); err != nil {
		return nil, bankHTTPError(err)
	}
	return a.bankDetail(ctx, in.ID, true)
}
func (a *api) bankReview(ctx context.Context, in *bankReviewInput) (*bankDetailOutput, error) {
	if _, err := a.bankAccess(ctx, true); err != nil {
		return nil, err
	}
	if err := a.cfg.Bank.Review(ctx, in.ID, userID(ctx), in.Body.Reviewed); err != nil {
		return nil, bankHTTPError(err)
	}
	return a.bankDetail(ctx, in.ID, true)
}
func (a *api) bankAsset(ctx context.Context, in *bankAssetInput) (*bankAssetOutput, error) {
	if _, err := a.bankAccess(ctx, true); err != nil {
		return nil, err
	}
	f := in.RawBody.Data().File
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, bank.AssetMaxBytes+1))
	if err != nil {
		return nil, huma.Error400BadRequest("could not read asset")
	}
	if _, _, err := bank.ValidateAsset(data); err != nil {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	link, err := bank.UploadAsset(ctx, a.cfg.BankAssets, a.cfg.BankAssetsURL, data)
	if err != nil {
		return nil, bankHTTPError(err)
	}
	out := &bankAssetOutput{}
	out.Body.URL = link
	return out, nil
}
func (a *api) bankComment(ctx context.Context, in *bankCommentInput) (*Empty, error) {
	if _, err := a.bankAccess(ctx, true); err != nil {
		return nil, err
	}
	if a.cfg.BankCommentEmail == "" {
		return nil, huma.Error404NotFound("bank comments are not configured")
	}
	text := strings.TrimSpace(in.Body.Text)
	if text == "" {
		return nil, huma.Error422UnprocessableEntity("comment is required")
	}
	if a.cfg.MailSender == nil {
		return nil, huma.Error503ServiceUnavailable("email unavailable")
	}
	detail, err := a.cfg.Bank.Get(ctx, in.ID)
	if err != nil {
		return nil, bankHTTPError(err)
	}
	name, email, err := a.s.BankCommentAuthor(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	link := strings.TrimRight(a.cfg.AppURL, "/") + "/bank/" + url.PathEscape(detail.TopicID) + "/" + url.PathEscape(in.ID) + "?mode=edit"
	body := fmt.Sprintf("%s\n%s · %s · %s\nQuestion %d\nFrom: %s <%s>\n\n%s", link, detail.ExamLabel, detail.SubjectLabel, detail.TopicLabel, detail.Position, name, email, text)
	sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if _, err := a.cfg.MailSender.Send(sendCtx, mail.Message{To: a.cfg.BankCommentEmail, Subject: "Question bank comment", Text: body}); err != nil {
		return nil, huma.Error503ServiceUnavailable("comment email could not be sent")
	}
	return &Empty{}, nil
}
