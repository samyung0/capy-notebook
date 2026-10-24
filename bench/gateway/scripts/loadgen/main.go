// Command loadgen is the gateway load test's generator (bench/README.md,
// gateway). `serve` stands in for Clerk and Sentry for the whole stack's life;
// `setup` signs users in once each, which provisions them as production does,
// and gives each some content; `run` replays sessions of signed-in browsers
// and writes a summary.
package main

import (
	"context"
	"crypto/rsa"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"time"
)

const keyPath = "/results/clerk-key.pem"

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: loadgen serve | setup | run [flags]")
	}
	key, err := loadKey(keyPath)
	if err != nil {
		log.Fatal(err)
	}
	switch os.Args[1] {
	case "serve":
		log.Fatal(serveFakes(":9000", key))
	case "setup":
		setup(key, os.Args[2:])
	case "run":
		run(key, os.Args[2:])
	case "get":
		get(key, os.Args[2:])
	default:
		log.Fatalf("unknown command %q", os.Args[1])
	}
}

type config struct {
	target, origin string
	from, users    int
	skip           map[string]bool
}

func (c *config) flags(fs *flag.FlagSet) {
	fs.IntVar(&c.from, "from", 0, "first user index")
	fs.IntVar(&c.users, "users", 100, "users")
	c.skip = map[string]bool{}
	fs.Func("skip", `a route the tabs never send, as "GET /api/materials" (repeatable)`, func(route string) error {
		c.skip[route] = true
		return nil
	})
	c.target = os.Getenv("TARGET")
	c.origin = os.Getenv("ORIGIN")
}

func userID(i int) string { return fmt.Sprintf("user_lt%06d", i) }

// newClient talks to the gateway the way cloudflared does: requests share a
// pool of keep-alive connections, and each event stream holds one of its own.
func newClient() (api, streams *http.Client) {
	api = &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns: 1024, MaxIdleConnsPerHost: 1024, IdleConnTimeout: 90 * time.Second,
		},
	}
	streams = &http.Client{Transport: &http.Transport{IdleConnTimeout: 90 * time.Second}}
	return api, streams
}

func signIn(key *rsa.PrivateKey, cfg config, i int, api, streams *http.Client, rec *recorder) *user {
	token, err := sessionToken(key, userID(i), cfg.origin)
	if err != nil {
		log.Fatal(err)
	}
	return &user{id: userID(i), token: token, target: cfg.target, api: api, streams: streams, rec: rec, skip: cfg.skip,
		rng: rand.New(rand.NewPCG(uint64(i), 0x9e3779b97f4a7c15))}
}

// get prints one GET's answer as a user sees it, for checking the scenario's
// assumptions against the gateway.
func get(key *rsa.PrivateKey, args []string) {
	fs := flag.NewFlagSet("get", flag.ExitOnError)
	var cfg config
	cfg.flags(fs)
	_ = fs.Parse(args)
	token, err := sessionToken(key, userID(cfg.from), cfg.origin)
	if err != nil {
		log.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodGet, cfg.target+fs.Arg(0), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Fatal(err)
	}
	defer res.Body.Close()
	fmt.Println(res.Status)
	_, _ = io.Copy(os.Stdout, res.Body)
}

func setup(key *rsa.PrivateKey, args []string) {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	var cfg config
	cfg.flags(fs)
	parallel := fs.Int("parallel", 32, "users set up at once")
	_ = fs.Parse(args)
	api, streams := newClient()
	rec := newRecorder()
	rec.measuring.Store(true)
	started := time.Now()
	work := make(chan int)
	var wg sync.WaitGroup
	for range *parallel {
		wg.Go(func() {
			for i := range work {
				if err := signIn(key, cfg, i, api, streams, rec).provision(context.Background()); err != nil {
					log.Printf("%s: %v", userID(i), err)
				}
			}
		})
	}
	for i := cfg.from; i < cfg.from+cfg.users; i++ {
		work <- i
		if done := i - cfg.from + 1; done%500 == 0 {
			log.Printf("set up %d users in %s", done, time.Since(started).Round(time.Second))
		}
	}
	close(work)
	wg.Wait()
	s := rec.finish(cfg.users, time.Since(started))
	_ = writeSummary(fmt.Sprintf("/results/setup-%d-%d.json", cfg.from, cfg.users), s, os.Stdout)
}

func run(key *rsa.PrivateKey, args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	var cfg config
	cfg.flags(fs)
	ramp := fs.Duration("ramp", 2*time.Minute, "time over which users start")
	duration := fs.Duration("duration", 5*time.Minute, "measured time after the ramp")
	name := fs.String("name", "", "result name (default users-N)")
	idle := fs.Bool("idle", false, "tabs that open a workspace and then only hold its stream")
	_ = fs.Parse(args)
	if *name == "" {
		*name = fmt.Sprintf("users-%d", cfg.users)
	}
	api, streams := newClient()
	rec := newRecorder()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	ctx, cancel := context.WithTimeout(ctx, *ramp+*duration)
	defer cancel()
	defer stop()

	var wg sync.WaitGroup
	gap := *ramp / time.Duration(max(cfg.users, 1))
	go func() {
		select {
		case <-time.After(*ramp):
			rec.measuring.Store(true)
			log.Printf("ramp done: %d users, measuring for %s", cfg.users, *duration)
		case <-ctx.Done():
		}
	}()
	for i := cfg.from; i < cfg.from+cfg.users; i++ {
		u := signIn(key, cfg, i, api, streams, rec)
		if *idle {
			wg.Go(func() { u.idle(ctx) })
		} else {
			wg.Go(func() { u.session(ctx) })
		}
		select {
		case <-time.After(gap):
		case <-ctx.Done():
		}
	}
	<-ctx.Done()
	measured := *duration
	s := rec.finish(cfg.users, measured)
	wg.Wait()
	if err := writeSummary(filepath.Join("/results", *name+".json"), s, os.Stdout); err != nil {
		log.Fatal(err)
	}
}
