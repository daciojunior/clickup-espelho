# Instalador Clinical Frontier para Obsidian

Instala o Obsidian (se faltar), cria um cofre local e deixa prontos os plugins:

- **ClickUp Espelho**: espelha os cards do ClickUp como notas, nos dois sentidos.
- **Iconic**: ícones e cores das pastas e notas.
- **Editing Toolbar**: barra de formatação.
- **BRAT**: busca versões novas do ClickUp Espelho.

## Antes de começar

Tenha em mãos o **seu** token do ClickUp: no ClickUp, avatar → Settings → Apps → API Token (começa com `pk_`).

## Windows

1. **Extraia o zip**: botão direito nele → "Extrair tudo". Rodar o instalador de dentro do zip, sem extrair, não funciona.
2. Feche o Obsidian, se estiver aberto.
3. Na pasta extraída, duplo clique em `Instalar-Windows.bat`.
4. Responda as perguntas (pasta do cofre e token). Se a máquina já tem um cofre com o ClickUp Espelho, o instalador o encontra e sugere atualizar esse mesmo: basta apertar Enter.

## Mac

O macOS bloqueia programas baixados da internet que não foram registrados na Apple, e nas versões recentes o botão direito → Abrir não libera mais. Por isso a instalação é pelo Terminal (a janela de comandos do Mac). São 4 passos:

1. Extraia o zip (duplo clique nele).
2. Abra o **Terminal**: aperte Command + Espaço, digite `Terminal` e aperte Enter.
3. Digite `bash` e depois um espaço. Não aperte Enter ainda.
4. Arraste o arquivo `Instalar-Mac.command` para dentro da janela do Terminal, solte e aperte Enter.

Depois é só responder as duas perguntas (pasta do cofre e token).

**Alternativa sem Terminal:** dê duplo clique em `Instalar-Mac.command`, feche o aviso de bloqueio, vá em Ajustes do Sistema → Privacidade e Segurança, desça até a seção Segurança e clique em **Abrir Mesmo Assim** ao lado do nome do arquivo.

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
