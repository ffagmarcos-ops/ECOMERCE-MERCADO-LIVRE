# 🛍️ Tudo pra Você — Vitrine Digital & Painel de Afiliados (Mercado Livre)

Uma vitrine digital de altíssimo padrão, moderna e 100% dinâmica, projetada para a divulgação de "achadinhos" e produtos de afiliados do **Mercado Livre**. O projeto conta com um painel administrativo visual avançado e está totalmente pré-configurado com a base de dados de **51 produtos premium** vinculados à conta de afiliada da Vanessa Parvati.

---

## 💎 Design & Identidade Visual Premium

O portal foi desenvolvido sob uma estética moderna, limpa e extremamente sofisticada, inspirada em grandes portais de e-commerce e estilo de vida de luxo:
* **Paleta de Cores Curada:** Baseada em tonalidades harmoniosas de **Rosa (Soft Pink, Blush) e Ouro**, ideal para nichos de casa, organização, beleza e utilidades domésticas.
* **Tipografia Elegante:** Integração direta com a família de fontes **Outfit** via Google Fonts, conferindo legibilidade e ar contemporâneo à marca.
* **Micro-animações e Efeitos Suaves:** Efeitos de zoom sob hover nos cards, transições suaves em abas, carrossel widescreen dinâmico e botões interativos com feedbacks visuais ricos.
* **Visual Sem Interrupções:** Um script de pré-renderização IIFE no cabeçalho garante que as customizações de cores da marca e logomarca salvas no painel administrativo sejam carregadas instantaneamente na inicialização da página, eliminando qualquer flash visual de estilos desconfigurados (*Flicker-free*).

---

## 🌟 Funcionalidades de Destaque

### 1. 🔄 Vitrine Dinâmica & Sincronização Dinâmica (Single Source of Truth)
* A vitrine de `index.html` carrega **100% de seus produtos e dados** de forma dinâmica a partir do banco de dados persistido localmente no `localStorage` sob a chave `admin-custom-products`.
* Caso o banco local esteja vazio ou contenha a base de dados desatualizada de 16 itens, uma rotina automática inteligente de **Auto-Hidratação/Migração** entra em ação e carrega instantaneamente todos os **51 produtos premium** no navegador do cliente, sem requerer ações manuais do usuário.

### 2. 🔑 Rastreamento e Comissões de Afiliada Garantidos
* Todos os 51 produtos vêm nativamente pré-configurados com os parâmetros oficiais de afiliada da Vanessa:
  `?matt_tool=80930673&matt_word=vanessaparvati&forceInApp=true`
* Qualquer clique no botão "Gostei, quero ver!" de um produto direciona o comprador para o aplicativo ou site do Mercado Livre, registrando a comissão de afiliada automaticamente.

### 3. 🎨 Painel Administrativo Visual Completo (`admin.html`)
* **Gerenciamento de Marca:** Customização dinâmica da Logomarca (carregando imagens locais ou links externos) e alteração em tempo real da paleta de cores (Rosa Primário, Rosa Secundário, Soft Pink e Ouro).
* **Controle de Carrossel & Banners:** Permite alterar as imagens, títulos, subtítulos, badges e links de redirecionamento de cada slide do carrossel principal da vitrine.
* **Tabela Geral e Edição Reativa:** Exibe a tabela contendo todos os produtos ativos. Clicar no botão **Editar (lápis azul)** abre os dados do produto no formulário, ativa o modo de edição reativo de forma fluida (atualizando botões e títulos da tela) e permite salvar modificações de fotos, preços, emojis e links customizados.

### 4. 🔓 Bypass de Bloqueios do Mercado Livre (HTML Parser Local)
* Para driblar os bloqueios de CORS, proxies e restrições de rede impostas pelo CloudFront do Mercado Livre ao tentar consultar links encurtados ou produtos via AJAX, criamos o **Bypass de Código Fonte**.
* O administrador simplesmente cola o Código Fonte HTML da página do produto (copiado facilmente via Ctrl+U no PC) no campo do formulário.
* Um analisador Regex cliente-side processa o HTML em milissegundos dentro do navegador, extraindo os dados estruturados de **JSON-LD (application/ld+json)** e tags **OpenGraph (og:title, og:image)**. Ele autocompleta instantaneamente o Título, Preço, Categoria, Emoji e Imagem do item no formulário para salvamento, de forma 100% segura e sem realizar conexões de rede externas.

### 5. 🔍 Mecanismo de Busca Inteligente
* Reconstruído para ser insensível a acentos/diacríticos e totalmente flexível. Suporta pesquisas com múltiplas palavras fora de ordem (lógica AND), facilitando a localização de qualquer produto de forma instantânea (ex: digitar "cafe rosa" ou "organiza" retorna os itens correspondentes com perfeição).

---

## 📂 Estrutura do Projeto

* `index.html`: Portal público e vitrine dinâmica para o consumidor final.
* `admin.html`: Painel administrativo completo para gestão visual de banners, cores e banco de dados de produtos.
* `images/`: Pasta reservada para os banners widescreen estáticos otimizados do carrossel e assets visuais.
* `README.md`: Este guia completo sobre as características e uso do projeto.

---

## 🛠️ Tecnologias Utilizadas

1. **Estrutura e Marcação:** HTML5 Semântico e robusto.
2. **Estilização e Responsividade:** CSS3 moderno estruturado sob variáveis customizadas (`:root var(--...)`) integradas ao sistema de re-estilização e responsividade premium (Mobile-First completo).
3. **Lógica e Persistência:** Vanilla Javascript puro ES6 (sem dependências pesadas, garantindo carregamento extremamente rápido) com persistência reativa local em `localStorage`.

---

## 🚀 Deploy no Portainer

O projeto agora inclui uma stack Docker pronta para Portainer:
* `Dockerfile`: gera a imagem do app Node/Express.
* `docker-compose.yml`: sobe a aplicação, um banco MariaDB dedicado e o phpMyAdmin.
* `.env.example`: referência opcional com os valores padrão do projeto.

### Domínios publicados
* `https://achadinhos.digmidia.com` aponta para a vitrine e o painel.
* `https://phpmyadmin.achadinhos.digmidia.com` aponta para o phpMyAdmin.

### Variáveis principais
* O stack já sobe pronta com os domínios `achadinhos.digmidia.com` e `phpmyadmin.achadinhos.digmidia.com`.
* O banco usa a senha padrão já embutida no compose para agilizar o deploy interno.
* A rede externa do proxy usada pelo stack é `traefik`.

### Observação de arquitetura
* O servidor foi ajustado para ler configuração de banco via ambiente e aguardar o MariaDB subir antes de inicializar a API.
* Em Portainer, importe o `docker-compose.yml` como Stack e confirme apenas que a rede externa `traefik` existe.
