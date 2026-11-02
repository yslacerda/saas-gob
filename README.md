# Gov.Fake

Projeto web do Gov.Fake, responsivo para PC e mobile.

## Website

Para abrir a versao web:

```bash
cd website
npm install
copy .env.example .env.local
# Edite .env.local e preencha DATABASE_URL ou POSTGRES_URL com a connection string do Supabase.
node server.js
```

Depois acesse `http://localhost:3000`.

A tela web possui:

- `/auth`: cadastro e login.
- `/dashboard`: painel para acessar, criar e remover identidades.
- `/identidadefake`: visualizacao da identidade selecionada.

Os usuarios e identidades sao salvos em PostgreSQL/Supabase via `DATABASE_URL` ou `POSTGRES_URL`.
O arquivo `website/supabase-schema.sql` documenta o schema criado automaticamente no primeiro boot do servidor.

Cada conta possui `username` unico. O login aceita apenas usuario e senha.

Cada identidade fica vinculada ao `user_id` do dono. Usuarios comuns so consultam, criam e removem identidades proprias; contas com papel `admin` podem listar usuarios e gerenciar identidades de qualquer usuario. A primeira conta cadastrada vira admin automaticamente.

## Acesso pago por Pix

Novas contas comuns escolhem uma compra avulsa de acesso:

- 30 dias por R$ 39,99;
- 90 dias por R$ 59,99.

O pagamento usa o Checkout hospedado da Asaas e aceita somente Pix. Contas que ja existiam quando a migracao foi executada pela primeira vez recebem acesso permanente; administradores tambem nao passam pelo paywall.

Configure `APP_BASE_URL`, `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN`. Em Sandbox, mantenha `ASAAS_API_BASE_URL=https://api-sandbox.asaas.com/v3`; o checkout usara automaticamente `https://sandbox.asaas.com/checkoutSession/show`. Na Asaas, crie um webhook apontando para:

```text
https://SEU-DOMINIO/api/payments/asaas/webhook
```

Use em `authToken` exatamente o mesmo valor de `ASAAS_WEBHOOK_TOKEN` (com pelo menos 32 caracteres) e habilite os eventos `CHECKOUT_PAID`, `CHECKOUT_CANCELED` e `CHECKOUT_EXPIRED`. O acesso so e liberado por `CHECKOUT_PAID`; as URLs de retorno do navegador nao confirmam pagamento.

Antes de producao, altere `ASAAS_API_BASE_URL` para `https://api.asaas.com/v3`, use uma chave de producao e defina `APP_BASE_URL` com HTTPS publico.

O simulador usa sempre o QR fixo incluido no projeto e exibe um aviso permanente de que nao possui validade documental nem vinculo governamental.
