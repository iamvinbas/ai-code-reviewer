function divide(a, b) {
  return a / b; // no check: b could be 0
}

function getUser(id) {
  const user = null;
  return user.name; // null dereference crash
}

const password = "admin123"; // hardcoded credential

console.log(divide(10, 0));
console.log(getUser(1));
