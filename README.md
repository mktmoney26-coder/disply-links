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

## Criar um link novo
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
