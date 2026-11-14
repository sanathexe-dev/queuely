const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 4000;
const db = openDb();
const app = createApp(db);

app.listen(PORT, () => {
  console.log(`Queuely API running on http://localhost:${PORT}`);
});
