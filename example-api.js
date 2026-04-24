// Example API with intentional issues for testing

// Issue 1: SQL Injection
function getUserById(id) {
  const query = "SELECT * FROM users WHERE id = " + id;
  return database.query(query);
}

// Issue 2: Hardcoded Secret
const DATABASE_PASSWORD = "admin123";

// Issue 3: Debug code
console.log("Debug: API started");

module.exports = { getUserById };
