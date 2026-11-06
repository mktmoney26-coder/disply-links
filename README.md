# Disply Links

Links de campanha com prévia clicável no WhatsApp e contagem de cliques.

Cada link (ex.: `https://SEU-PROJETO.vercel.app/teste`):
1. mostra no WhatsApp um cartão com imagem, título e descrição;
2. registra o clique (só cliques de pessoas; a busca da prévia não conta);
3. leva todo mundo para o mesmo destino.

## Arquivos
| Arquivo | O que faz |
|---|---|
| `links.json` | Lista dos links: título, descrição, imagem e destino de cada um |
| `public/img/` | Imagens das prévias (ideal: 1200×630 px) |
| `api/go.js` | Página de cada link: prévia, registro do clique e redirecionamento |
| `api/stats.js` | Relatório de cliques (protegido por senha) |
| `public/painel.html` | Painel para ver os cliques (`/painel`) |
| `lib/db.js` | Conexão com o banco; cria a tabela sozinho |

## Colocar no ar (uma vez só)

1. **GitHub** – crie um repositório chamado `disply-links` (pode ser privado).
   Na página do repositório, clique em **uploading an existing file**, arraste
   **todo o conteúdo desta pasta** (incluindo as pastas `api`, `lib` e `public`)
   e clique em **Commit changes**.
2. **Vercel** – **Add New → Project**, escolha o repositório `disply-links` e clique em **Deploy**.
3. **Banco de dados** – no projeto da Vercel, aba **Storage → Create Database → Neon (Postgres)**,
   crie no plano gratuito e conecte ao projeto `disply-links`.
4. **Senha do painel** – em **Settings → Environment Variables**, crie `STATS_KEY`
   com uma senha forte.
5. Em **Deployments**, clique nos três pontinhos do último deploy → **Redeploy**
   (para o projeto enxergar o banco e a senha).

## Testar
- Abra `https://SEU-PROJETO.vercel.app/teste` → deve redirecionar para o destino.
- Abra `https://SEU-PROJETO.vercel.app/painel`, digite a senha → o clique aparece.
- Para saber **quem** clicou, use um código no final: `/teste?c=CODIGO_DO_CONTATO`.

## Painel de links (jeito recomendado)
Abra `https://disply-links.vercel.app/painel` e entre com a senha (`STATS_KEY`).

- **+ Novo link**: cole a URL de destino e, se quiser, uma imagem. O painel gera o link
  (ex.: `/hzvccf`) e já ajusta a imagem para 1200×630.
- **Editar**: troca destino, imagem ou identificação, ou pausa o link (pausado = página não encontrada).
- **Ver cliques**: total e lista de contatos que clicaram (links com `?c=CODIGO`).

No template, use o botão de URL dinâmica `https://disply-links.vercel.app/{{1}}`
e, em cada disparo, preencha `{{1}}` com o código do link.

## Domínios separados por BM
Cada BM usa o seu próprio projeto na Vercel (e o seu próprio endereço). O painel e o banco
continuam únicos, no projeto principal (`disply-links`).

- Um link criado para um domínio **só abre nele**: nos outros domínios ele não existe.
- O painel (`/painel`) e a API só funcionam no projeto que tem a variável `STATS_KEY`.
  Não crie `STATS_KEY` nos projetos das BMs.
- Nos domínios das BMs não aparece nada que ligue o endereço à Disply.

### Adicionar uma BM nova automaticamente (recomendado)
No painel, em **Domínios → + Nova BM automática**, digite o nome do projeto e o cliente e clique
em **Criar BM**. Em cerca de 1 minuto o sistema cria o projeto na Vercel, conecta o banco,
publica e cadastra o domínio.

Configuração (uma vez só):
1. Na Vercel: foto do perfil → **Account Settings → Tokens → Create Token**.
   Nome: `disply-painel` · Escopo: o time **MKT MONEY** · Validade: a que preferir. Copie o token.
2. No projeto **disply-links** (o principal): **Settings → Environment Variables → Add**.
   Key `VERCEL_TOKEN`, Value = o token, ambiente **Production**, marque **Sensitive**. Salve.
3. **Deployments → ⋯ → Redeploy**.

Nunca crie `VERCEL_TOKEN` nem `STATS_KEY` nos projetos das BMs.

### Adicionar uma BM nova manualmente
1. **Vercel → Add New → Project** → importe o mesmo repositório `disply-links`.
   Dê um nome que **não** tenha "disply" (ex.: `aurora-ofertas`). O endereço será `aurora-ofertas.vercel.app`.
2. Clique em **Deploy**.
3. No projeto novo: **Storage → Connect Database** → escolha o banco Neon que já existe → **Connect**.
4. **Deployments → ⋯ → Redeploy**.
5. No painel principal, em **Domínios**, adicione `aurora-ofertas.vercel.app` com o nome da BM.

Depois é só criar os links escolhendo esse domínio. No template dessa BM, o botão fica
`https://aurora-ofertas.vercel.app/{{1}}`.

Observação: a cada atualização do código, todos os projetos publicam de novo. O plano
gratuito permite até 100 deploys por dia, o que é suficiente para dezenas de BMs.

## Links antigos (arquivo links.json)
Os links do arquivo continuam funcionando. Para novos, prefira o painel.

### Criar um link pelo arquivo (opcional)
No GitHub, edite `links.json` e adicione um bloco (o nome do link só pode ter letras minúsculas, números e hífen):

```json
"bf-aurora": {
  "title": "Black Friday Loja Aurora",
  "description": "Até 50% OFF em toda a loja",
  "image": "/img/bf-aurora.jpg",
  "destination": "https://lojaaurora.com.br/black-friday"
}
```

`title` e `description` são opcionais: sem eles, a prévia mostra só a imagem e o domínio.

Suba a imagem em `public/img/` e faça o commit. A Vercel publica sozinha em segundos.
O destino precisa começar com `https://`.

Regra de ouro: a prévia mostra a oferta real e todo mundo vai para o mesmo destino.

## Módulo de disparos (/disparos)
Página no projeto principal: `https://disply-links.vercel.app/disparos` (mesma senha do painel).

- **Instâncias:** conecte um número pela API oficial (WABA ID + token permanente). O token fica criptografado.
- **Templates:** sincronizados da Meta. Criação e aprovação continuam no WhatsApp Manager.
- **Listas:** CSV ou Excel com colunas de nome e telefone. Duplicados e inválidos são ignorados.
- **Operações:** instância → template → mídia → variáveis com `{nome}` / `{primeiro_nome}` → lista → teste → iniciar.
  Acompanhe enviadas, entregues, lidas e falhas; pause, retome, cancele e exporte as falhas.
- **Inbox:** conversas de todos os números, com o template que a pessoa recebeu e as respostas.
  Dá para responder em até 24h depois da última mensagem do cliente (regra da Meta).
- **SAIR:** quem responder SAIR (ou PARAR, STOP…) é bloqueado em todas as listas.

### Webhook (para entregue/lido, respostas e SAIR)
Em **Instâncias** aparecem a URL de callback e o token de verificação. Cole os dois no app da Meta
(WhatsApp → Configuração → Webhook), assine o campo `messages` e publique o app.
Depois clique em **Assinar webhook** na instância.

Limites desta versão: uma instância por operação; vídeo e documento só por link público;
templates de carrossel ainda não são suportados; no Inbox, imagens e áudios recebidos aparecem
como descrição (sem abrir o arquivo).
