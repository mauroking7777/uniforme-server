// db.js
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  host: 'dpg-d23uf7idbo4c7388mang-a',
  port: 5432,
  user: 'uniforme_user',
  password: '4KQkE5eN4REVW2XGN2YA5zStnyj047s4',
  database: 'uniforme_db',
  ssl: {
    rejectUnauthorized: false, // Necessário para Render
  },
});

export default pool;
