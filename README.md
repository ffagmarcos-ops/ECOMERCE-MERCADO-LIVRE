# 🛍️ Tudo pra Você

Vitrine digital e painel administrativo para catálogo de afiliados do Mercado Livre. O projeto roda com Node/Express + MariaDB e já vem preparado para deploy em Portainer com Traefik.

## Acesso rápido

### Painel administrativo
* URL: `https://achadinhos.digmidia.com/admin`
* Usuário padrão: `admin`
* Senha padrão: `admin123`

### Banco de dados
* Serviço: MariaDB
* Usuário: `root`
* Senha: `30mariafn@`

### phpMyAdmin
* URL: `https://phpmyadmin.achadinhos.digmidia.com`

## O que este projeto faz

O sistema entrega uma vitrine pública para os produtos e um painel interno para administrar catálogo, banners, estatísticas e configurações visuais. O conteúdo é persistido no banco e sincronizado com o front quando a aplicação sobe.

## Como ele funciona

### Vitrine pública
* O arquivo [index.html](index.html) renderiza a loja e consome os dados do backend.
* Os produtos são sincronizados com o banco e podem ser mantidos com dados padrão ou atualizados pelo painel.

### Painel administrativo
* O arquivo [admin.html](admin.html) contém o fluxo de login e a interface de gestão.
* O login padrão é validado no servidor e o usuário é criado automaticamente no boot da aplicação.
* Após logar, o administrador pode alterar produtos, banners, cores e configurações da vitrine.
* Banners podem ser adicionados ou removidos dinamicamente; imagens enviadas no painel são convertidas em Base64 e persistidas no MariaDB.

### Backend
* O arquivo [server.js](server.js) sobe a API, cria o banco se necessário, cria as tabelas e faz o seed inicial.
* Também existe um endpoint de saúde em `/health` para monitoramento.

### API e tokens

* Swagger UI: `/api-docs`; especificação OpenAPI: `/api-docs/openapi.json`.
* Após entrar no painel, use a aba **Tokens de API** para criar ou revogar tokens Bearer. O segredo é exibido somente uma vez; tokens novos expiram em 90 dias por padrão.
* Operações administrativas exigem o cabeçalho `Authorization: Bearer <token>`. Leituras públicas da vitrine permanecem abertas.
* Execute `npm run validate:api` para validar o OpenAPI e confirmar que todas as rotas Express estão documentadas.

### Divulgação de ofertas no Telegram

Na aba **Marketing → Telegram: Ofertas**, é possível cadastrar vários canais, associar um template a cada canal e agendar ofertas aprovadas na curadoria.

1. No Telegram, abra o `@BotFather`, envie `/newbot` e copie o token criado.
2. Adicione o bot como administrador do canal, com permissão para publicar mensagens.
3. Publique uma mensagem de teste no canal e consulte `https://api.telegram.org/botSEU_TOKEN/getUpdates` para obter o `chat.id`.
4. Cadastre o nome, o Chat ID e o token no painel e clique em **Testar**.
5. Crie um template para o canal. Os campos disponíveis são `{title}`, `{price}`, `{old_price}`, `{discount}`, `{discount_line}` e `{affiliate_url}`.
6. Selecione ofertas aprovadas, o canal, o template e a data para criar o agendamento.

Os tokens dos bots são armazenados criptografados. O bot precisa permanecer administrador do canal para que o worker de publicação consiga enviar as ofertas. O WhatsApp será integrado em uma etapa separada.

## Funcionalidades principais

* Catálogo dinâmico com produtos premium.
* Painel visual para edição de produtos e identidade da loja.
* Sincronização com banco MariaDB.
* Login administrativo persistido no banco.
* Preparado para Portainer com Traefik e phpMyAdmin.

## Estrutura do projeto

* [index.html](index.html): vitrine pública.
* [admin.html](admin.html): painel administrativo.
* [server.js](server.js): backend, API e inicialização do banco.
* [docker-compose.yml](docker-compose.yml): stack do Portainer.
* [Dockerfile](Dockerfile): imagem do app.
* [.env.example](.env.example): valores padrão de referência.
* [images/](images/): assets visuais do projeto.

## Deploy no Portainer

### Stack incluída
* App Node/Express na URL `achadinhos.digmidia.com`.
* MariaDB interno com dados persistidos em volume.
* phpMyAdmin na URL `phpmyadmin.achadinhos.digmidia.com`.
* Rede externa padrão: `traefik`.

### Passo rápido
1. Suba a stack usando o arquivo [docker-compose.yml](docker-compose.yml).
2. Confirme que a rede externa `traefik` existe no servidor.
3. Acesse o painel em `https://achadinhos.digmidia.com/admin`.
4. Entre com `admin / admin123`.

## Tecnologias utilizadas

* HTML5, CSS3 e JavaScript puro.
* Node.js com Express.
* MariaDB com `mysql2`.
* Docker e Portainer.

## Observações

* O usuário admin padrão é criado automaticamente no boot da aplicação.
* As credenciais do banco também ficam prontas para uso no deploy interno.
* Se quiser mudar credenciais ou domínio, ajuste o compose e os arquivos de referência do projeto.
