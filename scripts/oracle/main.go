// Command oracle answers differential-test queries with the real Go standard
// library (go/build and go/build/constraint). It reads one JSON object per line
// on stdin and writes one JSON object per line on stdout.
package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"go/build"
	"go/build/constraint"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

type Ctx struct {
	Goos        string   `json:"goos"`
	Goarch      string   `json:"goarch"`
	Tags        []string `json:"tags"`
	ToolTags    []string `json:"toolTags"`
	Cgo         bool     `json:"cgo"`
	GoVersion   int      `json:"goVersion"`
	Compiler    string   `json:"compiler"`
	UseAllFiles bool     `json:"useAllFiles"`
}

type Query struct {
	Op      string     `json:"op"`
	ID      int        `json:"id"`
	Name    string     `json:"name"`
	Content string     `json:"contentB64"`
	Ctx     Ctx        `json:"ctx"`
	Line    string     `json:"line"`
	TagSets [][]string `json:"tagSets"`
	Root    string     `json:"root"`
	Ctxs    []Ctx      `json:"ctxs"`
}

func (c Ctx) build() build.Context {
	bc := build.Context{
		GOOS:        c.Goos,
		GOARCH:      c.Goarch,
		BuildTags:   c.Tags,
		ToolTags:    c.ToolTags,
		CgoEnabled:  c.Cgo,
		Compiler:    c.Compiler,
		UseAllFiles: c.UseAllFiles,
	}
	if bc.Compiler == "" {
		bc.Compiler = "gc"
	}
	for i := 1; i <= c.GoVersion; i++ {
		bc.ReleaseTags = append(bc.ReleaseTags, fmt.Sprintf("go1.%d", i))
	}
	return bc
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func main() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<28)
	w := bufio.NewWriterSize(os.Stdout, 1<<20)
	defer w.Flush()
	enc := json.NewEncoder(w)
	for sc.Scan() {
		var q Query
		if err := json.Unmarshal(sc.Bytes(), &q); err != nil {
			fmt.Fprintln(os.Stderr, "bad query:", err)
			os.Exit(2)
		}
		switch q.Op {
		case "match":
			data, err := base64.StdEncoding.DecodeString(q.Content)
			if err != nil {
				fmt.Fprintln(os.Stderr, "bad base64:", err)
				os.Exit(2)
			}
			ctx := q.Ctx.build()
			ctx.OpenFile = func(string) (io.ReadCloser, error) {
				return io.NopCloser(bytes.NewReader(data)), nil
			}
			ok, err := ctx.MatchFile("/d", q.Name)
			enc.Encode(map[string]any{"id": q.ID, "match": ok, "err": errString(err)})
		case "parse":
			out := map[string]any{"id": q.ID}
			x, err := constraint.Parse(q.Line)
			if err != nil {
				out["err"] = err.Error()
			} else {
				out["str"] = x.String()
				lines, perr := constraint.PlusBuildLines(x)
				out["plus"] = lines
				out["plusErr"] = errString(perr)
				evals := []bool{}
				for _, set := range q.TagSets {
					m := map[string]bool{}
					for _, t := range set {
						m[t] = true
					}
					evals = append(evals, x.Eval(func(t string) bool { return m[t] }))
				}
				out["evals"] = evals
			}
			enc.Encode(out)
		case "tree":
			type rec struct {
				Ctx   int    `json:"ctx"`
				Path  string `json:"path"`
				Match bool   `json:"match"`
				Err   string `json:"err"`
			}
			var files []string
			filepath.WalkDir(q.Root, func(p string, d fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if d.Type().IsRegular() {
					rel, _ := filepath.Rel(q.Root, p)
					files = append(files, filepath.ToSlash(rel))
				}
				return nil
			})
			sort.Strings(files)
			for i, c := range q.Ctxs {
				ctx := c.build()
				for _, rel := range files {
					dir := filepath.Join(q.Root, filepath.Dir(filepath.FromSlash(rel)))
					ok, err := ctx.MatchFile(dir, filepath.Base(rel))
					enc.Encode(rec{i, rel, ok, errString(err)})
				}
			}
		default:
			fmt.Fprintln(os.Stderr, "unknown op", q.Op)
			os.Exit(2)
		}
	}
}
