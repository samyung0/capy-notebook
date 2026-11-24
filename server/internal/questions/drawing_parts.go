package questions

import "slices"

// DrawingParts maps each canvas part of q to the part whose answer holds the
// drawing it is answered with (Epo 2026-11-23): itself on its own canvas, or,
// answered in the canvas above (shared), the first part in question order
// that answers in that same canvas. The parts sharing a canvas share one
// drawing, stored once under that part, and each is graded on its image. A
// canvas part whose canvas is missing (Validate refuses it) is absent. It
// reads authored questions and learner views alike; TS drawingParts
// (src/features/quizzes/drawing/canvasParts.ts) is the same.
func DrawingParts(q map[string]any) map[string]string {
	parts, _ := q["parts"].([]any)
	out := make(map[string]string, len(parts))
	first := map[string]string{}
	for i, raw := range parts {
		canvas, ok := PartAnswerCanvas(q, i)
		if !ok {
			continue
		}
		p, _ := raw.(map[string]any)
		id, _ := p["id"].(string)
		key := canvasKey(canvas)
		if _, seen := first[key]; !seen {
			first[key] = id
		}
		out[id] = first[key]
	}
	return out
}

// canvasKey names a canvas by where it sits, "stem/", "group/<id>" or
// "part/<id>": one canvas a list, so where it sits names it, across edits of
// its question too (Epo 2026-11-24).
func canvasKey(c AnswerCanvas) string {
	return c.Section + "/" + c.ID
}

// DrawingCanvases maps each drawing part of q (DrawingParts' values) to the
// canvas its drawing is drawn in (canvasKey). A republish moves a drawing to
// the drawing part of its canvas in the new copy, or drops it when no part
// answers in that canvas any more (store.drawingTargets).
func DrawingCanvases(q map[string]any) map[string]string {
	parts, _ := q["parts"].([]any)
	out := map[string]string{}
	seen := map[string]bool{}
	for i, raw := range parts {
		canvas, ok := PartAnswerCanvas(q, i)
		if !ok || seen[canvasKey(canvas)] {
			continue
		}
		seen[canvasKey(canvas)] = true
		p, _ := raw.(map[string]any)
		id, _ := p["id"].(string)
		out[id] = canvasKey(canvas)
	}
	return out
}

// UngroupedCanvases maps the group canvases an edit handed to a part (Ungroup,
// or removing a group's sub-parts down to one), by canvasKey, the group's to
// the part's: a group gone from after whose first sub-part, holding no canvas
// of its own before, now answers on one of its own. The drawing in it follows
// it (Epo 2026-11-24). TS ungroupedCanvases is the same.
func UngroupedCanvases(before, after map[string]any) map[string]string {
	out := map[string]string{}
	kept := map[string]bool{}
	groups, _ := after["groups"].([]any)
	for _, raw := range groups {
		g, _ := raw.(map[string]any)
		id, _ := g["id"].(string)
		kept[id] = true
	}
	was, _ := before["groups"].([]any)
	beforeParts, _ := before["parts"].([]any)
	afterParts, _ := after["parts"].([]any)
	for _, raw := range was {
		g, _ := raw.(map[string]any)
		group, _ := g["id"].(string)
		if kept[group] {
			continue
		}
		i := slices.IndexFunc(beforeParts, func(raw any) bool {
			p, _ := raw.(map[string]any)
			return p["group"] == group
		})
		if i < 0 {
			continue
		}
		first, _ := beforeParts[i].(map[string]any)
		if _, held := firstCanvas(first["blocks"], "part", ""); held {
			continue
		}
		j := slices.IndexFunc(afterParts, func(raw any) bool {
			p, _ := raw.(map[string]any)
			return p["id"] == first["id"]
		})
		if canvas, ok := PartAnswerCanvas(after, j); ok && canvas.Section == "part" {
			out[canvasKey(AnswerCanvas{Section: "group", ID: group})] = canvasKey(canvas)
		}
	}
	return out
}
