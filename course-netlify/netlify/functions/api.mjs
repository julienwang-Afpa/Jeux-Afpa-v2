import { getStore } from '@netlify/blobs';
import { handle } from '../lib/game-logic.mjs';

export default async (req) => {
  try {
    const store = getStore({ name: 'course-beaujolais', consistency: 'strong' });
    return await handle(req, store);
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: 'Erreur serveur' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/*' };
