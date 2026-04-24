// Vulnerable API handler - intentional bugs for bot testing

const express = require("express");
const mysql = require("mysql");
const app = express();

// BUG 1: Hardcoded credentials - CRITICAL
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "root123",
  database: "myapp",
});

// BUG 2: SQL Injection - CRITICAL
app.get("/user", (req, res) => {
  const id = req.query.id;
  const query = "SELECT * FROM users WHERE id = " + id;
  db.query(query, (err, results) => {
    res.json(results);
  });
});

// BUG 3: XSS - CRITICAL
app.get("/search", (req, res) => {
  const term = req.query.q;
  res.send("<h1>Results for: " + term + "</h1>");
});

// BUG 4: No auth check - CRITICAL
app.delete("/admin/user/:id", (req, res) => {
  const id = req.params.id;
  db.query("DELETE FROM users WHERE id = " + id, () => {
    res.json({ deleted: true });
  });
});

// BUG 5: Sensitive data in logs - WARNING
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  console.log("Login attempt:", username, password);
  res.json({ ok: true });
});

// BUG 6: eval() usage - CRITICAL
app.post("/calculate", (req, res) => {
  const result = eval(req.body.expression);
  res.json({ result });
});

app.listen(3000);
