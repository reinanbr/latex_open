# texdesk

Editor LaTeX web, **auto-hospedado e de usuário único**: faça upload de um `.zip`, edite com o PDF ao lado, compile e baixe o resultado em **PDF**, **ZIP** ou **Markdown**. Tudo vem em um único binário Go (API + frontend React embutido).

> ## ⚠️ Não há autenticação
>
> Qualquer pessoa que alcance a porta do texdesk pode **ler, alterar, compilar e apagar todos os projetos**. Por isso, ele escuta por padrão só em `127.0.0.1:8080` (apenas a própria máquina). **Não exponha o texdesk na rede ou na internet** sem colocá-lo atrás de algo que autentique, como um proxy reverso com login, uma VPN ou um túnel SSH. Veja [Segurança](#segurança).

## Recursos

- **Projetos:** importação de `.zip` (com detecção do arquivo principal e do compilador), projeto em branco, renomear, baixar e excluir.
- **Árvore de arquivos:**
  - criar, renomear (F2), mover arrastando e excluir;
  - upload de arquivos e pastas;
  - marcar o arquivo principal;
  - marcadores de erro nos arquivos.
- **Editor (CodeMirror 6):**
  - realce de sintaxe para LaTeX e BibTeX;
  - dobra de ambientes e seções;
  - pareamento de `\begin`/`\end`;
  - busca e substituição;
  - modo Vim opcional;
  - salvamento automático.
- **Autocomplete:** `\ref`/`\eqref`/`\cref` (labels do projeto), `\cite` e variantes (chaves do `.bib`, com autor e título), `\includegraphics`, `\input`/`\include`, `\begin{…}` (insere o ambiente inteiro, com os argumentos), `\end{…}`, `\usepackage{…}`, `\documentclass{…}`, macros definidas no projeto e os comandos e ambientes da **base de conhecimento LaTeX** (veja abaixo): os da classe e dos pacotes carregados, mostrando de onde vem cada um, e os dos pacotes comuns ainda não carregados (marcados `+ pacote`; escolher um deles também adiciona o `\usepackage`).
- **Compilação:**
  - `latexmk` com pdfLaTeX, LaTeX (DVI → PDF, figuras em EPS), XeLaTeX ou LuaLaTeX;
  - BibTeX ou biber;
  - **compilação ao vivo** (ligada por padrão): cerca de 2 s depois que você para de digitar, o projeto é salvo e recompilado, e erros, avisos, logs, badge e PDF se atualizam sozinhos. Ela não abre caixas nem os logs por conta própria e espera enquanto o arquivo aberto tem erro de sintaxe ("Automática em pausa");
  - menu ao lado de **Recompilar**: compilação automática, velocidade (pular imagens — modo rascunho), verificação de sintaxe, "parar no primeiro erro" ou "tentar compilar mesmo com erros", **Recompilar do zero** (apaga os arquivos auxiliares) e **Configurações…**;
  - configurações de compilação: arquivo principal, compilador, versão do TeX Live instalada e as opções acima;
  - cancelamento e tempo limite.
- **Problemas:**
  - o log é interpretado em erros, avisos e caixas mal formatadas, com link para a linha e uma explicação dos erros mais comuns;
  - no editor, a linha do erro é sublinhada e marcada na margem; passando o mouse aparece uma caixa com o erro, a explicação e o botão **Ver no log** (F8 vai ao próximo problema; `Ctrl+Shift+M` lista todos);
  - quando a compilação tem erros, uma caixa sobre o PDF mostra o primeiro, com **Ir para o erro** e **Ver logs**;
  - **avisos ao vivo**, sem compilar: `\ref` para rótulo inexistente, `\cite` com chave fora do `.bib`, figura ou `\include` que não está no projeto e `\label` repetido no arquivo;
  - no painel de logs, o bloco **Ao vivo** lista o que a verificação encontra no arquivo aberto, atualizado a cada pausa; o badge e a árvore também contam esses problemas;
  - se você continua digitando durante uma compilação, os erros caem na linha certa; marcações de linhas editadas depois da compilação ficam esmaecidas até a próxima;
  - **verificação de sintaxe** enquanto você digita, sem compilar: chaves, `\begin`/`\end` e fórmulas (`$`, `$$`, `\(`, `\[`) sem fechamento. Comentários, ambientes verbatim, `\verb`, `\url` e definições de macros são ignorados para não gerar alarmes falsos;
  - **comandos e ambientes desconhecidos** enquanto você digita (o "Undefined control sequence" antes de compilar): se o nome é de um pacote que não está carregado, a caixa explica e oferece **Adicionar `\usepackage{…}`** (no preâmbulo do arquivo principal); se parece erro de digitação, oferece **Trocar por `\…`** (`\textbff` → `\textbf`, `{itemise}` → `{itemize}`). A verificação fica em pausa — e o painel de logs diz por quê — quando o projeto carrega algo que a base não conhece (um pacote não instalado, uma classe própria) ou monta nomes de comandos com `\csname`, para não acusar o que não pode confirmar;
  - o log bruto continua disponível.
- **PDF (pdf.js):** camada de texto, zoom e ajuste à largura ou à página. A posição de rolagem é mantida entre compilações.
- **SyncTeX nos dois sentidos:** do código para o PDF (botão ⇄ ou `Ctrl+Shift+.`) e do PDF para o código (duplo clique).
- **Interface:**
  - estrutura (outline) do arquivo;
  - layouts editor + PDF, só editor ou só PDF;
  - tema claro/escuro;
  - preferências salvas no navegador;
  - contagem de palavras (texcount, ou uma estimativa).

### Atalhos

| Atalho | Ação |
|---|---|
| `Ctrl/Cmd+S` | Salvar e recompilar |
| `Ctrl/Cmd+Enter` | Recompilar |
| `Ctrl/Cmd+B` / `Ctrl/Cmd+I` | Envolver a seleção em `\textbf{}` / `\textit{}` |
| `Ctrl/Cmd+/` | Comentar/descomentar com `%` |
| `Ctrl/Cmd+F` / `Ctrl/Cmd+H` | Buscar / substituir |
| `Ctrl/Cmd+Shift+.` | SyncTeX: mostrar no PDF a posição do cursor |
| Duplo clique no PDF | SyncTeX: ir para a linha correspondente no código |
| `F2` / `Delete` na árvore | Renomear / excluir |

## Requisitos

| Ferramenta | Para quê | Obrigatória? |
|---|---|---|
| `latexmk` + `pdflatex`/`xelatex`/`lualatex` | compilar | sim, para compilar |
| `latex` + `dvips` + `ps2pdf` (Ghostscript) | compilador "LaTeX (DVI → PDF)" | não |
| `bibtex` / `biber` | bibliografias | se o projeto usar |
| `synctex` (vem com o TeX Live) | sincronizar código ↔ PDF | não |
| `pandoc` | exportar Markdown | não |
| `pdftoppm` (poppler-utils) / `gs` (Ghostscript) | converter figuras PDF/EPS em PNG na exportação Markdown | não |
| `texcount` | contagem de palavras exata (sem ele: estimativa) | não |

Para compilar o texdesk você precisa de **Go 1.22+** e **Node.js 20.19+ ou 22.12+** (com npm).

Ferramentas opcionais que faltarem são detectadas quando o texdesk inicia: a interface desabilita o recurso e mostra o motivo.

No Debian/Ubuntu:

```sh
sudo apt install golang-go nodejs npm make \
  latexmk texlive-latex-extra texlive-xetex texlive-luatex texlive-bibtex-extra biber \
  texlive-lang-portuguese texlive-fonts-recommended cm-super-minimal \
  texlive-publishers preview-latex-style \
  pandoc poppler-utils ghostscript texlive-extra-utils
```

`texlive-publishers` traz o **abnTeX2** (classe `abntex2`, `abntex2cite` e os estilos `abntex2-*.bst`), usado em TCCs, dissertações e teses no padrão ABNT. `preview-latex-style` é usado para converter figuras TikZ na exportação Markdown. Se uma classe ou pacote faltar, o painel de problemas mostra qual pacote instalar.

### Trabalhos ABNT (abnTeX2)

- Compilam normalmente com `pdflatex` (ou `xelatex`/`lualatex`). O `latexmk` roda `bibtex` e `makeindex` quando necessário.
- O autocompletar conhece `\citeonline`, `\apud`, `\fonte`, `\imprimircapa`, `\pretextual`/`\textual`/`\postextual` e os ambientes `resumo`, `citacao`, `siglas`, `apendicesenv` etc.
- Uma tese grande pode passar de 30 s na primeira compilação, porque o `latexmk` precisa de várias passadas. As seguintes são incrementais. Se estourar o tempo, aumente `--compile-timeout` (por exemplo, `--compile-timeout 3m`).

## Rodando localmente

```sh
make build            # gera web/dist e depois bin/texdesk (com o frontend embutido)
./bin/texdesk         # http://127.0.0.1:8080
```

### Configuração

Todo flag também pode ser definido por uma variável de ambiente. Se os dois forem informados, o flag vale.

| Flag | Variável | Padrão | Descrição |
|---|---|---|---|
| `--addr` | `TEXDESK_ADDR` | `127.0.0.1:8080` | endereço onde escutar |
| `--data-dir` | `TEXDESK_DATA_DIR` | `./data` | onde ficam os projetos |
| `--compile-timeout` | `TEXDESK_COMPILE_TIMEOUT` | `60s` | duração máxima de uma compilação (também vale para o pandoc) |
| `--max-upload-mb` | `TEXDESK_MAX_UPLOAD_MB` | `100` | tamanho máximo de upload |
| `--allowed-hosts` | `TEXDESK_ALLOWED_HOSTS` | nomes de loopback | valores aceitos no cabeçalho `Host`, separados por vírgula (`*` aceita qualquer um) |
| `--no-sandbox` | `TEXDESK_SANDBOX=off` | sandbox ligado | desliga o sandbox Landlock (não recomendado) |
| `--log-json` | `TEXDESK_LOG_JSON=1` | texto | logs em JSON |

### Dados

```
data/projects/{id}/
├── meta.json   # nome, arquivo principal, compilador, criação, último acesso
├── src/        # seus arquivos, exatamente como vieram do zip
└── build/      # saída do latexmk (-outdir); nunca se mistura com src/
```

O backup é simplesmente copiar `data/`. O ZIP exportado contém só o `src/`.

### Desenvolvimento

```sh
make dev               # Vite em :5173 (proxy da API) + Go (hot reload com `air`, se instalado)
make test              # go vet + testes Go (unitários e de integração) + typecheck + Vitest
make test-integration  # só os testes que rodam o TeX de verdade
```

Os testes de integração são pulados se o TeX Live não estiver instalado. Para rodar só os testes rápidos, use `go test -short ./...`.

## Docker

```sh
make docker           # = docker build -t texdesk:latest .
docker run --rm -p 127.0.0.1:8080:8080 -v texdesk-data:/data texdesk:latest
```

- **Publique a porta só em `127.0.0.1`**, como no exemplo. `-p 8080:8080` expõe o texdesk, que não tem senha, para a rede.
- A imagem traz `texlive-latex-extra`, `texlive-xetex`, `texlive-luatex`, `texlive-bibtex-extra`, `biber`, `latexmk`, `pandoc`, `texlive-lang-portuguese`, `texlive-publishers` (abnTeX2), as fontes recomendadas, `cm-super-minimal`, `preview-latex-style`, poppler, Ghostscript e texcount. O processo roda como um usuário sem privilégios (uid 10001), e os projetos ficam no volume `/data`.
- **TeX Live completo** (cerca de 5 GB, com todos os pacotes e idiomas):
  ```sh
  docker build --build-arg TEX_PACKAGES=texlive-full -t texdesk:full .
  ```
  Também dá para trocar a lista: `--build-arg TEX_PACKAGES="texlive-latex-extra texlive-science …"`.
- Dentro do contêiner, o texdesk escuta em `0.0.0.0:8080`, e por isso a imagem já define `TEXDESK_ALLOWED_HOSTS=localhost,127.0.0.1,::1`. Se você acessar por outro nome (por exemplo, atrás de um proxy com autenticação), acrescente-o: `-e TEXDESK_ALLOWED_HOSTS=localhost,127.0.0.1,latex.minha-rede.lan`.
- Para limitar recursos, use as opções do Docker, como `--memory=2g --cpus=2 --pids-limit=256`.
- O sandbox Landlock (veja abaixo) depende do kernel do host e de o perfil seccomp do Docker permitir as chamadas `landlock_*`. Se não der, o texdesk avisa no log e segue só com o isolamento do próprio contêiner.

## Exportação para Markdown

**Download → Markdown…** converte o projeto com o `pandoc` (`-f latex -t gfm`), partindo do arquivo principal.

- O cabeçalho YAML recebe título, autor, data e resumo.
- As citações são formatadas pelo citeproc a partir dos `.bib` do projeto.
- Figuras em PDF/EPS viram PNG, com `pdftoppm` ou `gs`.
- Figuras TikZ são compiladas à parte, com o preâmbulo do próprio documento e o pacote `preview`, e viram PNG (em `media/tikz/`). Se a compilação falhar, cada figura vira um aviso no texto.
- Documentos abnTeX2 são adaptados: `\citeonline` vira citação narrativa ("Silva (2020)"), `\apud` é mantido, capa, folha de rosto, ficha catalográfica e folha de aprovação são omitidas, `resumo`/`citacao`/`siglas` viram seções, citações e listas, e as referências são formatadas no estilo ABNT. O idioma do documento (opções do babel/polyglossia) vai para o cabeçalho (`lang: pt-BR`).
- Se houver imagens, o download é um `.zip` com o `.md` e a pasta `media/`. Se não houver, é só o `.md`.
- A conversão é **aproximada**: macros próprias, ambientes personalizados e o layout da página podem se perder. A interface avisa isso e lista os problemas encontrados, como imagem não encontrada ou `\input` fora do projeto.

**Diferença em relação a usar o pandoc direto:** o pandoc resolve `\input` e lê imagens de qualquer lugar do disco. Assim, um projeto malicioso poderia embutir no Markdown arquivos como `/etc/passwd`, mesmo escondidos atrás de macros. Por isso o texdesk:

1. expande `\input`/`\include`/`\subfile` ele mesmo, aceitando só caminhos dentro do projeto;
2. roda o pandoc com `--sandbox`, que o impede de acessar arquivos;
3. copia e converte as imagens ele mesmo, em vez de usar `--extract-media` (que dependeria do acesso do pandoc ao disco), também só de dentro do projeto.

## Segurança

O texdesk compila documentos que podem vir de terceiros. Compilar LaTeX é executar um programa, então as defesas abaixo existem mesmo em uso pessoal.

**Acesso**
- Não há autenticação. O texdesk escuta em loopback por padrão, e o log avisa quando ele escuta em outro endereço.
- **DNS rebinding:** o cabeçalho `Host` é validado. Em loopback, só `localhost`, `127.0.0.1` e `::1` são aceitos. Em outro endereço, use `--allowed-hosts`.
- **CSRF:** toda requisição que altera dados precisa do cabeçalho `X-Texdesk`, e o `Origin`, quando enviado, tem de bater com o `Host`. Um site de terceiros não consegue enviar esse cabeçalho sem um preflight CORS, que o texdesk nunca aprova.
- **Clickjacking e XSS:** `X-Frame-Options: DENY` e uma CSP restrita (`script-src 'self'`, `frame-ancestors 'none'`). Arquivos do projeto são servidos com `Content-Security-Policy: sandbox` e `nosniff`, de modo que um `.svg` ou `.html` no projeto não executa scripts. Há também `Cross-Origin-Resource-Policy: same-origin`.

**Arquivos**
- Todo caminho recebido pela API é normalizado e precisa ficar dentro de `src/`. São rejeitados caminhos absolutos, `..`, NUL e links simbólicos que apontem para fora.
- **Importação de zip:**
  - proteção contra zip-slip;
  - symlinks são recusados;
  - limites contra zip bomb, contando os bytes realmente descompactados (até 5.000 arquivos, 1 GB no total e 256 MB por arquivo);
  - tamanho máximo de upload configurável.

**Compilação**
- **Sem shell-escape em hipótese alguma:** `latexmk -no-shell-escape`, `shell_escape=f` no ambiente, e `\write18` é ignorado.
- `latexmk -norc`: nenhum `latexmkrc`, nem do projeto nem do sistema, é executado (um `latexmkrc` é código Perl).
- No compilador LaTeX (DVI), o `dvips` roda com `-R2`: não executa comandos (`` \special{psfile="`…"} ``) nem a opção `E` de arquivos de configuração; o `ps2pdf` roda com `-dSAFER`.
- `openout_any=p`: o TeX só grava no diretório de build. `openin_any=p` para pdfLaTeX e XeLaTeX: o TeX não lê caminhos absolutos nem `..`.
- **Sandbox Landlock (Linux ≥ 5.13).** O LuaLaTeX precisa de `openin_any=r`, porque o luaotfload lê arquivos do próprio TeX por caminho absoluto. Sem outra proteção, um projeto poderia incluir no PDF qualquer arquivo legível pelo usuário do texdesk, como `~/.ssh/id_rsa`. Por isso, latexmk e tudo o que ele executa (engines, bibtex, biber), além de pandoc, Ghostscript, pdftoppm e texcount, rodam confinados pelo Landlock:
  - **leitura** só do sistema (`/usr`, `/etc`…), da instalação do TeX e dos arquivos do próprio projeto;
  - **escrita** só no `build/` do projeto e no cache de fontes do TeX;
  - a pasta pessoal, os outros projetos e o resto do disco ficam invisíveis.

  O texdesk testa o sandbox ao iniciar e informa no log ("sandbox Landlock ativo"). Sem Landlock (kernel antigo, outro sistema operacional ou seccomp que bloqueie as chamadas), as restrições do TeX continuam valendo, mas a do LuaLaTeX não. Nesse caso, prefira rodar no Docker.
- Cada compilação roda em seu próprio grupo de processos. No tempo limite ou no cancelamento, o grupo inteiro é encerrado (`SIGKILL`). Há no máximo uma compilação por projeto (uma nova cancela a anterior) e um limite global de compilações simultâneas.
- O Ghostscript roda com `-dSAFER`.

**Limitações conhecidas**
- Não há limite de memória por compilação. Use os limites do Docker ou do systemd.
- O `synctex` roda fora do sandbox. Ele só lê o arquivo `.synctex.gz` gerado pela própria compilação.
- Leitores de PDF e imagens (poppler, Ghostscript) processam arquivos do projeto. O sandbox limita o estrago de uma eventual falha nessas ferramentas, mas mantenha o sistema atualizado.

## Base de conhecimento LaTeX

A verificação de comandos e o autocomplete rodam inteiramente no navegador, com uma base dos comandos e ambientes que o kernel do LaTeX, 34 classes e ~450 pacotes (contando as dependências) definem, e de quais pacotes cada um carrega (`\includegraphics` → `graphicx`, `abntex2` → `memoir` + `hyperref`…). Ela não é digitada à mão: `web/scripts/latexkb/gen.mjs` carrega cada classe e pacote numa execução do LuaLaTeX e lê a tabela de comandos do próprio TeX (incluindo os que só existem dentro de ambientes, como `\draw` em `tikzpicture`), e acrescenta as primitivas do pdfTeX e do XeTeX. O resultado (`web/src/data/latex-kb.json`, ~480 KB; ~130 KB com gzip, que o servidor aplica) é baixado uma vez quando o editor abre. Testada sobre os ~280 documentos de exemplo do TeX Live que só usam pacotes conhecidos, 95% saem sem nenhum aviso; os restantes criam comandos dinamicamente (laços, `\csname`).

Para regenerar (por exemplo, depois de instalar mais pacotes do TeX Live):

```sh
make latexkb            # ou: cd web && node scripts/latexkb/gen.mjs  (~15 min; as execuções do TeX ficam em cache)
```

A lista de classes e pacotes fica em `web/scripts/latexkb/list.json`; os que não estiverem instalados na máquina que gera a base ficam de fora (e o editor apenas não verifica comandos em projetos que os usam).

## Arquitetura

```
cmd/texdesk/          main: flags/env, detecção de ferramentas, sandbox, servidor HTTP
internal/api/         rotas REST, erros JSON {"error":{"code","message"}}, Host/CSRF/CSP
internal/project/     armazenamento (meta.json, src/, build/), caminhos seguros
internal/archive/     importação/exportação de zip, detecção do arquivo principal e do compilador
internal/compiler/    latexmk, fila por projeto, cancelamento, parser de log
internal/synctex/     busca forward/inverse com o CLI synctex
internal/texindex/    índice do projeto (labels, .bib, macros, ambientes, pacotes e classe em uso) e texcount
internal/export/      Markdown via pandoc (PDF e ZIP ficam em api/ e archive/)
internal/sandbox/     confinamento Landlock dos processos externos
internal/tools/       detecção das ferramentas em tempo de execução
web/                  React + TypeScript + Vite (CodeMirror 6, pdf.js, zustand, TanStack Query)
web/scripts/latexkb/  gerador da base de conhecimento LaTeX (LuaLaTeX lê a tabela de comandos)
testdata/sample-project/  projeto de exemplo (\input, \include, figura, .bib)
```

O texdesk é uma implementação original. Ele reproduz a ergonomia de editores LaTeX online (layout, atalhos, fluxo), mas não contém nem deriva código de nenhum deles.

## Roadmap

- **Autenticação e multiusuário:** login, projetos por usuário, papéis.
- **Histórico de versões:** o gancho já existe (`compiler.Manager.OnSuccess`, chamado após cada compilação bem-sucedida). O próximo passo é guardar um snapshot de `src/` e criar uma tela para comparar e restaurar.
- **Colaboração em tempo real** (CRDT, por exemplo Yjs), comentários e controle de alterações.
- Limites de memória e CPU por compilação (cgroups v2) e SyncTeX dentro do sandbox.
- Outline do projeto inteiro (seguindo `\input`), verificação ortográfica e snippets configuráveis.
- Integração com Git (clone, commit, push) e importação por URL.

## Licença

Distribuído sob a [licença MIT](LICENSE).

Exceção: o estilo de citação ABNT embutido (`internal/export/csl/associacao-brasileira-de-normas-tecnicas.csl`) vem do [Citation Style Language](https://github.com/citation-style-language/styles) e é distribuído sob a licença [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), com os créditos aos autores no próprio arquivo.
