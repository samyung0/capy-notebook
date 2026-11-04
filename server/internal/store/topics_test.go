package store

import (
	"context"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

// A topic keeps its one-line description through an edit and a workspace
// clone (Epo 2026-11-03).
func TestTopicDescriptionSurvivesEditAndClone(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	ownerID := newCreditsTestUser(t, s)
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Biology", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	topic, err := s.AddTopic(ctx, ws.ID, ownerID, "Osmosis", "Water across membranes")
	if err != nil {
		t.Fatal(err)
	}
	if topic.Description != "Water across membranes" {
		t.Fatalf("added description = %q", topic.Description)
	}
	description := "Water potential and osmosis"
	if topic, err = s.UpdateTopic(ctx, ownerID, topic.ID, TopicPatch{Description: &description}); err != nil {
		t.Fatal(err)
	}
	if topic.Name != "Osmosis" || topic.Description != description {
		t.Fatalf("updated topic = %+v", topic)
	}

	clone, err := s.CloneWorkspace(ctx, ownerID, ws.ID, WorkspaceCreate{Name: "Biology copy", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	topics, err := s.ListTopics(ctx, clone.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(topics) != 1 || topics[0].Name != "Osmosis" || topics[0].Description != description {
		t.Fatalf("cloned topics = %+v", topics)
	}
}
