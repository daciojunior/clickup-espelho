# Instalador Clinical Frontier para Obsidian

Instala o Obsidian (se faltar), cria um cofre local e deixa prontos os plugins:

- **ClickUp Espelho**: espelha os cards do ClickUp como notas, nos dois sentidos.
- **Iconic**: ícones e cores das pastas e notas.
- **Editing Toolbar**: barra de formatação.
- **BRAT**: busca versões novas do ClickUp Espelho.

## Antes de começar

Tenha em mãos o **seu** token do ClickUp: no ClickUp, avatar → Settings → Apps → API Token (começa com `pk_`).

## Windows

1. Extraia o zip.
2. Duplo clique em `Instalar-Windows.bat`.
3. Responda as duas perguntas (pasta do cofre e token).

## Mac

1. Extraia o zip (duplo clique nele).
2. Duplo clique em `Instalar-Mac.command`. Abre uma janela preta com texto (o Terminal): é normal.
3. Responda as duas perguntas (pasta do cofre e token).

**Se o Mac disser que o arquivo "não pode ser aberto"** (ele faz isso com arquivos baixados da internet):

- clique no arquivo com o botão direito → **Abrir** → **Abrir**; ou
- vá em Ajustes do Sistema → Privacidade e Segurança, desça até o aviso sobre o `Instalar-Mac.command` e clique em **Abrir Mesmo Assim**.

**Se ainda assim não abrir**, use o caminho que sempre funciona:

1. Abra o programa **Terminal** (aperte Command + Espaço, digite `Terminal`, Enter).
2. Digite `bash` e um espaço. Não aperte Enter ainda.
3. Arraste o arquivo `Instalar-Mac.command` para dentro da janela do Terminal e solte.
4. Aperte Enter.

## Depois de instalar (igual nos dois)

1. O Obsidian abre no cofre novo e pergunta se você confia nos plugins: escolha **Confiar no autor e ativar plugins**. Esse clique é uma trava de segurança do Obsidian e não pode ser automatizado.
2. Em até 1 minuto aparecem as pastas `Working` e `Desenvolvimento` com os cards.

## Atualizações (BRAT)

O BRAT confere, cada vez que o Obsidian abre, se há versão nova do ClickUp Espelho e a instala sozinho. Quando isso acontecer, aparece um aviso pedindo para recarregar o Obsidian: clique nele.

## Cuidados

- Use uma pasta **local** para o cofre, fora de Google Drive, OneDrive, iCloud ou Dropbox. Cada máquina tem o próprio cofre; a sincronização acontece pelo ClickUp.
- Apagar uma nota **arquiva** o card no ClickUp, para todos.
- Rodar o instalador de novo é seguro: ele atualiza os plugins e mantém as configurações que já existem.
- Se houver um arquivo `Clickup.env` ao lado do instalador (linha `CLICKUP_TOKEN=pk_...`), o token é lido dele em vez de perguntado. Não distribua esse arquivo: quem o tiver age no ClickUp em nome do dono do token.
