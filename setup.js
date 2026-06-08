require('dotenv').config();
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
  console.log('Created data directory');
}

if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'catsnip123') {
  console.log('WARNING: Change the default ADMIN_PASSWORD in .env before deploying.');
}

console.log('CatSnip setup complete. Run npm start to launch.');
