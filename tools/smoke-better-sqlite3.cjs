"use strict";

const Database = require("better-sqlite3");
const database = new Database(":memory:");

try {
  const row = database.prepare("SELECT 42 AS value").get();
  if (row?.value !== 42) {
    throw new Error("better-sqlite3 query smoke returned an unexpected value");
  }
} finally {
  database.close();
}
