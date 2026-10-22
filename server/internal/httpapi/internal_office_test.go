package httpapi

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Each edit_office_document command reaches the engine in its own JSON:
// snake_case type, camelCase fields, format_cells' style object.
func TestNormalizeOfficeCommands(t *testing.T) {
	for _, tc := range []struct{ format, model, engine string }{
		{"xlsx", `{"type":"set_range","sheet":"Grades","range":"A1:B1","expected":[["","x"]],"values":[["=SUM(C1:C3)","y"]]}`,
			`{"expected":[["","x"]],"range":"A1:B1","sheet":"Grades","type":"set_range","values":[["=SUM(C1:C3)","y"]]}`},
		{"xlsx", `{"type":"format_cells","sheet":"0","range":"A1:H1","bold":true,"italic":false,"font_family":"Arial","font_size":12,` +
			`"text_color":"#1F4E79","fill_color":"#FFF2CC","horizontal_alignment":"center","vertical_alignment":"middle","wrap":true,"number_format":"plain_text"}`,
			`{"range":"A1:H1","sheet":"0","style":{"bold":true,"fillColor":"#FFF2CC","fontFamily":"Arial",` +
				`"fontSize":12,"horizontalAlignment":"center","italic":false,"numberFormat":{"type":"plainText"},"textColor":"#1F4E79","textWrapping":"wrap","verticalAlignment":"middle"},"type":"format_cells"}`},
		{"xlsx", `{"type":"format_cells","sheet":"0","range":"B2:B9","number_format":"0.0%"}`,
			`{"range":"B2:B9","sheet":"0","style":{"numberFormat":{"pattern":"0.0%","type":"custom"}},"type":"format_cells"}`},
		{"xlsx", `{"type":"format_cells","sheet":"0","range":"B2:B9","number_format":"Percent"}`,
			`{"range":"B2:B9","sheet":"0","style":{"numberFormat":{"type":"percent"}},"type":"format_cells"}`},
		{"xlsx", `{"type":"format_cells","sheet":"0","range":"B2:B9","number_format":"General"}`,
			`{"range":"B2:B9","sheet":"0","style":{"numberFormat":{"type":"automatic"}},"type":"format_cells"}`},
		{"xlsx", `{"type":"add_sheet","name":"Summary","after":"Grades"}`, `{"after":"Grades","name":"Summary","type":"add_sheet"}`},
		{"xlsx", `{"type":"add_sheet","name":"Summary"}`, `{"name":"Summary","type":"add_sheet"}`},
		{"xlsx", `{"type":"rename_sheet","sheet":"0","expected_name":"Sheet1","name":"Grades"}`,
			`{"expectedName":"Sheet1","name":"Grades","sheet":"0","type":"rename_sheet"}`},
		{"xlsx", `{"type":"insert_rows","sheet":"0","at":3,"count":2}`, `{"at":3,"count":2,"sheet":"0","type":"insert_rows"}`},
		// A delete's band is a grid of rows, so cells may hold tabs and line
		// breaks; [] expects an empty band (review finding 6).
		{"xlsx", `{"type":"delete_rows","sheet":"0","at":3,"count":1,"expected":[["Ann","91"],["a\nb","x\ty"]]}`,
			`{"at":3,"count":1,"expected":[["Ann","91"],["a\nb","x\ty"]],"sheet":"0","type":"delete_rows"}`},
		{"xlsx", `{"type":"delete_rows","sheet":"0","at":3,"count":2,"expected":[]}`,
			`{"at":3,"count":2,"expected":[],"sheet":"0","type":"delete_rows"}`},
		{"xlsx", `{"type":"insert_columns","sheet":"0","at":"C","count":1}`, `{"at":"C","count":1,"sheet":"0","type":"insert_columns"}`},
		{"xlsx", `{"type":"delete_columns","sheet":"0","at":"C","count":1,"expected":[["Score"],[],["91"]]}`,
			`{"at":"C","count":1,"expected":[["Score"],[],["91"]],"sheet":"0","type":"delete_columns"}`},
		{"xlsx", `{"type":"delete_sheet","sheet":"1","expected_name":"Old"}`, `{"expectedName":"Old","sheet":"1","type":"delete_sheet"}`},
		{"docx", `{"type":"replace_text","target_id":"body:paragraph:p1","expected_text":"old","text":"new"}`,
			`{"expectedText":"old","targetId":"body:paragraph:p1","text":"new","type":"replace_text"}`},
		{"pptx", `{"type":"replace_text","target_id":"slide:1:shape:2","expected_text":"old","text":""}`,
			`{"expectedText":"old","targetId":"slide:1:shape:2","text":"","type":"replace_text"}`},
		{"docx", `{"type":"insert_paragraph","after_id":"body:paragraph:p1","text":"Method","style":"Heading1","list":"bullet"}`,
			`{"afterId":"body:paragraph:p1","list":"bullet","style":"Heading1","text":"Method","type":"insert_paragraph"}`},
		{"docx", `{"type":"insert_paragraph","text":""}`, `{"text":"","type":"insert_paragraph"}`},
		{"pptx", `{"type":"insert_paragraph","before_id":"para:s:0","text":""}`,
			`{"beforeId":"para:s:0","text":"","type":"insert_paragraph"}`},
		{"docx", `{"type":"delete_paragraph","target_id":"body:paragraph:p1","expected_text":"Old"}`,
			`{"expectedText":"Old","targetId":"body:paragraph:p1","type":"delete_paragraph"}`},
		{"docx", `{"type":"set_list","ids":["body:paragraph:p1","body:paragraph:p2"],"list":"none"}`,
			`{"ids":["body:paragraph:p1","body:paragraph:p2"],"list":"none","type":"set_list"}`},
		{"docx", `{"type":"insert_table","rows":[["Name","Score"],["Ann","91"]]}`,
			`{"rows":[["Name","Score"],["Ann","91"]],"type":"insert_table"}`},
		{"docx", `{"type":"delete_table","id":"body:t0:r0c0:paragraph:p9","expected":[["Name","a\nb"]]}`,
			`{"expected":[["Name","a\nb"]],"id":"body:t0:r0c0:paragraph:p9","type":"delete_table"}`},
		{"docx", `{"type":"format_text","target_id":"body:paragraph:p1","expected_text":"key","bold":true,"underline":false,` +
			`"color":"#1F4E79","highlight":"yellow","font_size":14,"font_family":"Arial"}`,
			`{"bold":true,"color":"#1F4E79","expectedText":"key","fontFamily":"Arial","fontSize":14,"highlight":"yellow",` +
				`"targetId":"body:paragraph:p1","type":"format_text","underline":false}`},
		{"docx", `{"type":"set_alignment","target_id":"body:paragraph:p1","alignment":"justify"}`,
			`{"alignment":"justify","targetId":"body:paragraph:p1","type":"set_alignment"}`},
		{"pptx", `{"type":"set_shape_text","shape_id":"slide:0:256:shape:1","expected_text":"a\nb","paragraphs":["c",""]}`,
			`{"expectedText":"a\nb","paragraphs":["c",""],"shapeId":"slide:0:256:shape:1","type":"set_shape_text"}`},
		{"pptx", `{"type":"add_slide","after_slide":"slide:0:256","layout":"ppt/slideLayouts/slideLayout2.xml"}`,
			`{"afterSlide":"slide:0:256","layout":"ppt/slideLayouts/slideLayout2.xml","type":"add_slide"}`},
		{"pptx", `{"type":"add_slide"}`, `{"type":"add_slide"}`},
		// A slide_id the model adds to add_slide does not reach the engine (review L3).
		{"pptx", `{"type":"add_slide","slide_id":"slide:0:256"}`, `{"type":"add_slide"}`},
		{"pptx", `{"type":"delete_slide","slide_id":"slide:1:257","expected_text":"Title\nBody"}`,
			`{"expectedText":"Title\nBody","slideId":"slide:1:257","type":"delete_slide"}`},
		{"pptx", `{"type":"move_slide","slide_id":"slide:1:257","before_slide":"slide:0:256"}`,
			`{"beforeSlide":"slide:0:256","slideId":"slide:1:257","type":"move_slide"}`},
		{"pptx", `{"type":"add_text_box","slide_id":"slide:0:256","paragraphs":["Note"],"x":36,"y":400.5,"w":300,"h":40}`,
			`{"h":40,"paragraphs":["Note"],"slideId":"slide:0:256","type":"add_text_box","w":300,"x":36,"y":400.5}`},
		{"pptx", `{"type":"format_text","target_id":"para:s:0","expected_text":"key","italic":true}`,
			`{"expectedText":"key","italic":true,"targetId":"para:s:0","type":"format_text"}`},
	} {
		out, err := NormalizeOfficeCommands(tc.format, []json.RawMessage{json.RawMessage(tc.model)})
		if err != nil {
			t.Fatalf("%s: %v", tc.model, err)
		}
		if string(out[0]) != tc.engine {
			t.Fatalf("%s\n got %s\nwant %s", tc.model, out[0], tc.engine)
		}
	}
}

// A command for another format, or create past the first command, names
// what to do instead.
func TestNormalizeOfficeCommandsRefusesTheWrongFormat(t *testing.T) {
	for _, tc := range []struct {
		format, model string
		code          agenttools.ErrorCode
		message       string
	}{
		{"docx", `{"type":"set_range","sheet":"0","range":"A1","expected":[[""]],"values":[["1"]]}`,
			agenttools.ErrUnsupportedOperation, "set_range applies to XLSX files, not DOCX"},
		{"xlsx", `{"type":"replace_text","target_id":"x","expected_text":"a","text":"b"}`,
			agenttools.ErrUnsupportedOperation, "replace_text applies to DOCX and PPTX files; write cells with set_range"},
		{"xlsx", `{"type":"insert_paragraph","after_id":"x","text":"b"}`,
			agenttools.ErrUnsupportedOperation, "insert_paragraph applies to DOCX and PPTX files; write cells with set_range"},
		{"xlsx", `{"type":"create","format":"xlsx","title":"Book"}`,
			agenttools.ErrInvalidInput, "create must be the call's first command, without file_id"},
		{"xlsx", `{"type":"format_cells","sheet":"0","range":"A1"}`,
			agenttools.ErrInvalidInput, "format_cells needs at least one format to set"},
		{"xlsx", `{"type":"delete_rows","sheet":"0","at":3,"count":1,"expected":"Ann\t91"}`,
			agenttools.ErrInvalidInput, "delete_rows needs expected: the band's current inputs as a grid of rows, [] when it is empty"},
		{"xlsx", `{"type":"delete_columns","sheet":"0","at":"C","count":1}`,
			agenttools.ErrInvalidInput, "delete_columns needs expected: the band's current inputs as a grid of rows, [] when it is empty"},
		{"xlsx", `{"type":"set_list","ids":["x"],"list":"bullet"}`,
			agenttools.ErrUnsupportedOperation, "set_list applies to DOCX files, not XLSX"},
		{"pptx", `{"type":"insert_table","rows":[["x"]]}`,
			agenttools.ErrUnsupportedOperation, "insert_table applies to DOCX files, not PPTX"},
		{"xlsx", `{"type":"format_text","target_id":"x","expected_text":"a","bold":true}`,
			agenttools.ErrUnsupportedOperation, "format_text applies to DOCX and PPTX files; write cells with set_range"},
		{"docx", `{"type":"insert_table","rows":"Name, Score"}`,
			agenttools.ErrInvalidInput, "insert_table needs rows: the cells' text as a grid of rows"},
		{"docx", `{"type":"delete_table","id":"body:t0:r0c0:paragraph:p9"}`,
			agenttools.ErrInvalidInput, "delete_table needs expected: the table's cells' text as a grid of rows"},
		{"docx", `{"type":"set_shape_text","shape_id":"s","expected_text":"","paragraphs":["x"]}`,
			agenttools.ErrUnsupportedOperation, "set_shape_text applies to PPTX files, not DOCX"},
		{"pptx", `{"type":"set_shape_text","shape_id":"s","expected_text":"","paragraphs":"x"}`,
			agenttools.ErrInvalidInput, "set_shape_text needs paragraphs: the shape's new text, one string a paragraph"},
		{"pptx", `{"type":"add_text_box","slide_id":"s","paragraphs":["x"],"x":0,"y":0,"w":10}`,
			agenttools.ErrInvalidInput, "add_text_box needs x, y, w and h in points"},
	} {
		_, err := NormalizeOfficeCommands(tc.format, []json.RawMessage{json.RawMessage(tc.model)})
		var refused *store.EditRefusal
		if !errors.As(err, &refused) || refused.Code != tc.code || refused.Message != tc.message {
			t.Fatalf("%s: %v", tc.model, err)
		}
	}
}
