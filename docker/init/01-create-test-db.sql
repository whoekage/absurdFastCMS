-- Runs once on first container init (empty data dir). POSTGRES_DB already created
-- absurd_dev; here we add the isolated test database so .env.test never touches dev data.
CREATE DATABASE absurd_test;
