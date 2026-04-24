// This file has OBVIOUS bugs for testing

// BUG 1: SQL Injection - CRITICAL
function getUserData(id) {
  const query = "SELECT * FROM users WHERE user_id = " + id;
  return database.executeQuery(query);
}

// BUG 2: Hardcoded API Key - CRITICAL  
const API_KEY = "sk-abc123defghijk456789";

// BUG 3: No input validation - CRITICAL
function processPayment(amount) {
  return chargeCard(amount); // No validation
}

module.exports = { getUserData, processPayment };
