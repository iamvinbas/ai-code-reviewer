import subprocess
import sqlite3

# BUG 1: SQL injection
def get_user(username):
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE username = '" + username + "'")
    return cursor.fetchone()

# BUG 2: Command injection
def ping_host(host):
    result = subprocess.run("ping -c 1 " + host, shell=True)
    return result

# BUG 3: Hardcoded secret
SECRET_KEY = "super_secret_123"
DB_PASSWORD = "root"

# BUG 4: Division by zero
def average(numbers):
    return sum(numbers) / len(numbers)

# BUG 5: Infinite loop risk
def find_item(items, target):
    i = 0
    while items[i] != target:
        i += 1
    return i
