require('dotenv').config();

console.log('✅ GitHub Token:', process.env.GITHUB_TOKEN ? 'Loaded' : '❌ Missing');
console.log('✅ Claude API Key:', process.env.CLAUDE_API_KEY ? 'Loaded' : '❌ Missing');

if (process.env.GITHUB_TOKEN && process.env.CLAUDE_API_KEY) {
  console.log('\n🎉 Setup completato! Procedi con il codice.');
} else {
  console.log('\n❌ Riempi .env con i tuoi token');
}
