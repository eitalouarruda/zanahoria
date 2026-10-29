<p align="center">
  <img src="icon-src.png" alt="Logo do Zanahoria" width="96" />
</p>

<h1 align="center">Zanahoria</h1>

<p align="center">
  <a href="README.md">English</a> · <b>Português</b> · <a href="README.es.md">Español</a>
</p>

<p align="center">
  Um cliente desktop rápido, pensado para o teclado, para bancos SQL e Redis.<br />
  Feito com Rust e Tauri para Linux, Windows e macOS.
</p>

<p align="center">
  <img src="docs/screenshots/workspace.png" alt="Zanahoria com três databases abertas na barra lateral e uma grade de resultados" width="900" />
</p>

---

O Zanahoria permite conectar aos seus bancos, escrever e executar SQL com um
editor inteligente, navegar e editar resultados em uma grade e manter várias
databases abertas lado a lado. Foi pensado para tornar o trabalho diário com
dados de produção mais seguro e rápido: mudanças arriscadas passam por uma
etapa de revisão, toda edição roda em uma transação e quase tudo pode ser feito
pelo teclado.

**Engines suportadas:** PostgreSQL · MySQL · MariaDB · SQLite · Redis

## Destaques

- **Várias databases ao mesmo tempo.** Cada database aberta ganha sua própria
  entrada na barra lateral, com o nome dela. Pressione
  <kbd>Ctrl</kbd>+<kbd>K</kbd> para abrir outra database do mesmo servidor sem
  sair da que você está usando.
- **Safe Mode por conexão.** Marque as conexões de produção como *Safe Mode* e
  toda mudança feita pela grade é mostrada como SQL para revisão antes de
  rodar, é aplicada em uma única transação com verificação das linhas afetadas,
  e `UPDATE`/`DELETE` sem `WHERE` pedem confirmação.
- **Queries favoritas.** Salve as queries que você usa com frequência e
  reabra-as de qualquer conexão, já apontando para a database certa.
- **Visão dividida.** Trabalhe em duas queries da mesma aba lado a lado, cada
  uma com sua grade de resultados. Troque de painel no estilo tmux com
  <kbd>Ctrl</kbd>+<kbd>Space</kbd> e depois <kbd>←</kbd> / <kbd>→</kbd>.
- **Editor SQL inteligente.** Destaque de sintaxe, autocompletar com contexto
  (colunas das tabelas da instrução atual, aliases, tipos de coluna), destaque
  da instrução atual, buscar e substituir, e formatação.
- **Grade de resultados editável.** Navegue com as setas, edite células no
  lugar, adicione ou exclua linhas, carregue mais linhas sob demanda e exporte
  para CSV, XLSX (Excel, com números e datas tipados), JSON ou SQL.
- **Filtro de colunas.** Em resultados largos, clique em **Filtrar colunas** na
  barra acima da grade e digite parte do nome de um campo: só ficam visíveis
  as colunas cujo nome o contém (correspondência parcial, sem diferenciar
  maiúsculas, como `ILIKE '%texto%'`).
- **Ordenar e filtrar linhas.** Clique no cabeçalho de uma coluna para ordenar
  as linhas carregadas (crescente → decrescente → ordem original; NULLs por
  último). Clique em **Filtrar linhas** para ter uma caixa de filtro abaixo de
  cada cabeçalho: texto simples encontra as células que o contêm; `!texto` o
  exclui; `=x`, `!=x`, `>x`, `>=x`, `<x`, `<=x` comparam (numericamente quando
  os dois lados são números); `=null` / `!=null` encontram NULLs. Ambos
  funcionam sobre as linhas já carregadas, sem reexecutar a query.
- **Mover e redimensionar colunas.** Arraste o cabeçalho de uma coluna para
  movê-la; arraste a borda direita para mudar a largura (clique duplo na borda
  para restaurar). O layout vale só para o resultado atual e não é salvo.
- **Atalhos, temas e idiomas personalizáveis.** Troque qualquer atalho, escolha
  tema escuro ou claro e use o app em English, Português ou Español.
- **Backup e restauração.** Rode `pg_dump`/`pg_restore`/`mysqldump` pelo app,
  ou faça uma cópia consistente de SQLite sem ferramentas externas.

## Capturas de tela

### Conexões

Cada conexão mostra se o Safe Mode está ligado. Um ponto verde marca as
conexões abertas no momento.

<img src="docs/screenshots/connections.png" alt="Lista de conexões com os selos Safe Mode e Sem safe mode" width="900" />

### Revisão do Safe Mode

Mudanças feitas na grade em uma conexão com Safe Mode são mostradas como SQL
antes de qualquer coisa ser gravada.

<img src="docs/screenshots/safe-mode.png" alt="Diálogo de revisão listando as instruções UPDATE que vão rodar" width="900" />

### Visão dividida

Dois editores, duas grades de resultados independentes. O painel destacado é
aquele sobre o qual a barra de ferramentas e os atalhos atuam.

<img src="docs/screenshots/split.png" alt="Visão dividida com duas queries e duas grades de resultados" width="900" />

### Queries favoritas

<img src="docs/screenshots/favorites.png" alt="Lista de queries favoritas salvas de várias conexões" width="900" />

### Configurações e atalhos

<img src="docs/screenshots/settings.png" alt="Página de configurações com idioma, tema e atalhos de teclado" width="900" />

### Tema claro

<img src="docs/screenshots/light-theme.png" alt="Área de trabalho no tema claro" width="900" />

## Como usar

1. **Adicione uma conexão.** Na tela *Conexões* clique em
   **+ Nova conexão**, escolha a engine e preencha host, porta, usuário, senha
   e database (ou o arquivo, no SQLite). Use **Testar conexão** para conferir e
   ative o **Safe Mode** em qualquer database que você queira proteger.
2. **Conecte.** Clique em **Conectar**. A database abre na barra lateral à
   esquerda, com suas tabelas na árvore do schema.
3. **Faça queries.** Escreva SQL no editor e pressione
   <kbd>Ctrl</kbd>+<kbd>Enter</kbd> para rodar a seleção ou a instrução sob o
   cursor, ou <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> para rodar
   tudo. Clique duas vezes em uma tabela da árvore do schema para ver os dados.
4. **Edite dados.** Clique duas vezes em uma célula (ou selecione-a e pressione
   <kbd>Enter</kbd>), mude o valor e depois revise e confirme com
   <kbd>Ctrl</kbd>+<kbd>S</kbd>. Use **+ Linha** para inserir e **−** para
   excluir.
5. **Encontre uma coluna.** Clique em **Filtrar colunas** na barra entre o
   editor e os resultados e digite parte do nome do campo; <kbd>Esc</kbd> fecha
   o filtro e mostra todas as colunas de novo.
6. **Abra mais databases.** Pressione <kbd>Ctrl</kbd>+<kbd>K</kbd>, digite para
   filtrar e pressione <kbd>Enter</kbd>. Clique com o botão direito em uma
   entrada da barra lateral para fechá-la.
7. **Salve favoritas.** Clique em **★ Favorita** para salvar a query atual;
   encontre-a depois na estrela da barra lateral.

No macOS use <kbd>⌘</kbd> em vez de <kbd>Ctrl</kbd>.

## Atalhos de teclado

Todos os atalhos podem ser mudados em **Configurações → Atalhos de teclado**
(a engrenagem no fim da barra lateral, ou <kbd>Ctrl</kbd>+<kbd>,</kbd>). Estes
são os padrões:

| Ação | Atalho |
| --- | --- |
| Rodar seleção ou instrução atual | <kbd>Ctrl</kbd>+<kbd>Enter</kbd> |
| Rodar tudo no editor | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> |
| Reexecutar a última query | <kbd>Ctrl</kbd>+<kbd>R</kbd> / <kbd>F5</kbd> |
| Abrir outra database | <kbd>Ctrl</kbd>+<kbd>K</kbd> |
| Próxima / anterior database aberta | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>]</kbd> / <kbd>[</kbd> |
| Fechar e desconectar a database atual | <kbd>Ctrl</kbd>+<kbd>Esc</kbd> (ou <kbd>Ctrl</kbd>+<kbd>W</kbd> sem abas abertas) |
| Nova / fechar aba de query | <kbd>Ctrl</kbd>+<kbd>T</kbd> / <kbd>Ctrl</kbd>+<kbd>W</kbd> |
| Próxima / anterior aba de query | <kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> |
| Dividir / juntar o editor | <kbd>Ctrl</kbd>+<kbd>\\</kbd> |
| Focar painel esquerdo / direito | <kbd>Ctrl</kbd>+<kbd>Space</kbd> e depois <kbd>←</kbd> / <kbd>→</kbd> |
| Formatar SQL / compactar em uma linha | <kbd>Ctrl</kbd>+<kbd>I</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> |
| Comentar linha / bloco | <kbd>Ctrl</kbd>+<kbd>/</kbd> / <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>/</kbd> |
| Pré-visualizar / confirmar mudanças pendentes | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> / <kbd>Ctrl</kbd>+<kbd>S</kbd> |
| Tamanho da fonte do editor | <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd> / <kbd>Ctrl</kbd>+<kbd>0</kbd> |
| Ir para conexões / configurações | <kbd>Ctrl</kbd>+<kbd>N</kbd> / <kbd>Ctrl</kbd>+<kbd>,</kbd> |
| Sair | <kbd>Ctrl</kbd>+<kbd>Q</kbd> |

Na grade de resultados: as setas, <kbd>Tab</kbd>, <kbd>Home</kbd>/<kbd>End</kbd>
e <kbd>PgUp</kbd>/<kbd>PgDn</kbd> movem entre células, <kbd>Enter</kbd> ou
<kbd>F2</kbd> editam e <kbd>Ctrl</kbd>+<kbd>C</kbd> copia a célula.

## Instalação

Baixe a versão mais recente na [página de Releases](../../releases). Uma
release nova é publicada automaticamente a cada push na `main`.

### Linux

1. Baixe `Zanahoria_<versão>_amd64.AppImage`.
2. Torne-o executável e rode:

   ```bash
   chmod +x Zanahoria_*_amd64.AppImage
   ./Zanahoria_*_amd64.AppImage
   ```

### Windows

Baixe e execute `Zanahoria_<versão>_x64-setup.exe` (ou o `.msi`). Se o
SmartScreen avisar que o app não é reconhecido, clique em **Mais informações →
Executar assim mesmo**.

### macOS

1. Baixe `Zanahoria_<versão>_universal.dmg` (funciona em Macs com Apple Silicon
   e Intel).
2. Abra o `.dmg` e arraste o **Zanahoria** para **Aplicativos**.
3. O app não é assinado com um certificado de Apple Developer, então na
   primeira vez o macOS vai bloqueá-lo ("Zanahoria está danificado" ou "não
   pode ser aberto"). Libere-o uma vez, de uma destas formas:
   - Abra o **Terminal** e rode:

     ```bash
     xattr -cr /Applications/Zanahoria.app
     ```

   - Ou tente abrir o app, depois vá em **Ajustes do Sistema → Privacidade e
     Segurança** e clique em **Abrir Mesmo Assim**.

Depois disso ele abre normalmente.

### Atualizações

No Linux e no Windows, ao iniciar, o Zanahoria consulta a última release do
GitHub e, se houver uma mais nova, pergunta antes de instalá-la. A AppImage se
substitui e reinicia; no Windows o instalador roda em modo passivo.

No macOS o app ainda não se atualiza sozinho: baixe o `.dmg` novo, substitua o
app em **Aplicativos** e repita o passo do `xattr`.

## Compilando a partir do código

Requisitos:

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 22 ou mais novo e [pnpm](https://pnpm.io) 11
- Os [pré-requisitos do Tauri](https://v2.tauri.app/start/prerequisites/) para
  a sua plataforma (no Debian/Ubuntu: `libwebkit2gtk-4.1-dev`,
  `libappindicator3-dev`, `librsvg2-dev`, `patchelf`)

```bash
pnpm install
pnpm tauri dev     # roda em modo de desenvolvimento
pnpm tauri build   # gera os instaladores em src-tauri/target/release/bundle
```

O script `./dev.sh` faz o mesmo, e `./dev.sh --db` também sobe bancos de teste
locais de PostgreSQL, MySQL, MariaDB e Redis com Docker Compose.

### Testes

```bash
pnpm test                                   # testes unitários do frontend
cargo test --manifest-path src-tauri/Cargo.toml --workspace
```

Os testes de integração rodam contra os bancos do Docker Compose quando as
variáveis de ambiente `ZANAHORIA_TEST_PG`, `ZANAHORIA_TEST_MYSQL`,
`ZANAHORIA_TEST_MARIADB` e `ZANAHORIA_TEST_REDIS` estão definidas (veja
`.github/workflows/build.yml`).

## Estrutura do projeto

```
src/                 Frontend React + TypeScript (editor, grade, configurações, i18n)
src-tauri/           Aplicação Tauri (comandos expostos ao frontend)
src-tauri/crates/
  db-core/           Engines de banco, execução de queries, schema, mutações
  app-store/         Armazenamento local: conexões, histórico, favoritas, configurações
  backup/            Jobs de backup e restauração (pg_dump, mysqldump, …)
```

As senhas nunca vão para o banco do app: ficam guardadas no cofre de
credenciais do sistema operacional (Secret Service, Gerenciador de Credenciais
do Windows ou Keychain do macOS), com um arquivo criptografado como alternativa
quando não há cofre disponível.
