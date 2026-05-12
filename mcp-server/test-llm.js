require('dotenv').config();
const axios = require('axios');
axios.post('https://api.groq.com/openai/v1/chat/completions', {
  model: 'llama-3.3-70b-versatile',
  messages: [{ role:'user', content:'Reply only with this exact JSON: {"status":"ok"}' }],
  max_tokens: 50
}, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
  'Content-Type': 'application/json' } })
.then(r => console.log('✅ Groq works:', r.data.choices[0].message.content))
.catch(e => console.log('❌ Groq error:', e.response?.status, e.response?.data));