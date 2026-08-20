package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/sourceupload"
	"github.com/evonotes/server/internal/store"
)

type sourceUploadPolicyOutput struct {
	Body apimodel.SourceUploadPolicy
}

func (a *api) registerSourceUploads(api huma.API) {
	reg(
		api,
		http.MethodGet,
		"/api/source-upload-policy",
		"getSourceUploadPolicy",
		"Content",
		"Get source upload policy",
		http.StatusOK,
		a.getSourceUploadPolicy,
	)
}

type sourceUploadPolicyInput struct {
	WorkspaceID string `query:"workspaceId"`
}

func (a *api) getSourceUploadPolicy(
	ctx context.Context,
	in *sourceUploadPolicyInput,
) (*sourceUploadPolicyOutput, error) {
	if in.WorkspaceID != "" {
		if _, err := a.workspaceRead(ctx, in.WorkspaceID); err != nil {
			return nil, hErr(err)
		}
	}
	maxBytes, err := a.sourceMaxBytes(ctx, in.WorkspaceID)
	if err != nil {
		return nil, hErr(err)
	}
	extensionsByKind := sourceupload.ExtensionsByKind()
	kindOrder := []store.FileKind{
		store.FilePDF,
		store.FileDoc,
		store.FileMD,
		store.FileImage,
		store.FileTxt,
		store.FileSheet,
		store.FileSlides,
		store.FileAudio,
		store.FileJson,
	}
	textKinds := map[store.FileKind]bool{
		store.FileMD:   true,
		store.FileTxt:  true,
		store.FileJson: true,
	}
	kinds := make([]apimodel.SourceUploadKindPolicy, 0, len(kindOrder))
	for _, kind := range kindOrder {
		kinds = append(kinds, apimodel.SourceUploadKindPolicy{
			Kind:       kind,
			Extensions: extensionsByKind[string(kind)],
			Text:       textKinds[kind],
		})
	}

	parseModes := []apimodel.SourceUploadParseModePolicy{
		{
			Mode:            sourceupload.ParseModeFast,
			Extensions:      sourceupload.ParseExtensions(sourceupload.ParseModeFast),
			MaxBytes:        maxBytes,
			SupportsFigures: true,
		},
		{
			Mode:       sourceupload.ParseModeNone,
			Extensions: []string{},
			MaxBytes:   maxBytes,
		},
	}
	accept := sourceupload.SupportedExtensions()

	return &sourceUploadPolicyOutput{
		Body: apimodel.SourceUploadPolicy{
			Kinds:            kinds,
			ParseModes:       parseModes,
			Accept:           joinExtensions(accept),
			MaxBytes:         maxBytes,
			AllowNoExtension: false,
		},
	}, nil
}

func joinExtensions(extensions []string) string {
	result := ""
	for i, ext := range extensions {
		if i > 0 {
			result += ","
		}
		result += ext
	}
	return result
}
