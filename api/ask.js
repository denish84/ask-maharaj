export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { message } = req.body;

  const response = await fetch('https://api.straico.com/v1/prompt/completion', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.STRAICO_KEY  // ← from env, never client
    },
    body: JSON.stringify({
      models: ['deepseek/deepseek-chat-v3-0324'],
      message
    })
  });

  const data = await response.json();
  res.status(200).json(data);
}
