// Política de privacidade pública (exigida pela Meta para publicar os apps do WhatsApp).
// Só existe no projeto principal.
module.exports = (req, res) => {
  if (!process.env.STATS_KEY) { res.status(404).end('Página não encontrada.'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de Privacidade · Disply</title>
<style>body{margin:0;background:#f4f7fb;color:#0D1B2A;font-family:-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;line-height:1.6}
main{max-width:760px;margin:0 auto;padding:40px 20px 60px}h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 6px}p,li{color:#24364a}
.bar{height:4px;background:linear-gradient(120deg,#00D4A3,#007BFF)}</style></head><body><div class="bar"></div><main>
<h1>Política de Privacidade</h1><p style="color:#5b6b80">Disply · Última atualização: 10/11/2026</p>
<p>Esta política explica como a Disply trata dados pessoais ao enviar e receber mensagens pelo WhatsApp Business Platform (API oficial da Meta) em nome das empresas clientes.</p>
<h2>1. Quem somos</h2>
<p>A Disply é uma agência que opera o envio de mensagens do WhatsApp para empresas. Em relação aos contatos dessas empresas, a Disply atua como operadora de dados, seguindo as instruções da empresa cliente, que é a controladora (Lei nº 13.709/2018 – LGPD).</p>
<h2>2. Dados tratados</h2>
<ul><li>Nome e número de telefone dos contatos enviados pela empresa cliente;</li>
<li>Status das mensagens (enviada, entregue, lida) e respostas recebidas pelo WhatsApp;</li>
<li>Pedidos para não receber mais mensagens (por exemplo, "SAIR");</li>
<li>Cliques em links enviados nas mensagens, quando houver.</li></ul>
<h2>3. Para que usamos</h2>
<p>Exclusivamente para enviar as mensagens solicitadas pela empresa cliente, acompanhar a entrega, responder aos contatos, respeitar pedidos de descadastro e gerar relatórios de resultado para a empresa cliente.</p>
<h2>4. Compartilhamento</h2>
<p>Os dados são processados pela Meta (WhatsApp) para a entrega das mensagens e armazenados em provedores de infraestrutura em nuvem. Não vendemos nem compartilhamos dados pessoais com terceiros para outras finalidades.</p>
<h2>5. Armazenamento e segurança</h2>
<p>Os dados ficam em servidores protegidos, com acesso restrito e credenciais criptografadas. Mantemos os dados pelo tempo necessário para a prestação do serviço e para obrigações legais, ou até a empresa cliente solicitar a exclusão.</p>
<h2>6. Seus direitos</h2>
<p>Você pode pedir para não receber mais mensagens respondendo "SAIR" a qualquer mensagem. Também pode solicitar acesso, correção ou exclusão dos seus dados à empresa que enviou a mensagem ou à Disply, pelos canais oficiais de atendimento.</p>
<h2>7. Exclusão de dados</h2>
<p>Para pedir a exclusão dos seus dados, responda "SAIR" e solicite a exclusão na mesma conversa, ou entre em contato com a empresa que enviou a mensagem. O pedido é atendido em até 15 dias.</p>
</main></body></html>`);
};
