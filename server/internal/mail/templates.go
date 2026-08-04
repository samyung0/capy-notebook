package mail

import (
	"bytes"
	"embed"
	"fmt"
	htmltemplate "html/template"
	"strings"
	texttemplate "text/template"
)

// The React Email build step writes these files from emails/*.tsx. Keeping the
// rendered artifacts in the Go package means production does not need Node.
//
//go:embed templates/*.gohtml templates/*.txt
var templateFS embed.FS

// RoleLabel translates a workspace role for use inside an email. Unknown roles
// fall back to the raw identifier so a new role never blocks delivery.
func RoleLabel(role, locale string) string {
	if label, ok := roleLabels[role+"."+normalizeLocale(locale)]; ok {
		return label
	}
	return role
}

func Render(templateName, locale string, data any) (subject, html, text string, err error) {
	locale = normalizeLocale(locale)
	key := templateName + "." + locale

	subjectTemplate, ok := subjectTemplates[key]
	if !ok {
		return "", "", "", fmt.Errorf("unknown email template %q", key)
	}
	subjectTmpl, err := texttemplate.New("subject").Parse(subjectTemplate)
	if err != nil {
		return "", "", "", err
	}
	var subjectBuf bytes.Buffer
	if err := subjectTmpl.Execute(&subjectBuf, data); err != nil {
		return "", "", "", err
	}

	htmlTmpl, err := htmltemplate.New(templateName).ParseFS(templateFS, "templates/"+key+".gohtml")
	if err != nil {
		return "", "", "", err
	}
	var htmlBuf bytes.Buffer
	if err := htmlTmpl.ExecuteTemplate(&htmlBuf, key+".gohtml", data); err != nil {
		return "", "", "", err
	}

	textTmpl, err := texttemplate.New(templateName).ParseFS(templateFS, "templates/"+key+".txt")
	if err != nil {
		return "", "", "", err
	}
	var textBuf bytes.Buffer
	if err := textTmpl.ExecuteTemplate(&textBuf, key+".txt", data); err != nil {
		return "", "", "", err
	}
	return subjectBuf.String(), htmlBuf.String(), textBuf.String(), nil
}

func normalizeLocale(locale string) string {
	if strings.EqualFold(locale, "zh") {
		return "zh"
	}
	return "en"
}
