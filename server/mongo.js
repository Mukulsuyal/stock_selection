// server/mongo.js
// MongoDB connection - used by the whole app (auth, watchlist, alerts,
// journal, institutional money-flow). SQLite has been fully retired.

const mongoose = require('mongoose');

let connected = false;
let connecting = null;

async function connectMongo() {
  if (connected) return mongoose.connection;
  if (connecting) return connecting;
  const url = process.env.MONGODB_URL;
  if (!url) {
    console.warn('[mongo] MONGODB_URL not set - institutional money-flow feature is disabled.');
    return null;
  }
  connecting = mongoose.connect(url, { serverSelectionTimeoutMS: 10000 })
    .then((conn) => {
      connected = true;
      console.log('[mongo] connected to', conn.connection.name);
      return conn.connection;
    })
    .catch((err) => {
      console.error('[mongo] connection failed:', err.message);
      connecting = null;
      throw err;
    });
  return connecting;
}

function isMongoConfigured() {
  return Boolean(process.env.MONGODB_URL);
}

module.exports = { connectMongo, isMongoConfigured };
