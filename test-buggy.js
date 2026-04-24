// Questo file ha bug intenzionali per testare il bot

// BUG 1: SQL Injection - CRITICAL
function getUserById(userId) {
  const query = "SELECT * FROM users WHERE id = " + userId;
  return database.query(query);
}

// BUG 2: Hardcoded credentials - CRITICAL
const API_KEY = "sk-1234567890abcdefghijk";
const PASSWORD = "admin123";

// BUG 3: Race condition - CRITICAL
let counter = 0;
function increment() {
  const temp = counter;
  setTimeout(() => {
    counter = temp + 1;
  }, 0);
}

// BUG 4: Memory leak - WARNING
const cache = [];
function addToCache(data) {
  cache.push(data);
  // Never cleared - memory leak
}

// BUG 5: Inefficient sorting - WARNING
function bubbleSort(arr) {
  for (let i = 0; i < arr.length; i++) {
    for (let j = 0; j < arr.length - 1; j++) {
      if (arr[j] > arr[j + 1]) {
        [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]];
      }
    }
  }
  return arr;
}

// BUG 6: Null pointer exception risk - WARNING
function processUser(user) {
  return user.name.toUpperCase(); // user could be null
}

// BUG 7: Console.log in production - SUGGESTION
console.log("Debug info");

// BUG 8: Poor variable naming - SUGGESTION
const x = 5;
const y = 10;
const z = x + y;

module.exports = {
  getUserById,
  increment,
  addToCache,
  bubbleSort,
  processUser
};
