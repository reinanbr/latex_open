package export

import (
	"regexp"
	"strings"
)

// Document "profile": what the Markdown export should adapt to.
type profile struct {
	// ABNT: abnTeX2 class or abntex2cite (Brazilian theses and papers).
	ABNT bool
	// Lang is the main document language as a BCP 47 tag ("pt-BR"), or "".
	Lang string
}

var (
	reDocClass = regexp.MustCompile(`\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}`)
	reBabel    = regexp.MustCompile(`\\usepackage\s*\[([^\]]*)\]\s*\{babel\}`)
	rePolyMain = regexp.MustCompile(`\\setmainlanguage\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}`)
	reABNTCite = regexp.MustCompile(`\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^{}]*\babntex2cite\b[^{}]*\}`)
)

var babelLang = map[string]string{
	"brazil": "pt-BR", "brazilian": "pt-BR", "portuguese": "pt-BR", "portuges": "pt-BR",
	"english": "en", "american": "en-US", "british": "en-GB", "spanish": "es", "french": "fr",
	"german": "de", "ngerman": "de", "italian": "it",
}

// detectProfile looks at the (comment-free) source.
func detectProfile(code string) profile {
	var p profile
	var opts []string
	if m := reDocClass.FindStringSubmatch(code); m != nil {
		p.ABNT = strings.TrimSpace(m[2]) == "abntex2"
		opts = append(opts, strings.Split(m[1], ",")...)
	}
	if reABNTCite.MatchString(code) {
		p.ABNT = true
	}
	for _, m := range reBabel.FindAllStringSubmatch(code, -1) {
		opts = append(opts, strings.Split(m[1], ",")...)
	}
	// babel: the last language option is the main language.
	for _, o := range opts {
		if l, ok := babelLang[strings.TrimSpace(o)]; ok {
			p.Lang = l
		}
	}
	if m := rePolyMain.FindStringSubmatch(code); m != nil {
		if l, ok := babelLang[strings.TrimSpace(m[1])]; ok {
			p.Lang = l
		}
	}
	return p
}

// abnTeX2 → constructs pandoc understands.
var (
	// abntex2cite: \citeonline = narrative citation ("Silva (2020)").
	reCiteOnline   = regexp.MustCompile(`\\citeonline\b\s*`)
	reCiteAuthOnl  = regexp.MustCompile(`\\citeauthoronline\b\s*`)
	reApud         = regexp.MustCompile(`\\apud\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}\s*\{([^{}]*)\}`)
	reApudOnline   = regexp.MustCompile(`\\apudonline\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}\s*\{([^{}]*)\}`)
	reABNTMeta     = regexp.MustCompile(`\\(titulo|autor|data)\s*\{`)
	reFonte        = regexp.MustCompile(`\\(fonte|nota)\s*\{`)
	reResumoBegin  = regexp.MustCompile(`\\begin\s*\{resumo\}(?:\s*\[([^\]]*)\])?`)
	reEnvName      = regexp.MustCompile(`\\(begin|end)\s*\{(citacao|epigrafe|dedicatoria|agradecimentos|siglas|simbolos|apendicesenv|anexosenv|resumo)\}`)
	abntDropEnvs   = []string{"fichacatalografica", "folhadeaprovacao", "errata"}
	abntDropMacros = regexp.MustCompile(`\\imprimir(?:capa\b|folhaderosto\b\*?)`)
)

// abntPreprocess rewrites abnTeX2-specific markup so that pandoc keeps the
// content: narrative citations, title page data, abstracts, quotations,
// list of abbreviations; it drops pages that only make sense in print
// (catalog card, approval sheet).
func abntPreprocess(tex string) string {
	for _, env := range abntDropEnvs {
		re := regexp.MustCompile(`(?s)\\begin\s*\{` + env + `\}.*?\\end\s*\{` + env + `\}`)
		tex = re.ReplaceAllString(tex, "")
	}
	tex = abntDropMacros.ReplaceAllString(tex, "")

	tex = reApudOnline.ReplaceAllString(tex, `\citet{$1} apud \citet{$2}`)
	tex = reApud.ReplaceAllString(tex, `\cite{$1} apud \cite{$2}`)
	tex = reCiteAuthOnl.ReplaceAllString(tex, `\citeauthor`)
	tex = reCiteOnline.ReplaceAllString(tex, `\citet`)

	tex = reABNTMeta.ReplaceAllStringFunc(tex, func(s string) string {
		switch reABNTMeta.FindStringSubmatch(s)[1] {
		case "titulo":
			return `\title{`
		case "autor":
			return `\author{`
		default:
			return `\date{`
		}
	})
	tex = reFonte.ReplaceAllStringFunc(tex, func(s string) string {
		if strings.Contains(s, "fonte") {
			return `\par Fonte: {`
		}
		return `\par Nota: {`
	})

	tex = reResumoBegin.ReplaceAllStringFunc(tex, func(s string) string {
		title := "Resumo"
		if m := reResumoBegin.FindStringSubmatch(s); m[1] != "" {
			title = strings.TrimSpace(m[1])
		}
		return `\chapter*{` + title + `}`
	})
	tex = reEnvName.ReplaceAllStringFunc(tex, func(s string) string {
		m := reEnvName.FindStringSubmatch(s)
		begin := m[1] == "begin"
		switch m[2] {
		case "citacao", "epigrafe", "dedicatoria":
			if begin {
				return `\begin{quote}`
			}
			return `\end{quote}`
		case "agradecimentos":
			if begin {
				return `\chapter*{Agradecimentos}`
			}
			return ""
		case "siglas", "simbolos":
			if !begin {
				return `\end{description}`
			}
			title := "Lista de abreviaturas e siglas"
			if m[2] == "simbolos" {
				title = "Lista de símbolos"
			}
			return `\chapter*{` + title + `}` + "\n" + `\begin{description}`
		default: // apendicesenv, anexosenv, \end{resumo}: just unwrap
			return ""
		}
	})
	return tex
}

// babel/polyglossia language environments: pandoc reads the language
// argument as text ("english" shows up in the output); keep only the body.
var reLangEnv = regexp.MustCompile(`\\(?:begin\s*\{(?:otherlanguage\*?|foreignlanguage)\}\s*(?:\[[^\]]*\]\s*)?\{[^{}]*\}|end\s*\{(?:otherlanguage\*?|foreignlanguage)\})`)

func unwrapLanguageEnvs(tex string) string {
	return reLangEnv.ReplaceAllString(tex, "")
}
