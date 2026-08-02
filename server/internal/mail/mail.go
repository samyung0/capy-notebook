package mail

import "context"

type Message struct {
	To             string
	Subject        string
	HTML           string
	Text           string
	Headers        map[string]string
	IdempotencyKey string
}

type Sender interface {
	Send(ctx context.Context, message Message) (providerMessageID string, err error)
}
