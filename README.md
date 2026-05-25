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
