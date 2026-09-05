package main

import "testing"

func TestConsumeCollaborationEvictionAckRequiresSuccess(t *testing.T) {
	expected := map[string]struct{}{"instance-a": {}}
	done, err := consumeCollaborationEvictionAck(
		`{"evictionId":"eviction-a","instanceId":"instance-a","ok":false}`,
		"eviction-a",
		expected,
	)
	if err == nil {
		t.Fatal("negative acknowledgement was accepted")
	}
	if done {
		t.Fatal("negative acknowledgement completed delivery")
	}
	if _, waiting := expected["instance-a"]; !waiting {
		t.Fatal("negative acknowledgement removed the expected instance")
	}
}

func TestConsumeCollaborationEvictionAckCompletesExpectedInstances(t *testing.T) {
	expected := map[string]struct{}{
		"instance-a": {},
		"instance-b": {},
	}
	done, err := consumeCollaborationEvictionAck(
		`{"evictionId":"eviction-a","instanceId":"instance-a","ok":true}`,
		"eviction-a",
		expected,
	)
	if err != nil || done {
		t.Fatalf("first acknowledgement = done %t, error %v", done, err)
	}
	done, err = consumeCollaborationEvictionAck(
		`{"evictionId":"eviction-a","instanceId":"instance-b","ok":true}`,
		"eviction-a",
		expected,
	)
	if err != nil || !done {
		t.Fatalf("final acknowledgement = done %t, error %v", done, err)
	}
}
