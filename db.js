const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'postgres',
  user: process.env.PG_USER || 'gateway_user',
  password: process.env.PG_PASSWORD,
});

module.exports = pool;
