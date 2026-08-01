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

func (a *api) getSourceUploadPolicy(
	_ context.Context,
	_ *struct{},
) (*sourceUploadPolicyOutput, error) {
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
			Mode:       sourceupload.ParseModeAdvanced,
			Extensions: sourceupload.ParseExtensions(sourceupload.ParseModeAdvanced),
			MaxBytes:   sourceupload.AdvancedMaxBytes,
		},
		{
			Mode:       sourceupload.ParseModeNormal,
			Extensions: sourceupload.ParseExtensions(sourceupload.ParseModeNormal),
			MaxBytes:   sourceupload.NormalMaxBytes,
			MaxPages:   sourceupload.NormalMaxPages,
		},
		{
			Mode:       sourceupload.ParseModeNone,
			Extensions: []string{},
			MaxBytes:   sourceupload.AdvancedMaxBytes,
		},
	}
	accept := sourceupload.SupportedExtensions()

	return &sourceUploadPolicyOutput{
		Body: apimodel.SourceUploadPolicy{
			Kinds:            kinds,
			ParseModes:       parseModes,
			Accept:           joinExtensions(accept),
			MaxBytes:         sourceupload.AdvancedMaxBytes,
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
