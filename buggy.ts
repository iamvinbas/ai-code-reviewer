// BUG 1: any type kills type safety
function processData(data: any) {
    return data.value * 2;
}

// BUG 2: no null check
interface User {
    name: string;
    address?: { city: string };
}
function getCity(user: User): string {
    return user.address.city; // address could be undefined
}

// BUG 3: hardcoded API key
const API_KEY = "sk-prod-abc123xyz";

// BUG 4: eval on user input
function calculate(expression: string): number {
    return eval(expression);
}

// BUG 5: async without await — returns Promise<void> silently
function saveUser(user: User) {
    fetch("/api/users", {
        method: "POST",
        body: JSON.stringify(user),
    });
}
